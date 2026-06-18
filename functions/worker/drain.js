/**
 * drain.js — ATC Cloud Run JOB worker (NOT a cloud function).
 *
 * Started by podWorkerUpdate when the pod becomes "ready". A Cloud Run Job runs
 * once to completion and can run for hours (no 60-min function cap), so it owns
 * the long drain loop:
 *
 *     claim 1 job → POST pod /infer → write result → repeat until empty
 *     → terminate pod → mark worker idle → EXIT
 *
 * "Not run on loop" guarantees:
 *   - one execution per start (Cloud Run Job exits when this process exits;
 *     deploy with --max-retries=0 so a crashed execution is NOT auto-retried);
 *   - claimNextJob moves pending→processing, so a job is handed out once;
 *   - a failed inference is requeued with an ATTEMPTS CAP (requeueJob) → after
 *     N tries the job goes to `error`, leaving the pending pool, so the loop
 *     can never spin on the same job forever;
 *   - the loop ends the instant claimNextJob returns null.
 *
 * Run: node worker/drain.js   (env GOOGLE_APPLICATION_CREDENTIALS or ADC)
 */
"use strict";

const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp();

const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { claimNextJob, writeJobResult, requeueJob, DEFAULT_COLLECTION } = require("../components/pod_jobs");

const db = admin.firestore();
const WORKER_DOC = "pod_worker";

// Max wall-clock per single inference before we treat the pod as hung.
const INFER_TIMEOUT_MS = Number(process.env.INFER_TIMEOUT_MS || 20 * 60 * 1000); // 20m default

function workerRef() {
  return db.collection("classify").doc(WORKER_DOC);
}

// ★ Call the pod's inference API. CONTRACT PENDING — fill in once provided:
//   request : POST {apiUrl}/infer  Authorization: Bearer <token>
//             body { prompt, system }  (or OpenAI { model, messages })
//   response: { output, finishReason, tokensGenerated }  (or choices[0]...)
async function callInfer({ apiUrl, bearerToken, job }) {
  const resp = await fetch(`${apiUrl}/infer`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${bearerToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt: job.prompt, system: job.systemPrompt }),
    signal: AbortSignal.timeout(INFER_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`infer HTTP ${resp.status}`);
  const data = await resp.json();
  // TODO: adapt to the real response shape.
  return {
    output: data.output,
    raw_output: data.raw_output || "",
    finishReason: data.finishReason || "stop",
    tokensGenerated: data.tokensGenerated || 0,
  };
}

async function main() {
  const cfg = (await workerRef().get()).data() || {};
  const { podid, apiUrl, bearerToken } = cfg;
  const collectionName = cfg.FIREBASE_COLLECTION_NAME || DEFAULT_COLLECTION;
  const maxAttempts = Number(cfg.maxAttempts || 3);
  const model = cfg.model || "unknown";

  if (cfg.state !== "READY" || !podid || !apiUrl || !bearerToken) {
    console.log("drain: not READY or missing pod info — exiting", { state: cfg.state });
    return;
  }

  let processed = 0;
  // Drain loop — exits when no pending jobs remain.
  for (;;) {
    const job = await claimNextJob({ collectionName, podId: podid });
    if (!job) break; // drained → done

    await workerRef().set({ currentJobPath: job.path, lastUpdateAt: FieldValue.serverTimestamp() }, { merge: true });

    try {
      const result = await callInfer({ apiUrl, bearerToken, job });
      await writeJobResult({
        result: { path: job.path, ...result },
        podId: podid,
        modelName: model,
      });
      processed++;
    } catch (e) {
      // Inference failed/timed out → requeue with attempts cap (poison-pill safe).
      const r = await requeueJob({
        collectionName, path: job.path, reason: `infer error: ${e.message}`, podId: podid, maxAttempts,
      });
      console.warn("drain: infer failed", { job: job.jobId, attempts: r.attempts, errored: !!r.errored });
      // If the pod itself is unreachable, stop draining and let podWorkerUpdate
      // (unhealthy) / watchdog handle teardown. Conservative: break on error.
      break;
    }
  }

  await workerRef().set({ currentJobPath: FieldValue.delete(), workerRunning: false, lastUpdateAt: FieldValue.serverTimestamp() }, { merge: true });
  console.log("drain: finished", { processed });
  // ★ TODO: call the terminate endpoint (POD_TERMINATE_URL) here, or let the
  //   cloud function terminate when it observes workerRunning=false + drained.
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("drain: fatal", e);
  process.exit(1);
});
