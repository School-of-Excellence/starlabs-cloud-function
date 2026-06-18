/**
 * pod_worker.js — ATC pod lifecycle state machine + push endpoint.
 *
 * Model (decided with product owner):
 *   - The pod is a dumb inference server: create → loads model (10–20m) → YOU
 *     push "ready" → /infer (bearer).
 *   - The drain worker is a Cloud Run JOB (can run >1h), NOT a function. It is
 *     started when the pod becomes ready and there is work to do.
 *   - This file owns the merged state+config doc, the push endpoint you call,
 *     and the decisions (start worker / terminate / halt). It does NOT contain
 *     the drain loop itself — that's functions/worker/drain.js.
 *
 * Singleton: state≠IDLE blocks a 2nd pod; workerRunning blocks a 2nd worker.
 * Failure policy: requeue + alert + HALT (no auto-recreate; human resets).
 */
"use strict";

const admin = require("firebase-admin");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { logger } = require("firebase-functions");
const cors = require("cors");

const { alertAtc } = require("./atc_alerts");
const { requeueJob, DEFAULT_COLLECTION } = require("./pod_jobs");

const corsHandler = cors({ origin: true });
const sharedSecret = defineSecret("FUNCTIONS_SHARED_SECRET");

const db = admin.firestore();
const atcDb = getFirestore("firestore-atc");

// Single merged doc: human-set config + machine-written runtime state.
const WORKER_DOC = "pod_worker";
const STATES = {
  IDLE: "IDLE",           // no pod
  LOADING: "LOADING",     // pod created, model loading, awaiting "ready" push
  READY: "READY",         // model ready, worker draining
  TERMINATING: "TERMINATING",
  HALTED: "HALTED",       // failure — needs human reset
};

function workerRef() {
  return db.collection("classify").doc(WORKER_DOC);
}

async function loadWorker() {
  const snap = await workerRef().get();
  return snap.exists ? snap.data() : { state: STATES.IDLE };
}

// ── markReady ────────────────────────────────────────────────────────────────
// LOADING → READY on your "ready" push. Decides what happens next:
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

// ── markUnhealthy ────────────────────────────────────────────────────────────
// Any state → HALTED on your "unhealthy" push (or worker-detected failure).
// Requeues the in-flight job (attempts-capped) and signals the pod be torn down.
// No auto-recreate — a human clears `halted` to resume.
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

// ── External side effects (stubs until URLs/Job exist) ──────────────────────
// ★ Start the Cloud Run drain Job. Wire to Cloud Run Jobs API (.../jobs/{name}:run)
//   once the Job is deployed; config: cfg.WORKER_JOB_NAME, cfg.WORKER_REGION.
async function triggerWorkerJob(cfg) {
  if (!cfg || !cfg.WORKER_JOB_NAME) {
    logger.warn("triggerWorkerJob: WORKER_JOB_NAME not configured — worker NOT started");
    return { success: false, error: "WORKER_JOB_NAME not configured" };
  }
  // TODO: POST https://run.googleapis.com/v2/projects/<p>/locations/<region>/jobs/<name>:run
  //       with a metadata-server access token. Returns the execution name.
  logger.info("triggerWorkerJob: would start Cloud Run Job", { job: cfg.WORKER_JOB_NAME });
  return { success: true, pending: true };
}

// ★ Terminate the pod via your terminate endpoint, then clear runtime state.
// finalState = IDLE after a normal drain (scheduler may start again); = HALTED
// after a failure (no auto-recreate — a human must clear `halted`).
async function terminateAndReset(cfg, podid, collectionName, finalState = STATES.IDLE) {
  const url = cfg && cfg.POD_TERMINATE_URL;
  if (url && podid) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ podid }),
        signal: AbortSignal.timeout(30000),
      });
      // Treat already-gone (404) as success (idempotent).
      if (!resp.ok && resp.status !== 404) {
        logger.warn("terminate endpoint failed", { status: resp.status });
        return { success: false, status: resp.status };
      }
    } catch (e) {
      logger.warn("terminate endpoint error", { error: e.message });
      return { success: false, error: e.message };
    }
  } else {
    logger.warn("terminateAndReset: POD_TERMINATE_URL not configured — skipping pod delete");
  }
  // Clear pod runtime fields. state=IDLE (normal) or HALTED (failure — preserves
  // the halt set by markUnhealthy so the scheduler will NOT auto-recreate).
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

// ── podWorkerUpdate — the HTTP url YOU call (server-to-server) ────────────────
// POST { podid, event: "ready"|"unhealthy"|"info", detail?, apiUrl?, bearerToken? }
// Header: X-Api-Key: <FUNCTIONS_SHARED_SECRET>
exports.podWorkerUpdate = onRequest({ secrets: [sharedSecret] }, (req, res) => {
  corsHandler(req, res, async () => {
    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.get("X-Api-Key") !== sharedSecret.value()) {
      return res.status(401).json({ success: false, error: "unauthorized" });
    }
    try {
      const { podid, event, detail, apiUrl, bearerToken } = req.body || {};
      if (!podid) return res.status(400).json({ error: "podid is required" });
      const cfg = await loadWorker();
      const collectionName = cfg.FIREBASE_COLLECTION_NAME || DEFAULT_COLLECTION;

      if (event === "ready") {
        const decision = await markReady({ podid, apiUrl, bearerToken, collectionName });
        if (decision.action === "start-worker") {
          await triggerWorkerJob(cfg);
        } else if (decision.action === "terminate") {
          await terminateAndReset(cfg, podid, collectionName);
        }
        return res.status(200).json({ success: true, ...decision });
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
// HTTP handler above).
exports.markReady = markReady;
exports.markUnhealthy = markUnhealthy;
exports.WORKER_DOC = WORKER_DOC;
exports.STATES = STATES;
