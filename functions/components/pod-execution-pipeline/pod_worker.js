/**
 * pod_worker.js — ATC pod lifecycle state machine, driven against the external
 * vLLM controller (project ai-project-4e149, see pod_controller.js).
 *
 * Full cycle (single source of truth for pod state = classify/pod_worker):
 *   IDLE  --launchPod(config_id)-->  LOADING
 *   LOADING --pod /health 200 + getPodBearer--> READY (+ start Cloud Run drain Job)
 *   READY --drain empties queue--> (drain Job POSTs "drained") --terminatePod--> IDLE
 *   any --unhealthy / load timeout--> HALTED (terminatePod; human clears `halted`)
 *
 * Two schedulers move the machine forward:
 *   - atcPodLifecycle (every 2 min): IDLE→launch gate (batched), LOADING→ready poll.
 *   - the drain Job's "drained" push and "ready"/"unhealthy" pushes hit
 *     podWorkerUpdate below.
 *
 * Singleton: state≠IDLE blocks a 2nd pod; workerRunning blocks a 2nd worker.
 * Failure policy: requeue in-flight job + alert + HALT (no auto-recreate).
 */
"use strict";

const admin = require("firebase-admin");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { logger } = require("firebase-functions");
const cors = require("cors");

const { alertAtc } = require("../queue-required-stage-aiatc-creation/atc_alerts");
const { requeueJob, DEFAULT_COLLECTION } = require("./pod_jobs");
const { shouldStartPod } = require("../queue-required-stage-aiatc-creation/atc_helpers");
const { launchPod, getPodBearer, terminatePod, getPodStatus } = require("./pod_controller");

const corsHandler = cors({ origin: true });
const sharedSecret = defineSecret("FUNCTIONS_SHARED_SECRET");

const db = admin.firestore();
const atcDb = getFirestore("firestore-atc");

// Single merged doc: human-set config + machine-written runtime state.
const WORKER_DOC = "pod_worker";
const STATES = {
  IDLE: "IDLE",           // no pod
  LOADING: "LOADING",     // pod created via launchPod, model loading, polling /health
  READY: "READY",         // model ready, drain Job running
  TERMINATING: "TERMINATING",
  HALTED: "HALTED",       // failure — needs human reset (clear `halted`)
};

// Launch-gate + load-timeout defaults (overridable in the config doc).
const DEFAULT_MIN_JOBS = 20;
const DEFAULT_FLUSH_WAIT_MINUTES = 120;
const DEFAULT_LOAD_TIMEOUT_MINUTES = 30;

function workerRef() {
  return db.collection("classify").doc(WORKER_DOC);
}

async function loadWorker() {
  const snap = await workerRef().get();
  const d = snap.exists ? snap.data() : {};
  return { state: STATES.IDLE, ...d };
}

function toMillis(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === "function") return ts.toDate().getTime();
  if (typeof ts._seconds === "number") return ts._seconds * 1000;
  if (ts instanceof Date) return ts.getTime();
  return null;
}

// ── launchAndLoad ────────────────────────────────────────────────────────────
// IDLE → LOADING. Reserves the singleton slot, calls the controller's launchPod,
// then records {podid, apiUrl}. Soft controller errors (cooldown / one-pod lock)
// roll back to IDLE so the next tick can retry; hard errors HALT-adjacent alert.
async function launchAndLoad({ configId, cfg, collectionName }) {
  if (!configId) {
    await alertAtc("critical", "atcPodLifecycle: classify/pod_worker.CONFIG_ID not set — cannot launch.", {
      stage: "PodLifecycle", webhookUrl: cfg.SLACK_WEBHOOK_URL,
    });
    return { action: "no-config" };
  }

  const reserved = await db.runTransaction(async (tx) => {
    const d = (await tx.get(workerRef())).data() || {};
    if (d.state && d.state !== STATES.IDLE) return { skip: true, state: d.state };
    tx.set(workerRef(), {
      state: STATES.LOADING,
      configId,
      workerRunning: false,
      launchStartedAt: FieldValue.serverTimestamp(),
      lastUpdateAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { skip: false };
  });
  if (reserved.skip) return { action: "skip", reason: `state=${reserved.state}` };

  try {
    const pod = await launchPod(configId); // {pod_id, public_url, gpu_used}
    await workerRef().set({
      podid: pod.pod_id,
      apiUrl: pod.public_url,
      gpu: pod.gpu_used || null,
      launchedAt: FieldValue.serverTimestamp(),
      launchError: FieldValue.delete(),
      lastUpdateAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    await alertAtc("info", `Pod launched (${pod.pod_id}) for config ${configId} — model loading.`, {
      stage: "PodLifecycle", webhookUrl: cfg.SLACK_WEBHOOK_URL, extra: { gpu: pod.gpu_used },
    });
    logger.info("launchAndLoad: pod launched", { podid: pod.pod_id, configId });
    return { action: "launched", podid: pod.pod_id };
  } catch (e) {
    // Roll back the reservation so the gate can retry next tick.
    await workerRef().set({
      state: STATES.IDLE,
      launchError: e.message,
      lastUpdateAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    const soft = e.controllerStatus === "RESOURCE_EXHAUSTED" || e.controllerStatus === "FAILED_PRECONDITION";
    await alertAtc(soft ? "warn" : "critical", `launchPod failed (${e.controllerStatus || "?"}): ${e.message}`, {
      stage: "PodLifecycle", webhookUrl: cfg.SLACK_WEBHOOK_URL, extra: { configId },
    });
    return { action: "launch-failed", error: e.message, soft };
  }
}

// ── podHealthy ───────────────────────────────────────────────────────────────
// The controller exposes an unauthenticated /health readiness check at the pod's
// public_url once vLLM is up.
async function podHealthy(apiUrl) {
  if (!apiUrl) return false;
  try {
    const r = await fetch(`${apiUrl.replace(/\/+$/, "")}/health`, { signal: AbortSignal.timeout(10000) });
    return r.ok;
  } catch (_) {
    return false;
  }
}

// ── markReady ────────────────────────────────────────────────────────────────
// LOADING → READY. Decides what happens next:
//   no pending jobs   → terminate the pod (nothing to do)
//   worker running    → skip (only one worker)
//   else              → start the Cloud Run drain Job
// Returns {action: 'start-worker'|'terminate'|'skip'|'ignore', reason, pending}.
async function markReady({ podid, apiUrl, bearerToken, collectionName }) {
  const coll = collectionName || DEFAULT_COLLECTION;
  // pending count read outside the txn (count() can't run inside one)
  const cnt = await atcDb.collection(coll).where("status", "==", "pending").count().get();
  const pending = cnt.data().count;

  return db.runTransaction(async (tx) => {
    const ref = workerRef();
    const snap = await tx.get(ref);
    const d = snap.exists ? snap.data() : {};

    if (d.podid && podid && d.podid !== podid) {
      return { action: "ignore", reason: "stale podid" };
    }
    if (d.state !== STATES.LOADING) {
      return { action: "ignore", reason: `state=${d.state}` };
    }

    const patch = { lastUpdateAt: FieldValue.serverTimestamp() };
    if (apiUrl) patch.apiUrl = apiUrl;
    if (bearerToken) patch.bearerToken = bearerToken;

    if (d.workerRunning) {
      tx.set(ref, { ...patch, state: STATES.READY }, { merge: true });
      return { action: "skip", reason: "worker already running" };
    }
    if (pending === 0) {
      tx.set(ref, { ...patch, state: STATES.TERMINATING }, { merge: true });
      return { action: "terminate", reason: "no pending jobs", pending };
    }
    tx.set(ref, {
      ...patch,
      state: STATES.READY,
      workerRunning: true,
      workerStartedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { action: "start-worker", pending };
  });
}

// ── advanceToReady ───────────────────────────────────────────────────────────
// Fetch the inference bearer (getPodBearer), flip LOADING→READY, and either
// start the drain Job or terminate (no work). Shared by the lifecycle poll and
// the "ready" push.
async function advanceToReady({ podid, cfg, collectionName }) {
  let bearerToken;
  try {
    bearerToken = await getPodBearer(podid);
  } catch (e) {
    await alertAtc("warn", `getPodBearer failed for ${podid}: ${e.message} — will retry next tick.`, {
      stage: "PodLifecycle", webhookUrl: cfg.SLACK_WEBHOOK_URL,
    });
    return { action: "bearer-failed", error: e.message };
  }
  const decision = await markReady({ podid, apiUrl: cfg.apiUrl, bearerToken, collectionName });
  if (decision.action === "start-worker") {
    await triggerWorkerJob(cfg);
  } else if (decision.action === "terminate") {
    await terminateAndReset(cfg, podid, collectionName, STATES.IDLE);
  }
  return decision;
}

// ── markUnhealthy ────────────────────────────────────────────────────────────
// Any state → HALTED. Requeues the in-flight job (attempts-capped) and signals
// teardown. No auto-recreate — a human clears `halted` to resume.
async function markUnhealthy({ podid, reason, collectionName }) {
  const out = await db.runTransaction(async (tx) => {
    const ref = workerRef();
    const snap = await tx.get(ref);
    const d = snap.exists ? snap.data() : {};
    if (d.podid && podid && d.podid !== podid) {
      return { action: "ignore", reason: "stale podid" };
    }
    tx.set(ref, {
      state: STATES.HALTED,
      halted: true,
      haltedReason: reason || "unhealthy",
      workerRunning: false,
      lastUpdateAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { action: "terminate", currentJobPath: d.currentJobPath || null, podid: d.podid || podid };
  });

  if (out.currentJobPath) {
    await requeueJob({
      collectionName: collectionName || DEFAULT_COLLECTION,
      path: out.currentJobPath,
      reason: "pod unhealthy",
      podId: out.podid,
    });
  }
  return out;
}

// ── triggerWorkerJob — start the Cloud Run drain Job ─────────────────────────
// POSTs to the Cloud Run Jobs Admin API using the function runtime's own
// identity (metadata-server access token). The runtime SA needs run.jobs.run
// (Cloud Run Developer/Invoker) on the job. Config: WORKER_JOB_NAME,
// WORKER_REGION (default us-central1), WORKER_PROJECT (default this project).
async function triggerWorkerJob(cfg) {
  const jobName = cfg.WORKER_JOB_NAME;
  const region = cfg.WORKER_REGION || "us-central1";
  const project = cfg.WORKER_PROJECT || process.env.GCLOUD_PROJECT ||
    process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  if (!jobName) {
    logger.warn("triggerWorkerJob: WORKER_JOB_NAME not configured — worker NOT started");
    return { success: false, error: "WORKER_JOB_NAME not configured" };
  }
  if (!project) {
    logger.warn("triggerWorkerJob: project id unresolved — worker NOT started");
    return { success: false, error: "project id unresolved" };
  }
  try {
    const tokResp = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(10000) },
    );
    if (!tokResp.ok) throw new Error(`metadata token HTTP ${tokResp.status}`);
    const accessToken = (await tokResp.json()).access_token;

    const runResp = await fetch(
      `https://run.googleapis.com/v2/projects/${project}/locations/${region}/jobs/${jobName}:run`,
      {
        method: "POST",
        headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!runResp.ok) {
      const detail = await runResp.text().catch(() => "");
      logger.warn("triggerWorkerJob: run failed", { status: runResp.status, detail: detail.slice(0, 200) });
      return { success: false, status: runResp.status, error: detail.slice(0, 200) };
    }
    const ex = await runResp.json().catch(() => ({}));
    logger.info("triggerWorkerJob: drain Job started", { job: jobName, execution: ex.name || null });
    return { success: true, execution: ex.name || null };
  } catch (e) {
    logger.error("triggerWorkerJob: error", { error: e.message });
    return { success: false, error: e.message };
  }
}

// ── terminateAndReset — controller terminatePod, then clear runtime state ─────
// finalState = IDLE after a normal drain; = HALTED after a failure (preserves
// the halt set by markUnhealthy so the gate will NOT auto-relaunch).
async function terminateAndReset(cfg, podid, collectionName, finalState = STATES.IDLE) {
  if (podid) {
    try {
      const r = await terminatePod(podid); // {pod_id, cost_usd}
      logger.info("terminateAndReset: pod terminated", { podid, cost_usd: r && r.cost_usd });
    } catch (e) {
      // NOT_FOUND = already gone = idempotent success.
      if (e.controllerStatus !== "NOT_FOUND") {
        logger.warn("terminateAndReset: terminatePod failed", { error: e.message });
        return { success: false, error: e.message };
      }
    }
  } else {
    logger.warn("terminateAndReset: no podid — clearing state only");
  }
  await workerRef().set({
    state: finalState,
    podid: FieldValue.delete(),
    apiUrl: FieldValue.delete(),
    bearerToken: FieldValue.delete(),
    workerRunning: false,
    currentJobPath: FieldValue.delete(),
    lastUpdateAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { success: true };
}

// ── atcPodLifecycle — the state-machine clock ────────────────────────────────
// every 2 min: IDLE→launch gate (batched), LOADING→ready poll (+ load timeout).
exports.atcPodLifecycle = onSchedule(
  { schedule: "every 2 minutes", secrets: [sharedSecret] },
  async () => {
    const cfg = await loadWorker();
    const collectionName = cfg.FIREBASE_COLLECTION_NAME || DEFAULT_COLLECTION;
    const state = cfg.state || STATES.IDLE;

    // Arm switch: the whole lifecycle is a no-op until classify/pod_worker.enabled
    // === true. Lets you deploy + configure everything without auto-launching a
    // (costly) pod; flip enabled:true to go live. In-flight pods (LOADING/READY)
    // still advance so disabling never strands a running pod.
    if (cfg.enabled !== true && state === STATES.IDLE) {
      logger.info("atcPodLifecycle: disabled (set classify/pod_worker.enabled=true to arm)");
      return;
    }

    if (state === STATES.HALTED || state === STATES.TERMINATING) {
      logger.info("atcPodLifecycle: idle in non-advanceable state", { state });
      return;
    }

    if (state === STATES.READY) return; // drain Job owns this phase

    if (state === STATES.LOADING) {
      // Fast-fail on a bad boot: ask the controller for the DURABLE pod status
      // (Firestore pod_launches doc — survives termination). A failed self-report
      // (status=failed) or a controller-side crash/hang sweep (status=terminated
      // with reason "hung boot"/"gone on RunPod") means the pod will never become
      // ready, so HALT now with the real cause instead of waiting out the load
      // timeout. Soft: any controller/query error just falls through to the health
      // poll + load-timeout guard below (unchanged behaviour).
      try {
        const ps = await getPodStatus(cfg.podid);
        const crashed = ps && (ps.status === "failed" ||
          (ps.status === "terminated" &&
            ["hung boot", "gone on RunPod"].includes(ps.termination_reason)));
        if (crashed) {
          const why = ps.termination_reason || ps.failed_stage || `pod ${ps.status}`;
          await markUnhealthy({ podid: cfg.podid, reason: `pod deploy failed: ${why}`, collectionName });
          await terminateAndReset(cfg, cfg.podid, collectionName, STATES.HALTED);
          await alertAtc("critical", `Pod ${cfg.podid} deploy failed (${why}) — halted, manual reset needed.`, {
            stage: "PodLifecycle", webhookUrl: cfg.SLACK_WEBHOOK_URL,
          });
          return;
        }
      } catch (e) {
        logger.warn("atcPodLifecycle: getPodStatus check failed — falling back to health/timeout",
          { error: e.message, controllerStatus: e.controllerStatus });
      }

      // Load-timeout guard: a pod stuck loading past the window is halted.
      const startedMs = toMillis(cfg.launchedAt) || toMillis(cfg.launchStartedAt);
      const loadTimeout = Number(cfg.loadTimeoutMinutes ?? DEFAULT_LOAD_TIMEOUT_MINUTES);
      if (startedMs && (Date.now() - startedMs) / 60000 >= loadTimeout) {
        await markUnhealthy({ podid: cfg.podid, reason: `load timeout > ${loadTimeout}m`, collectionName });
        await terminateAndReset(cfg, cfg.podid, collectionName, STATES.HALTED);
        await alertAtc("critical", `Pod ${cfg.podid} did not become ready within ${loadTimeout}m — halted, manual reset needed.`, {
          stage: "PodLifecycle", webhookUrl: cfg.SLACK_WEBHOOK_URL,
        });
        return;
      }
      if (await podHealthy(cfg.apiUrl)) {
        await advanceToReady({ podid: cfg.podid, cfg, collectionName });
      } else {
        logger.info("atcPodLifecycle: pod still loading", { podid: cfg.podid });
      }
      return;
    }

    // state === IDLE → launch gate (batched, same rule as the old scheduler).
    const minJobs = Number(cfg.minJobsToStartPod ?? DEFAULT_MIN_JOBS);
    const flushWaitMinutes = Number(cfg.flushWaitMinutes ?? DEFAULT_FLUSH_WAIT_MINUTES);
    const pendingQuery = atcDb.collection(collectionName).where("status", "==", "pending");
    const pendingCount = (await pendingQuery.count().get()).data().count;
    if (pendingCount === 0) return;

    const oldest = await pendingQuery.orderBy("createdAt", "asc").limit(1).get();
    let oldestAgeMin = 0;
    if (!oldest.empty) {
      const ms = toMillis(oldest.docs[0].data().createdAt);
      if (ms) oldestAgeMin = (Date.now() - ms) / 60000;
    }
    if (!shouldStartPod({ pendingCount, oldestAgeMin, minJobs, flushWaitMinutes })) {
      logger.info("atcPodLifecycle: below launch threshold", { pendingCount, minJobs, oldestAgeMin });
      return;
    }
    logger.info("atcPodLifecycle: launching pod", { pendingCount, oldestAgeMin });
    await launchAndLoad({ configId: cfg.CONFIG_ID, cfg, collectionName });
  },
);

// ── podWorkerUpdate — the HTTP url for server-to-server lifecycle pushes ──────
// POST { podid, event: "ready"|"unhealthy"|"drained"|"info", detail? }
// Header: X-Api-Key: <FUNCTIONS_SHARED_SECRET>
//   ready    — (optional, if the controller webhook is wired here) fetch bearer,
//              go READY, start drain. The lifecycle poll does this anyway.
//   drained  — the drain Job finished the queue → terminate the pod.
//   unhealthy— requeue in-flight job, HALT, terminate.
exports.podWorkerUpdate = onRequest({ secrets: [sharedSecret] }, (req, res) => {
  corsHandler(req, res, async () => {
    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.get("X-Api-Key") !== sharedSecret.value()) {
      return res.status(401).json({ success: false, error: "unauthorized" });
    }
    try {
      const { podid, event, detail } = req.body || {};
      if (!podid) return res.status(400).json({ error: "podid is required" });
      const cfg = await loadWorker();
      const collectionName = cfg.FIREBASE_COLLECTION_NAME || DEFAULT_COLLECTION;

      if (event === "ready") {
        const decision = await advanceToReady({ podid, cfg, collectionName });
        return res.status(200).json({ success: true, ...decision });
      }

      if (event === "drained") {
        await terminateAndReset(cfg, podid, collectionName, STATES.IDLE);
        return res.status(200).json({ success: true, action: "terminated" });
      }

      // Clean budget-halt from the drain Job (maxJobsPerRun hit). Unlike
      // "unhealthy" this is NOT a failure: no in-flight job to requeue (the
      // last job finished before the loop broke), remaining jobs stay pending.
      // Land in HALTED so atcPodLifecycle will NOT relaunch — a human clears
      // `halted` + sets state=IDLE to resume.
      if (event === "halt") {
        await terminateAndReset(cfg, podid, collectionName, STATES.HALTED);
        await workerRef().set({
          halted: true,
          haltedReason: detail || "job budget reached",
          lastUpdateAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        await alertAtc("info", `Pod ${podid} halted after job budget: ${detail || "(no detail)"} — manual reset to resume.`, {
          stage: "PodWorker", webhookUrl: cfg.SLACK_WEBHOOK_URL,
        });
        return res.status(200).json({ success: true, action: "halted" });
      }

      if (event === "unhealthy") {
        const decision = await markUnhealthy({ podid, reason: detail, collectionName });
        if (decision.action === "terminate") {
          await terminateAndReset(cfg, podid, collectionName, STATES.HALTED);
        }
        await alertAtc("critical", `Pod ${podid} reported unhealthy: ${detail || "(no detail)"} — halted, manual reset needed.`, {
          stage: "PodWorker", webhookUrl: cfg.SLACK_WEBHOOK_URL,
        });
        return res.status(200).json({ success: true, ...decision });
      }

      if (event === "info") {
        await workerRef().set({ lastDetail: detail || "", lastUpdateAt: FieldValue.serverTimestamp() }, { merge: true });
        return res.status(200).json({ success: true, action: "info" });
      }

      return res.status(400).json({ error: `unknown event: ${event}` });
    } catch (err) {
      logger.error("podWorkerUpdate failed", { error: err.message, stack: err.stack });
      return res.status(500).json({ success: false, error: err.message });
    }
  });
});

// Exposed for integration tests (state transitions; not deployed beyond the
// scheduled + HTTP handlers above).
exports.launchAndLoad = launchAndLoad;
exports.advanceToReady = advanceToReady;
exports.markReady = markReady;
exports.markUnhealthy = markUnhealthy;
exports.terminateAndReset = terminateAndReset;
exports.triggerWorkerJob = triggerWorkerJob;
exports.podHealthy = podHealthy;
exports.WORKER_DOC = WORKER_DOC;
exports.STATES = STATES;
