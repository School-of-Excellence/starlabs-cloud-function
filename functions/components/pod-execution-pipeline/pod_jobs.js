/**
 * pod_jobs.js — shared Firestore job logic for the ATC pod pipeline.
 *
 * Pure data-layer (admin SDK only, NO firebase-functions) so BOTH sides can
 * import it:
 *   - the HTTP handlers in runpod_ai.js (getJobRequest / submitJobResult)
 *   - the Cloud Run Job drain worker (functions/worker/drain.js)
 *
 * Jobs live in the firestore-atc database. admin.initializeApp() must run before
 * this module is required (service.js does it in functions; the worker entry
 * does it itself).
 */
"use strict";

const { getFirestore, FieldValue } = require("firebase-admin/firestore");
// queue-aiatc-generation-pipeline (usage dashboard): normalize the failure reason
// so the nightly rollup can chart *why* reports fail. Pure helper, no side effects.
const { classifyFailure } = require("../../queue-aiatc-generation-pipeline/se_atc_failure_classifier");

const atcDb = getFirestore("firestore-atc");

const DEFAULT_COLLECTION = "queue_atc_generation";
const DEFAULT_MAX_ATTEMPTS = 3;

// Claim the single oldest pending job atomically (FIFO, one at a time).
// Concurrent claimers are safe: the transaction retries and never double-claims.
// `startedAt` is stamped only when a job truly begins. Returns the job or null.
async function claimNextJob({ collectionName, podId }) {
  const coll = atcDb.collection(collectionName || DEFAULT_COLLECTION);
  return atcDb.runTransaction(async (tx) => {
    const q = coll
      .where("status", "==", "pending")
      .orderBy("createdAt", "asc")
      .limit(1);
    const snap = await tx.get(q);
    if (snap.empty) return null;
    const doc = snap.docs[0];
    const data = doc.data();
    tx.update(doc.ref, {
      status: "processing",
      claimedBy: podId || "unknown",
      startedAt: FieldValue.serverTimestamp(),
      lastupdatedat: FieldValue.serverTimestamp(),
    });
    return {
      jobId: doc.id,
      path: doc.ref.path,
      profileid: data.profileid || "",
      prompt: data.prompt || "",
      systemPrompt: data.systemprompt || data.systemPrompt || "",
      attempts: data.attempts || 0,
    };
  });
}

// Write one job's result, guarded by ownership: persists only if the doc is
// still `processing` AND still claimed by this pod — so a late/duplicate
// submission cannot clobber a fresher run. Returns {written, skipped, reason, failure}.
async function writeJobResult({ result, podId, modelName }) {
  if (!result || !result.path) {
    return { written: false, skipped: true, reason: "missing path", failure: null };
  }
  const ref = atcDb.doc(result.path);
  const status = result.status || "completed";
  const emptyOutput = !result.output || String(result.output).trim() === "";
  const isFailure =
    status === "error" || !!result.error ||
    (result.finishReason && result.finishReason !== "stop") || emptyOutput;

  const outcome = await atcDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { written: false, skipped: true, reason: "doc gone" };
    const d = snap.data();
    if (d.status !== "processing") {
      return { written: false, skipped: true, reason: `status=${d.status}` };
    }
    if (d.claimedBy && podId && d.claimedBy !== podId) {
      return { written: false, skipped: true, reason: `owned by ${d.claimedBy}` };
    }
    tx.set(ref, {
      raw_output: result.raw_output || "",
      output: result.output || "",
      status,
      tokensGenerated: result.tokensGenerated || 0,
      finishReason: result.finishReason || "unknown",
      error: result.error || null,
      model: modelName || "unknown",
      completedAt: FieldValue.serverTimestamp(),
      // queue-aiatc-generation-pipeline: single terminal timestamp the usage rollup
      // windows on (covers BOTH success and failure). failureCategory is the
      // chartable reason (null on success).
      finalizedAt: FieldValue.serverTimestamp(),
      failureCategory: isFailure
        ? classifyFailure({
            reason: result.error,
            finishReason: result.finishReason,
            error: result.error,
            emptyOutput,
          })
        : null,
      lastupdatedat: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { written: true, skipped: false };
  });

  return {
    ...outcome,
    failure: outcome.written && isFailure ? {
      jobId: result.jobId || result.path,
      status,
      error: result.error || null,
      finishReason: result.finishReason || null,
      emptyOutput,
    } : null,
  };
}

// Requeue a job after a failed/aborted attempt — with a HARD attempts cap so the
// drain loop can never reprocess the same job forever ("not run on loop"):
//   attempts < max  → status:"pending" (re-claimable, attempts++)
//   attempts >= max → status:"error"   (leaves the pending pool permanently)
// Ownership-guarded: won't stomp a job already re-claimed by another pod.
// Returns {ok, requeued|errored, attempts, reason}.
async function requeueJob({ collectionName, path, reason, podId, maxAttempts = DEFAULT_MAX_ATTEMPTS }) {
  const ref = atcDb.doc(path);
  return atcDb.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, reason: "doc gone" };
    const d = snap.data();
    if (podId && d.claimedBy && d.claimedBy !== podId) {
      return { ok: false, reason: `owned by ${d.claimedBy}` };
    }
    const attempts = (d.attempts || 0) + 1;
    if (attempts >= maxAttempts) {
      tx.set(ref, {
        status: "error",
        error: `${reason || "requeue"} (attempts=${attempts})`,
        attempts,
        claimedBy: FieldValue.delete(),
        startedAt: FieldValue.delete(),
        // queue-aiatc-generation-pipeline: terminal failure — stamp the same
        // finalizedAt the usage rollup windows on, plus the chartable reason.
        finalizedAt: FieldValue.serverTimestamp(),
        failureCategory: classifyFailure({
          reason,
          error: reason,
          finishReason: d.finishReason,
        }),
        lastupdatedat: FieldValue.serverTimestamp(),
      }, { merge: true });
      return { ok: true, errored: true, attempts };
    }
    tx.set(ref, {
      status: "pending",
      attempts,
      requeueReason: reason || "requeue",
      claimedBy: FieldValue.delete(),
      startedAt: FieldValue.delete(),
      lastupdatedat: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { ok: true, requeued: true, attempts };
  });
}

module.exports = {
  claimNextJob,
  writeJobResult,
  requeueJob,
  DEFAULT_COLLECTION,
  DEFAULT_MAX_ATTEMPTS,
};
