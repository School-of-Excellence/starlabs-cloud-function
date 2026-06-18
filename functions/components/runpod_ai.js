const admin = require('firebase-admin');
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const { getFirestore } = require("firebase-admin/firestore");
//components imports
const { notifySlack, alertAtc } = require("./atc_alerts");
const { shouldStartPod } = require("./atc_helpers");
const { claimNextJob, writeJobResult, DEFAULT_MAX_ATTEMPTS } = require("./pod_jobs");

const cors = require("cors");
const corsHandler = cors({origin: true});

// Default DB holds `llmmodels` + `classify`. The job collection
// (`queue_atc_generation`) lives in the `firestore-atc` database — every
// writer (queuesystem/queue_atc_generation/ATC) uses it, so the pod pipeline
// must read/write jobs there too.
const db = admin.firestore();
const atcDb = getFirestore("firestore-atc");

// ── Secrets ──
const runpodApiKey = defineSecret("RUNPOD_API_KEY");
const sharedSecret = defineSecret("FUNCTIONS_SHARED_SECRET");
const {logger} = require("firebase-functions");
const {FieldValue} = require("firebase-admin/firestore");
const BATCH_LIMIT = 400;
const {getAuth} = require("firebase-admin/auth");

const SCHEDULER_CONFIG_DOCID = "pod_scheduler";
const DEFAULT_MIN_JOBS = 20;
const DEFAULT_FLUSH_WAIT_MINUTES = 120; // 2h: flush a sub-min batch once the oldest pending job is this old
const DEFAULT_STUCK_PROCESSING_MINUTES = 30;
const DEFAULT_COLLECTION = "queue_atc_generation";

// =============================================================================
// Helpers
// =============================================================================
async function requireAuth(req, res) {
  // Server-to-server: X-Api-Key must match the Firebase-stored secret
  const apiKey = req.get("X-Api-Key");
  if (apiKey && apiKey === sharedSecret.value()) {
    return {type: "server"};
  }

  // Frontend (Angular) user: Firebase Auth ID token
  const authHeader = req.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (token) {
    try {
      const decoded = await getAuth().verifyIdToken(token);
      return {type: "user", uid: decoded.uid, email: decoded.email || null};
    } catch (err) {
      logger.warn("invalid ID token", {error: err.message});
    }
  }

  res.status(401).json({success: false, error: "unauthorized"});
  return null;
}

function handleOptions(req, res) {
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return true;
  }
  return false;
}

// Convert a Firestore Timestamp / Date / {_seconds} to epoch millis, else null.
function toMillis(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === "function") return ts.toDate().getTime();
  if (typeof ts._seconds === "number") return ts._seconds * 1000;
  if (ts instanceof Date) return ts.getTime();
  return null;
}

// claimNextJob + writeJobResult now live in ./pod_jobs (shared with the Cloud
// Run drain worker). Imported at the top of this file.

// =============================================================================
// ensurePod — core "make sure exactly one pod exists for this template" logic.
// Shared by the run_jobrequest HTTP wrapper and the atcPodScheduler cron.
// Race-guarded via llmmodels/{TEMPLATEID}.podid ("__creating__" sentinel),
// with podid-drift healing and a post-lock recheck against RunPod.
// =============================================================================
async function ensurePod(payload) {
  const slackUrl = payload.SLACK_WEBHOOK_URL || "";
  const apiKey = runpodApiKey.value();
  if (!apiKey) return {success: false, error: "RunPod API key not configured"};

  const templateRef = db.collection("llmmodels").doc(payload.TEMPLATEID);
  const templateSnap = await templateRef.get();
  if (!templateSnap.exists) return {success: false, error: "Template not found"};

  const docData = templateSnap.data();
  const runpodTemplateId = docData.templateid;

  // ── (a) Reuse path: is a pod with this template already up? ──
  const listResp = await fetch("https://rest.runpod.io/v1/pods", {
    method: "GET",
    headers: {"Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json"},
    signal: AbortSignal.timeout(30000),
  });
  if (!listResp.ok) {
    const errorData = await listResp.json().catch(() => ({}));
    return {success: false, error: `RunPod list error: ${listResp.status}`, details: errorData};
  }
  const listData = await listResp.json();
  const pods = Array.isArray(listData) ? listData : (listData.pods || listData.data || []);
  const existing = pods.find((p) => p.templateId === runpodTemplateId);

  if (existing) {
    if (docData.podid !== existing.id) {
      await templateRef.update({podid: existing.id}); // heal drift
    }
    // No trigger: the worker self-loops once its model is health-ready and pulls
    // jobs via getJobRequest, so a live pod will pick up new pending work on its
    // own next claim. Nothing to do but report it's already running.
    return {success: true, alreadyRunning: true, podid: existing.id};
  }

  // No matching live pod — clear stale podid (but leave "__creating__" alone).
  if (docData.podid && docData.podid !== "__creating__") {
    await templateRef.update({podid: ""});
  }

  // ── (b) Race guard: serialize concurrent creators ──
  const reserved = await db.runTransaction(async (tx) => {
    const s = await tx.get(templateRef);
    const d = s.data() || {};
    if (d.podid === "__creating__") return {raceLost: true, reason: "creating"};
    if (d.podid) return {raceLost: true, reason: "exists", podid: d.podid};
    tx.update(templateRef, {podid: "__creating__"});
    return {raceLost: false};
  });
  if (reserved.raceLost) {
    if (reserved.reason === "creating") return {success: true, alreadyRunning: true, creating: true};
    return {success: true, alreadyRunning: true, podid: reserved.podid};
  }

  try {
    // ── (b.1) Re-check RunPod after acquiring the lock ──
    const recheckResp = await fetch("https://rest.runpod.io/v1/pods", {
      method: "GET",
      headers: {"Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json"},
      signal: AbortSignal.timeout(30000),
    });
    if (recheckResp.ok) {
      const recheckData = await recheckResp.json();
      const recheckPods = Array.isArray(recheckData) ? recheckData : (recheckData.pods || recheckData.data || []);
      const raced = recheckPods.find((p) => p.templateId === runpodTemplateId);
      if (raced) {
        await templateRef.update({podid: raced.id});
        // Worker self-starts; no /process trigger needed (see reuse path above).
        return {success: true, alreadyRunning: true, podid: raced.id};
      }
    }

    // ── (c) Build env once; GPU choice changes per attempt ──
    const env = {
      MODEL_PATH: docData.path,
      MODEL_NAME: docData.name,
      TEMPLATE_ID: runpodTemplateId,
      GIT_REPO: docData.git_repo,
      REPO_ID: docData.repo_id,
      D_TYPE: docData.dtype,
      SLACK_WEBHOOK_URL: payload.SLACK_WEBHOOK_URL,
      FIREBASE_FETCH_URL: payload.FIREBASE_FETCH_URL,
      FIREBASE_SUBMIT_URL: payload.FIREBASE_SUBMIT_URL,
      FIREBASE_COLLECTION_NAME: payload.FIREBASE_COLLECTION_NAME,
      DOC_ID: payload.DOC_ID || "",
      FUNCTIONS_API_KEY: sharedSecret.value(),
    };

    const gpupriority = Array.isArray(docData.gpupriority) ? docData.gpupriority : [];
    if (gpupriority.length === 0) {
      await templateRef.update({podid: ""});
      return {success: false, error: "llmmodels doc missing gpupriority[]"};
    }

    // ── (d) Try each GPU option in order ──
    const attempts = [];
    let created = null;
    for (const choice of gpupriority) {
      const runpodPayload = {
        name: `${docData.name}_${new Date().toISOString()}`,
        cloudType: "SECURE",
        computeType: "GPU",
        containerDiskInGb: docData.tempvolumesize,
        gpuCount: choice.count,
        gpuTypeIds: [choice.gpu],
        gpuTypePriority: "availability",
        templateId: runpodTemplateId,
        volumeInGb: 0,
        env: {...env, GPU_COUNT: String(choice.count)},
      };
      const createResp = await fetch("https://rest.runpod.io/v1/pods", {
        method: "POST",
        headers: {"Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json"},
        body: JSON.stringify(runpodPayload),
        signal: AbortSignal.timeout(45000),
      });
      if (createResp.ok) {
        created = await createResp.json();
        break;
      }
      const errorData = await createResp.json().catch(() => ({}));
      attempts.push({gpu: choice.gpu, count: choice.count, status: createResp.status, errorData});
      logger.warn("runpod create attempt failed", {gpu: choice.gpu, status: createResp.status});
    }

    if (!created) {
      await templateRef.update({podid: ""}); // release reservation
      await alertAtc("critical", `Pod create failed for *${payload.TEMPLATEID}* (${docData.name}). All GPU options exhausted.`, {
        stage: "Pod", webhookUrl: slackUrl, extra: {attempts},
      });
      return {success: false, error: "All GPU options failed", attempts};
    }

    await templateRef.update({podid: created.id});
    logger.info("pod created", {podId: created.id, templateId: runpodTemplateId});
    return {success: true, created: true, podid: created.id, data: created};
  } catch (err) {
    // Release the __creating__ lock if we still hold it.
    try {
      await db.runTransaction(async (tx) => {
        const s = await tx.get(templateRef);
        const d = s.data() || {};
        if (d.podid === "__creating__") tx.update(templateRef, {podid: ""});
      });
    } catch (cleanupErr) {
      logger.warn("ensurePod cleanup failed", {error: cleanupErr.message});
    }
    await alertAtc("critical", `ensurePod crashed for *${payload.TEMPLATEID}*: ${err.message}`, {
      stage: "Pod", webhookUrl: slackUrl, extra: {stack: err.stack},
    });
    return {success: false, error: err.message};
  }
}

// doTerminatePod — DELETE the RunPod pod, requeue orphaned jobs, clear podid.
// Shared by the terminatePod HTTP wrapper and submitJobResult's drain dispatch.
async function doTerminatePod({podId, templateId, collectionName}) {
  const apiResponse = await fetch(`https://rest.runpod.io/v1/pods/${podId}`, {
    method: "DELETE",
    headers: {
      "Authorization": `Bearer ${runpodApiKey.value()}`,
      "Content-Type": "application/json",
    },
  });

  // Treat 404 as already-gone (idempotent).
  if (!apiResponse.ok && apiResponse.status !== 404) {
    let errorData = {};
    const ct = apiResponse.headers.get("content-type") || "";
    if (ct.includes("application/json")) errorData = await apiResponse.json().catch(() => ({}));
    logger.warn("runpod terminate failed", {status: apiResponse.status, errorData});
    return {success: false, status: apiResponse.status, error: `RunPod API error: ${apiResponse.status}`, details: errorData};
  }

  // ── Sweep orphans: any docs still 'processing' under this pod → 'pending' ──
  if (collectionName) {
    const stuck = await atcDb.collection(collectionName)
      .where("status", "==", "processing")
      .where("claimedBy", "==", podId)
      .get();
    if (!stuck.empty) {
      let batch = atcDb.batch();
      let n = 0;
      for (const d of stuck.docs) {
        batch.update(d.ref, {
          status: "pending",
          claimedBy: FieldValue.delete(),
          startedAt: FieldValue.delete(),
          lastupdatedat: FieldValue.serverTimestamp(),
        });
        n++;
        if (n % BATCH_LIMIT === 0) { await batch.commit(); batch = atcDb.batch(); }
      }
      if (n % BATCH_LIMIT !== 0) await batch.commit();
      logger.info("orphans requeued", {podId, count: stuck.size});
    }
  }

  if (templateId) {
    await db.collection("llmmodels").doc(templateId).update({podid: ""});
  }

  logger.info("pod terminated", {podId, templateId});
  return {success: true, message: `Pod ${podId} terminated`};
}

// =============================================================================
// 1) run_jobrequest — HTTP wrapper around ensurePod.
// =============================================================================
exports.run_jobrequest = onRequest({secrets: [runpodApiKey, sharedSecret]},
  (req, res) => {
    corsHandler(req, res, async () => {
      if (handleOptions(req, res)) return;
      const auth = await requireAuth(req, res);
      if (!auth) return;

      const payload = req.body || {};
      try {
        const required = [
          "TEMPLATEID",
          "FIREBASE_FETCH_URL",
          "FIREBASE_SUBMIT_URL",
          "FIREBASE_COLLECTION_NAME",
        ];
        for (const k of required) {
          if (!payload[k]) {
            return res.status(400).json({success: false, error: `payload field '${k}' is required`});
          }
        }

        const result = await ensurePod(payload);
        const status = result.success ? 200 : (result.error === "Template not found" ? 404 : 502);
        return res.status(status).json(result);
      } catch (err) {
        logger.error("run_jobrequest crashed", {error: err.message, stack: err.stack});
        return res.status(500).json({success: false, error: err.message});
      }
    });
  },
);

// =============================================================================
// 2) getJobRequest — pod fetches pending jobs and claims them.
// =============================================================================
exports.getJobRequest = onRequest({secrets: [sharedSecret]}, (req, res) => {
  corsHandler(req, res, async () => {
    if (handleOptions(req, res)) return;
    const auth = await requireAuth(req, res);
    if (!auth) return;

    try {
      const {collectionName, podId} = req.body || {};
      if (!collectionName) return res.status(400).json({error: "collectionName is required"});

      // Single-job model: claim exactly the oldest pending job. The worker
      // self-loops (claim → infer → submit → claim) until it gets an empty
      // result, then terminates. An empty {jobs:[]} is the worker's drain signal.
      const job = await claimNextJob({collectionName, podId});
      if (!job) return res.status(200).json({jobs: []});

      logger.info("job claimed", {collectionName, jobId: job.jobId, podId});
      return res.status(200).json({jobs: [job]});
    } catch (error) {
      logger.error("getJobRequest failed", {error: error.message, stack: error.stack});
      return res.status(500).json({success: false, error: error.message});
    }
  });
});

// =============================================================================
// 3) submitJobResult — write results, then dispatch /process or terminate.
// =============================================================================
exports.submitJobResult = onRequest({secrets: [sharedSecret]}, (req, res) => {
  corsHandler(req, res, async () => {
    if (handleOptions(req, res)) return;
    const auth = await requireAuth(req, res);
    if (!auth) return;

    try {
      const {results, model, podId} = req.body || {};
      if (!Array.isArray(results) || results.length === 0) {
        return res.status(400).json({error: "results array is required"});
      }
      if (!podId) return res.status(400).json({error: "podId is required"});

      const modelName = model || "unknown";
      let written = 0;
      let skipped = 0;
      const failures = [];

      // Each write is ownership-guarded (see writeJobResult): only persists if the
      // doc is still `processing` and still claimed by this pod.
      for (const result of results) {
        const outcome = await writeJobResult({result, podId, modelName});
        if (outcome.written) written++; else skipped++;
        if (outcome.skipped && outcome.reason) {
          logger.warn("result write skipped", {jobId: result && result.jobId, reason: outcome.reason});
        }
        if (outcome.failure) failures.push(outcome.failure);
      }

      if (failures.length) {
        await alertAtc("warn", `${failures.length}/${results.length} jobs returned errors/empty output (pod ${podId}, model ${modelName}).`, {
          stage: "Pod", extra: {failures: failures.slice(0, 20)},
        });
      }

      // No lifecycle dispatch here: the worker owns the loop and termination. It
      // keeps calling getJobRequest until it drains, then calls terminatePod.
      logger.info("results submitted", {written, skipped, model: modelName, podId});
      return res.status(200).json({success: true, written, skipped});
    } catch (error) {
      logger.error("submitJobResult failed", {error: error.message, stack: error.stack});
      return res.status(500).json({success: false, error: error.message});
    }
  });
});

// =============================================================================
// 4) terminatePod — HTTP wrapper around doTerminatePod.
// =============================================================================
exports.terminatePod = onRequest({secrets: [runpodApiKey, sharedSecret]}, (req, res) => {
  corsHandler(req, res, async () => {
    if (handleOptions(req, res)) return;
    const auth = await requireAuth(req, res);
    if (!auth) return;

    try {
      const {podId, templateId, collectionName} = req.body || {};
      if (!podId) return res.status(400).json({error: "podId is required"});

      const result = await doTerminatePod({podId, templateId, collectionName});
      return res.status(result.success ? 200 : (result.status || 500)).json(result);
    } catch (error) {
      logger.error("terminatePod crashed", {error: error.message});
      return res.status(500).json({success: false, error: error.message});
    }
  });
});

// =============================================================================
// 5) atcPodScheduler — batching gate. Starts a pod only when enough jobs have
// accumulated (configurable min, default 20) OR the oldest pending job has
// waited past the flush window (so small batches aren't stranded). Zero pending
// jobs → graceful no-op.
//
// Config: classify/pod_scheduler = {
//   podtemplateid, SLACK_WEBHOOK_URL, FIREBASE_FETCH_URL, FIREBASE_SUBMIT_URL,
//   FIREBASE_COLLECTION_NAME?, minJobsToStartPod?, flushWaitMinutes?
// }
// =============================================================================
exports.atcPodScheduler = onSchedule(
  {schedule: "every 1 hours", secrets: [runpodApiKey, sharedSecret]},
  async () => {
    const cfgSnap = await db.collection("classify").doc(SCHEDULER_CONFIG_DOCID).get();
    if (!cfgSnap.exists) {
      // No scheduler config (e.g. dev) — nothing to do. Stay silent to avoid noise.
      logger.info("atcPodScheduler: classify/pod_scheduler missing — skipping");
      return;
    }
    const cfg = cfgSnap.data();
    const collectionName = cfg.FIREBASE_COLLECTION_NAME || DEFAULT_COLLECTION;
    const minJobs = Number(cfg.minJobsToStartPod ?? DEFAULT_MIN_JOBS);
    const flushWaitMinutes = Number(cfg.flushWaitMinutes ?? DEFAULT_FLUSH_WAIT_MINUTES);

    if (!cfg.podtemplateid) {
      await alertAtc("critical", "atcPodScheduler: classify/pod_scheduler.podtemplateid not set — cannot start pods.", {
        stage: "Scheduler", webhookUrl: cfg.SLACK_WEBHOOK_URL,
      });
      return;
    }

    const pendingQuery = atcDb.collection(collectionName).where("status", "==", "pending");
    const countSnap = await pendingQuery.count().get();
    const pendingCount = countSnap.data().count;

    if (pendingCount === 0) {
      logger.info("atcPodScheduler: no pending jobs — no-op");
      return;
    }

    // Oldest pending job age (minutes) for the flush rule.
    const oldestSnap = await pendingQuery.orderBy("createdAt", "asc").limit(1).get();
    let oldestAgeMin = 0;
    if (!oldestSnap.empty) {
      const ms = toMillis(oldestSnap.docs[0].data().createdAt);
      if (ms) oldestAgeMin = (Date.now() - ms) / 60000;
    }

    const reachedMin = pendingCount >= minJobs;
    const flushDue = oldestAgeMin >= flushWaitMinutes;
    if (!shouldStartPod({ pendingCount, oldestAgeMin, minJobs, flushWaitMinutes })) {
      logger.info("atcPodScheduler: below threshold, waiting", {pendingCount, minJobs, oldestAgeMin, flushWaitMinutes});
      return;
    }

    logger.info("atcPodScheduler: starting pod", {pendingCount, minJobs, oldestAgeMin, flushDue});
    const result = await ensurePod({
      TEMPLATEID: cfg.podtemplateid,
      SLACK_WEBHOOK_URL: cfg.SLACK_WEBHOOK_URL || "",
      FIREBASE_FETCH_URL: cfg.FIREBASE_FETCH_URL || "",
      FIREBASE_SUBMIT_URL: cfg.FIREBASE_SUBMIT_URL || "",
      FIREBASE_COLLECTION_NAME: collectionName,
    });
    if (!result.success) {
      await alertAtc("critical", `atcPodScheduler: failed to start pod — ${result.error}`, {
        stage: "Scheduler", webhookUrl: cfg.SLACK_WEBHOOK_URL, extra: {pendingCount, result},
      });
    }
  }
);

// =============================================================================
// 6) atcJobWatchdog — requeue jobs stuck in `processing` past the threshold,
// and alert when a pending backlog is not draining (no live pod).
// =============================================================================
exports.atcJobWatchdog = onSchedule(
  {schedule: "every 10 minutes", secrets: [runpodApiKey, sharedSecret]},
  async () => {
    const cfgSnap = await db.collection("classify").doc(SCHEDULER_CONFIG_DOCID).get();
    const cfg = cfgSnap.exists ? cfgSnap.data() : {};
    const collectionName = cfg.FIREBASE_COLLECTION_NAME || DEFAULT_COLLECTION;
    const stuckMin = Number(cfg.stuckProcessingMinutes ?? DEFAULT_STUCK_PROCESSING_MINUTES);
    const flushWaitMinutes = Number(cfg.flushWaitMinutes ?? DEFAULT_FLUSH_WAIT_MINUTES);
    const maxAttempts = Number(cfg.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    const webhookUrl = cfg.SLACK_WEBHOOK_URL;

    // 1. Requeue jobs stuck in `processing` — attempts-capped (same guard as the
    //    drain worker) so a repeatedly-stuck job can't be reprocessed forever.
    const cutoff = new Date(Date.now() - stuckMin * 60000);
    const stuckSnap = await atcDb.collection(collectionName)
      .where("status", "==", "processing")
      .where("startedAt", "<=", cutoff)
      .get();
    if (!stuckSnap.empty) {
      let batch = atcDb.batch();
      let n = 0;
      let errored = 0;
      for (const d of stuckSnap.docs) {
        const attempts = (d.data().attempts || 0) + 1;
        if (attempts >= maxAttempts) {
          batch.update(d.ref, {
            status: "error",
            error: `stuck > ${stuckMin}m (attempts=${attempts})`,
            attempts,
            claimedBy: FieldValue.delete(),
            startedAt: FieldValue.delete(),
            lastupdatedat: FieldValue.serverTimestamp(),
          });
          errored++;
        } else {
          batch.update(d.ref, {
            status: "pending",
            attempts,
            claimedBy: FieldValue.delete(),
            startedAt: FieldValue.delete(),
            lastupdatedat: FieldValue.serverTimestamp(),
          });
        }
        n++;
        if (n % BATCH_LIMIT === 0) { await batch.commit(); batch = atcDb.batch(); }
      }
      if (n % BATCH_LIMIT !== 0) await batch.commit();
      await alertAtc("warn", `Requeued ${stuckSnap.size - errored}, errored ${errored} job(s) stuck in "processing" > ${stuckMin}m.`, {
        stage: "Watchdog", webhookUrl, extra: {collectionName, stuckMinutes: stuckMin},
      });
    }

    // 2. Non-draining backlog: oldest pending past flush window with no live pod.
    const oldestPending = await atcDb.collection(collectionName)
      .where("status", "==", "pending")
      .orderBy("createdAt", "asc")
      .limit(1)
      .get();
    if (!oldestPending.empty) {
      const ms = toMillis(oldestPending.docs[0].data().createdAt);
      const ageMin = ms ? (Date.now() - ms) / 60000 : 0;
      if (ageMin >= flushWaitMinutes) {
        let podid = "";
        if (cfg.podtemplateid) {
          const tmpl = await db.collection("llmmodels").doc(cfg.podtemplateid).get();
          podid = tmpl.exists ? (tmpl.data().podid || "") : "";
        }
        if (!podid || podid === "__creating__") {
          await alertAtc("critical", `Pending ATC backlog not draining — oldest job is ${Math.round(ageMin)}m old and no live pod is running.`, {
            stage: "Watchdog", webhookUrl, extra: {collectionName, oldestAgeMin: Math.round(ageMin), podid},
          });
        }
      }
    }
  }
);

// Exposed for integration tests (not deployed — index.js only re-exports the
// HTTP/scheduled handlers). The getJobRequest / submitJobResult handlers wrap
// these; tests drive them directly against the emulator.
exports.claimNextJob = claimNextJob;
exports.writeJobResult = writeJobResult;
