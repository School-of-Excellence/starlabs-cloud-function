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
const { claimNextJob, writeJobResult, requeueJob, DEFAULT_COLLECTION } = require("../components/pod-execution-pipeline/pod_jobs");

const db = admin.firestore();
const WORKER_DOC = "pod_worker";

// Max wall-clock per single inference before we treat the pod as hung.
const INFER_TIMEOUT_MS = Number(process.env.INFER_TIMEOUT_MS || 20 * 60 * 1000); // 20m default

function workerRef() {
  return db.collection("classify").doc(WORKER_DOC);
}

// Call the pod's OpenAI-compatible inference API (vLLM behind the controller's
// nginx bearer proxy). apiUrl is the controller's `public_url`:
//   POST {apiUrl}/v1/chat/completions   Authorization: Bearer <pod bearer>
//   body  { model, messages:[{role:system},{role:user}], max_tokens?, stream:false }
//   resp  { choices:[{message:{content}, finish_reason}], usage:{total_tokens} }
async function callInfer({ apiUrl, bearerToken, model, maxTokens, job }) {
  const messages = [];
  if (job.systemPrompt) messages.push({ role: "system", content: job.systemPrompt });
  messages.push({ role: "user", content: job.prompt });

  const body = { model, messages, stream: false };
  if (maxTokens) body.max_tokens = maxTokens;

  const resp = await fetch(`${apiUrl.replace(/\/+$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${bearerToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(INFER_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`chat/completions HTTP ${resp.status} ${detail.slice(0, 200)}`);
  }
  const data = await resp.json();
  const choice = (data.choices && data.choices[0]) || {};
  const content = (choice.message && choice.message.content) || "";
  return {
    output: content,
    raw_output: content,
    finishReason: choice.finish_reason || "stop",
    tokensGenerated: (data.usage && data.usage.total_tokens) || 0,
  };
}

// Best-effort signal to the cloud function that the queue is drained so it can
// terminate the pod (the function holds the controller credentials; the Job does
// not). If unreachable, the controller's own idle watchdog tears the pod down.
// Best-effort lifecycle push to the cloud function (it holds the controller
// credentials; the Job does not).
//   event "drained" → queue empty  → terminate pod → state IDLE (may relaunch)
//   event "halt"    → job budget hit → terminate pod → state HALTED (needs
//                     a manual reset before it will run again; leftover jobs
//                     stay `pending`, nothing is requeued/lost)
// If unreachable, the controller's own idle watchdog tears the pod down.
async function signalLifecycle(podid, event, detail) {
  const url = process.env.PODWORKER_UPDATE_URL;
  const apiKey = process.env.FUNCTIONS_SHARED_SECRET;
  if (!url || !apiKey) {
    console.log(`drain: PODWORKER_UPDATE_URL/secret not set — skipping ${event} signal (idle watchdog will reap)`);
    return;
  }
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": apiKey },
      body: JSON.stringify({ podid, event, detail }),
      signal: AbortSignal.timeout(30000),
    });
    console.log(`drain: ${event} signal sent`, { status: r.status });
  } catch (e) {
    console.warn(`drain: ${event} signal failed`, { error: e.message });
  }
}

async function main() {
  const cfg = (await workerRef().get()).data() || {};
  const { podid, apiUrl, bearerToken } = cfg;
  const collectionName = cfg.FIREBASE_COLLECTION_NAME || DEFAULT_COLLECTION;
  const maxAttempts = Number(cfg.maxAttempts || 3);
  const model = cfg.model || "unknown";
  const maxTokens = Number(cfg.maxTokens || 0) || undefined;
  // Optional per-run job budget: stop after this many successful jobs and HALT
  // the worker (needs a manual reset) instead of draining the whole queue.
  // 0 / unset = unlimited (drain until empty, the original behaviour).
  const maxJobsPerRun = Number(cfg.maxJobsPerRun || 0);

  if (cfg.state !== "READY" || !podid || !apiUrl || !bearerToken) {
    console.log("drain: not READY or missing pod info — exiting", { state: cfg.state });
    return;
  }

  let processed = 0;
  let budgetHalt = false;
  // Drain loop — exits when no pending jobs remain (or the job budget is hit).
  for (;;) {
    const job = await claimNextJob({ collectionName, podId: podid });
    if (!job) break; // drained → done

    await workerRef().set({ currentJobPath: job.path, lastUpdateAt: FieldValue.serverTimestamp() }, { merge: true });

    try {
      const result = await callInfer({ apiUrl, bearerToken, model, maxTokens, job });
      await writeJobResult({
        result: { path: job.path, ...result },
        podId: podid,
        modelName: model,
      });
      processed++;
      if (maxJobsPerRun > 0 && processed >= maxJobsPerRun) {
        budgetHalt = true;
        console.log("drain: job budget reached — halting", { processed, maxJobsPerRun });
        break;
      }
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
  console.log("drain: finished", { processed, budgetHalt });
  // Tell the cloud function to terminate the pod via the controller (it holds the
  // deployer credentials). Falls back to the controller idle watchdog if missed.
  //   budget hit → HALT (won't relaunch); queue empty → normal drained → IDLE.
  if (budgetHalt) {
    await signalLifecycle(podid, "halt", `job budget reached (${processed})`);
  } else {
    await signalLifecycle(podid, "drained");
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("drain: fatal", e);
  process.exit(1);
});
