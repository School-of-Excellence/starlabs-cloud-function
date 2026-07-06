/**
 * se_atc_telemetry.js — queue-aiatc-generation-pipeline telemetry helpers.
 *
 * Fills the gaps the nightly seAtcUsageRollup can't see (it only windows on
 * `finalizedAt` = terminal jobs). These capture:
 *   - DROP-OFFS: jobs that were NEVER created because an S0/S1 gate bailed
 *     (missing zoom transcript, generateatc=false, missing atcprompts, …) —
 *     the largest silent failure class, otherwise only in Slack/logs.
 *   - BACKLOG GAUGE: point-in-time pending/processing/stuck counts + oldest age,
 *     so "what's NOT done yet" is visible, not just "what finished".
 *
 * Both are BEST-EFFORT: every write is wrapped so a telemetry failure can NEVER
 * break the generation pipeline. Writes go to the default DB (same place the
 * usage rollup writes its dashboard docs).
 */
"use strict";

const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const defaultDb = getFirestore();

const DROPOFF_COLLECTION = "scope_enhancement_atc_usage_dropoffs";   // doc per IST day
const BACKLOG_COLLECTION = "scope_enhancement_atc_usage_backlog";    // doc "latest" + per-day

// IST calendar day (matches se_atc_usage_aggregate.istDayWindow's date key).
function istDateStr(now = new Date()) {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const d = new Date(now.getTime() + IST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Count a generation job that was DROPPED before entering the queue.
 * @param {string} stage  "S0" (queuesystem processStage) | "S1" (processAtcGenerationDoc)
 * @param {string} reason short snake_case key, e.g. "no_form_submission",
 *        "no_studio_session", "no_liveassignment", "no_zoom_meeting",
 *        "transcript_fetch_failed", "empty_transcript", "unknown_stage_type",
 *        "generateatc_false", "atcprompts_missing"
 * @param {object} [extra] optional small context (profileid, queueTokenId, stage name)
 */
async function recordDropoff(stage, reason, extra = {}) {
  try {
    const date = istDateStr();
    await defaultDb.collection(DROPOFF_COLLECTION).doc(date).set({
      date,
      total: FieldValue.increment(1),
      byStage: { [stage]: FieldValue.increment(1) },
      byReason: { [reason]: FieldValue.increment(1) },
      lastReason: reason,
      lastExtra: extra || {},
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (_) { /* telemetry must never break the pipeline */ }
}

/**
 * Point-in-time backlog gauge — writes a "latest" doc (overwrite) plus a per-IST-day
 * doc (so a daily trend exists). Call from the watchdog, which already computes these.
 * @param {object} g {pendingCount, processingCount, dataincompleteCount, stuckCount, oldestPendingAgeMin, collectionName, podState}
 */
async function writeBacklogGauge(g = {}) {
  const payload = {
    pendingCount: g.pendingCount || 0,
    processingCount: g.processingCount || 0,
    // Redesigned workflow: docs waiting on missing pairing data (never reach
    // pending/processing until the regenerate button completes them).
    dataincompleteCount: g.dataincompleteCount || 0,
    stuckCount: g.stuckCount || 0,
    oldestPendingAgeMin: g.oldestPendingAgeMin || 0,
    collectionName: g.collectionName || "",
    podState: g.podState || "",
    sampledAt: FieldValue.serverTimestamp(),
  };
  try {
    const date = istDateStr();
    const batch = defaultDb.batch();
    batch.set(defaultDb.collection(BACKLOG_COLLECTION).doc("latest"), payload, { merge: true });
    batch.set(defaultDb.collection(BACKLOG_COLLECTION).doc(date), { date, ...payload }, { merge: true });
    await batch.commit();
  } catch (_) { /* best-effort */ }
}

module.exports = {
  recordDropoff,
  writeBacklogGauge,
  istDateStr,
  constants: { DROPOFF_COLLECTION, BACKLOG_COLLECTION },
};
