/**
 * se_atc_usage.js — scope-enhancement-atc-pipeline (ATC usage dashboard)
 *
 * Nightly rollup that turns terminal ATC job docs into the pre-aggregated
 * collections the frontend dashboard reads. Business-throughput only: reports
 * generated, success/failure (+ why), turnaround. NO GPU/cost tracking.
 *
 * Source : queue_atc_generation  (firestore-atc)  — windowed on `finalizedAt`
 * Sink   : (default DB)
 *   scope_enhancement_atc_usage_daily/{YYYY-MM-DD}_{profileid}   (+ _ALL)  → trend charts
 *   scope_enhancement_atc_usage_lifetime/{profileid}             (+ __ALL) → headline totals
 *   scope_enhancement_atc_usage_rollup_state/{YYYY-MM-DD}        — idempotency marker
 *
 * Daily docs are an idempotent overwrite (recomputed from source). Lifetime docs
 * are incremented ONCE per date, guarded by the rollup-state marker in a
 * transaction, so a re-run never double-counts.
 *
 * Pattern mirrors components/exports-alerts.js `dailyFirestoreAuditAnalysis`.
 */
"use strict";

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { alertAtc } = require("../components/atc_alerts");
const { aggregateUsage, istDayWindow } = require("./se_atc_usage_aggregate");

const atcDb = getFirestore("firestore-atc");
const defaultDb = getFirestore();

const SOURCE_COLLECTION = "queue_atc_generation";
const DAILY_COLLECTION = "scope_enhancement_atc_usage_daily";
const LIFETIME_COLLECTION = "scope_enhancement_atc_usage_lifetime";
const STATE_COLLECTION = "scope_enhancement_atc_usage_rollup_state";
const ALL_KEY = "__ALL";

// ---------- Firestore shaping ----------

function aggToDaily(a, dateStr, profileid) {
  return {
    date: dateStr,
    profileid,
    byType: a.byType,
    byFailure: a.byFailure,
    total: a.total,
    completed: a.completed,
    failed: a.failed,
    retried: a.retried,
    turnaroundMsSum: a.turnaroundMsSum,
    turnaroundCount: a.turnaroundCount,
    updatedAt: FieldValue.serverTimestamp(),
  };
}

// Build a nested patch of FieldValue.increment() values for lifetime accumulation.
function aggToIncrement(a) {
  const inc = FieldValue.increment;
  const out = {
    total: inc(a.total),
    completed: inc(a.completed),
    failed: inc(a.failed),
    retried: inc(a.retried),
    turnaroundMsSum: inc(a.turnaroundMsSum),
    turnaroundCount: inc(a.turnaroundCount),
    byType: {},
    byFailure: {},
    lastUpdated: FieldValue.serverTimestamp(),
  };
  for (const [t, b] of Object.entries(a.byType)) {
    out.byType[t] = {
      total: inc(b.total), completed: inc(b.completed), failed: inc(b.failed),
      retried: inc(b.retried), turnaroundMsSum: inc(b.turnaroundMsSum), turnaroundCount: inc(b.turnaroundCount),
    };
  }
  for (const [c, n] of Object.entries(a.byFailure)) out.byFailure[c] = inc(n);
  return out;
}

// ---------- core rollup (callable directly in tests) ----------

async function runUsageRollup(now = new Date(), opts = {}) {
  const sourceCollection = opts.sourceCollection || SOURCE_COLLECTION;
  const dailyCollection = opts.dailyCollection || DAILY_COLLECTION;
  const lifetimeCollection = opts.lifetimeCollection || LIFETIME_COLLECTION;
  const stateCollection = opts.stateCollection || STATE_COLLECTION;

  const { start, end, dateStr } = istDayWindow(now);

  const snap = await atcDb
    .collection(sourceCollection)
    .where("finalizedAt", ">=", start)
    .where("finalizedAt", "<", end)
    .get();

  const rows = snap.docs.map((doc) => {
    const d = doc.data();
    return {
      profileid: d.profileid || "unknown",
      type: d.type || "unknown",
      status: d.status,
      attempts: d.attempts || 0,
      createdAt: d.createdAt,
      finalizedAt: d.finalizedAt,
      failureCategory: d.failureCategory,
    };
  });

  const { byProfile, all } = aggregateUsage(rows);
  const profiles = Object.keys(byProfile);

  // 1) Daily docs — idempotent overwrite.
  const dailyCol = defaultDb.collection(dailyCollection);
  const batch = defaultDb.batch();
  for (const pid of profiles) {
    batch.set(dailyCol.doc(`${dateStr}_${pid}`), aggToDaily(byProfile[pid], dateStr, pid));
  }
  batch.set(dailyCol.doc(`${dateStr}_${ALL_KEY}`), aggToDaily(all, dateStr, ALL_KEY));
  await batch.commit();

  // 2) Lifetime increments — applied exactly once per date (marker-guarded).
  const lifeCol = defaultDb.collection(lifetimeCollection);
  const markerRef = defaultDb.collection(stateCollection).doc(dateStr);
  const lifeRefs = profiles.map((p) => lifeCol.doc(p)).concat([lifeCol.doc(ALL_KEY)]);

  const lifetimeApplied = await defaultDb.runTransaction(async (tx) => {
    const snaps = await tx.getAll(markerRef, ...lifeRefs);
    const markerSnap = snaps[0];
    if (markerSnap.exists && markerSnap.data().lifetimeApplied) return false;

    const lifeSnaps = snaps.slice(1);
    profiles.forEach((pid, i) => {
      const patch = aggToIncrement(byProfile[pid]);
      if (!lifeSnaps[i].exists) patch.firstSeen = dateStr;
      tx.set(lifeRefs[i], patch, { merge: true });
    });
    const allSnap = lifeSnaps[lifeSnaps.length - 1];
    const allPatch = aggToIncrement(all);
    if (!allSnap.exists) allPatch.firstSeen = dateStr;
    tx.set(lifeRefs[lifeRefs.length - 1], allPatch, { merge: true });

    tx.set(markerRef, {
      date: dateStr,
      lifetimeApplied: true,
      appliedAt: FieldValue.serverTimestamp(),
      profiles: profiles.length,
      total: all.total,
    }, { merge: true });
    return true;
  });

  return {
    dateStr,
    docsScanned: rows.length,
    profiles: profiles.length,
    completed: all.completed,
    failed: all.failed,
    lifetimeApplied,
  };
}

// ---------- scheduled entrypoint ----------

exports.seAtcUsageRollup = onSchedule(
  { schedule: "0 1 * * *", timeZone: "Asia/Kolkata", region: "asia-south1", timeoutSeconds: 540, memory: "512MiB" },
  async () => {
    try {
      const result = await runUsageRollup();
      console.log("seAtcUsageRollup complete", result);
      return result;
    } catch (err) {
      await alertAtc("critical", `seAtcUsageRollup failed: ${err.message}`, {
        stage: "Usage rollup",
        extra: { stack: err.stack },
      });
      throw err;
    }
  }
);

// Core rollup + re-exported pure helpers (for tests / callers).
exports.runUsageRollup = runUsageRollup;
exports.aggregateUsage = aggregateUsage;
exports.istDayWindow = istDayWindow;
exports.constants = { SOURCE_COLLECTION, DAILY_COLLECTION, LIFETIME_COLLECTION, STATE_COLLECTION, ALL_KEY };
