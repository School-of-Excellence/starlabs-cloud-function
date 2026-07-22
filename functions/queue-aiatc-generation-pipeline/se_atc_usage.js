/**
 * se_atc_usage.js — queue-aiatc-generation-pipeline (ATC usage dashboard)
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
const { alertAtc } = require("../components/queue-required-stage-aiatc-creation/atc_alerts");
const { aggregateUsage, istDayWindow, istDayString, emptyAgg } = require("./se_atc_usage_aggregate");

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

// Absolute lifetime shape (a recompute overwrites; it never increments).
function aggToLifetime(a, profileid, firstSeen) {
  return {
    profileid,
    byType: a.byType,
    byFailure: a.byFailure,
    total: a.total,
    completed: a.completed,
    failed: a.failed,
    retried: a.retried,
    turnaroundMsSum: a.turnaroundMsSum,
    turnaroundCount: a.turnaroundCount,
    ...(firstSeen ? { firstSeen } : {}),
    lastUpdated: FieldValue.serverTimestamp(),
  };
}

// Firestore caps a batch at 500 writes.
const BATCH_LIMIT = 450;
async function commitAll(db, writes) {
  for (let i = 0; i < writes.length; i += BATCH_LIMIT) {
    const batch = db.batch();
    for (const w of writes.slice(i, i + BATCH_LIMIT)) batch.set(w.ref, w.data);
    await batch.commit();
  }
}

/**
 * Read every terminal source doc (has `finalizedAt`) with only the fields the
 * aggregation needs. `select()` matters: the full docs carry ~100KB prompts each.
 */
async function readTerminalRows(sourceCollection) {
  const snap = await atcDb
    .collection(sourceCollection)
    .select("profileid", "type", "status", "attempts", "createdAt", "finalizedAt", "failureCategory")
    .get();

  const rows = [];
  for (const doc of snap.docs) {
    const d = doc.data();
    if (d.finalizedAt == null) continue; // still in flight — not lifetime material
    rows.push({
      profileid: d.profileid || "unknown",
      type: d.type || "unknown",
      status: d.status,
      attempts: d.attempts || 0,
      createdAt: d.createdAt,
      finalizedAt: d.finalizedAt,
      failureCategory: d.failureCategory,
    });
  }
  return rows;
}

/**
 * Recompute lifetime totals from the FULL source collection and overwrite them.
 *
 * WHY a recompute and not the previous per-day `FieldValue.increment()`:
 * an accumulator cannot represent a mutable source. Two failure modes were live
 * in prod (both confirmed 2026-07-20):
 *   1. A night that never ran is lost forever — the 2026-07-07 01:00 IST run died
 *      on "billing is disabled for this project", so 2026-07-06's 106 completed
 *      docs were never counted and nothing retried them.
 *   2. A doc that is re-finalized (structure-gate requeue, regenerate button)
 *      keeps its ORIGINAL day's contribution forever — 40 docs counted under
 *      2026-06-24 had since moved to 2026-07-06.
 * Recomputing from source is idempotent and self-healing for both.
 */
async function recomputeLifetime(opts = {}) {
  const sourceCollection = opts.sourceCollection || SOURCE_COLLECTION;
  const lifetimeCollection = opts.lifetimeCollection || LIFETIME_COLLECTION;

  const rows = await readTerminalRows(sourceCollection);

  // Earliest terminal IST day per profile (and org-wide) = firstSeen.
  const firstSeen = {};
  for (const r of rows) {
    const day = istDayString(r.finalizedAt);
    if (!day) continue;
    for (const key of [r.profileid, ALL_KEY]) {
      if (!firstSeen[key] || day < firstSeen[key]) firstSeen[key] = day;
    }
  }

  const { byProfile, all } = aggregateUsage(rows);
  const lifeCol = defaultDb.collection(lifetimeCollection);

  // firstSeen is HISTORY, not a derived total: keep the earliest ever recorded.
  // Re-finalizing a doc moves its finalizedAt forward, so a pure recompute would
  // walk firstSeen forward and silently erase when a profile actually started.
  const existingDocs = await lifeCol.get();
  const priorFirstSeen = {};
  existingDocs.forEach((d) => {
    const prev = d.data().firstSeen;
    if (typeof prev === "string" && prev) priorFirstSeen[d.id] = prev;
  });
  const earliest = (id, computed) => {
    const prev = priorFirstSeen[id];
    if (!prev) return computed;
    if (!computed) return prev;
    return prev < computed ? prev : computed;
  };

  const writes = Object.entries(byProfile).map(([pid, agg]) => ({
    ref: lifeCol.doc(pid),
    data: aggToLifetime(agg, pid, earliest(pid, firstSeen[pid])),
  }));
  writes.push({
    ref: lifeCol.doc(ALL_KEY),
    data: aggToLifetime(all, ALL_KEY, earliest(ALL_KEY, firstSeen[ALL_KEY])),
  });

  // A profile whose docs all disappeared must go to zero, not keep a stale total.
  const live = new Set(writes.map((w) => w.ref.id));
  let zeroed = 0;
  for (const d of existingDocs.docs) {
    if (live.has(d.id)) continue;
    writes.push({ ref: d.ref, data: aggToLifetime(emptyAgg(), d.id, priorFirstSeen[d.id]) });
    zeroed += 1;
  }

  await commitAll(defaultDb, writes);
  return { profiles: Object.keys(byProfile).length, rows: rows.length, zeroed, all };
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

  // 2) Lifetime — recomputed from source, so it is correct regardless of which
  //    nights ran. No marker guard needed: a recompute is idempotent by nature.
  const life = await recomputeLifetime({ sourceCollection, lifetimeCollection });

  // 3) Marker — kept purely as an audit trail of which nights executed, so a gap
  //    is still visible after the fact. Lifetime no longer depends on it.
  await defaultDb.collection(stateCollection).doc(dateStr).set({
    date: dateStr,
    lifetimeApplied: true,
    appliedAt: FieldValue.serverTimestamp(),
    profiles: profiles.length,
    total: all.total,
  }, { merge: true });

  return {
    dateStr,
    docsScanned: rows.length,
    profiles: profiles.length,
    completed: all.completed,
    failed: all.failed,
    lifetimeApplied: true,
    lifetime: { total: life.all.total, completed: life.all.completed, failed: life.all.failed, profiles: life.profiles, zeroed: life.zeroed },
  };
}

/**
 * Recompute the daily doc for every IST day that has terminal docs, and zero any
 * existing daily doc whose day no longer has any. Repairs nights that never ran
 * (the daily sink has no self-healing equivalent to the lifetime recompute).
 */
async function recomputeAllDaily(opts = {}) {
  const sourceCollection = opts.sourceCollection || SOURCE_COLLECTION;
  const dailyCollection = opts.dailyCollection || DAILY_COLLECTION;

  const rows = await readTerminalRows(sourceCollection);
  const byDay = {};
  for (const r of rows) {
    const day = istDayString(r.finalizedAt);
    if (!day) continue;
    (byDay[day] = byDay[day] || []).push(r);
  }

  const dailyCol = defaultDb.collection(dailyCollection);
  const writes = [];
  const live = new Set();
  for (const [day, dayRows] of Object.entries(byDay)) {
    const { byProfile, all } = aggregateUsage(dayRows);
    for (const [pid, agg] of Object.entries(byProfile)) {
      writes.push({ ref: dailyCol.doc(`${day}_${pid}`), data: aggToDaily(agg, day, pid) });
      live.add(`${day}_${pid}`);
    }
    writes.push({ ref: dailyCol.doc(`${day}_${ALL_KEY}`), data: aggToDaily(all, day, ALL_KEY) });
    live.add(`${day}_${ALL_KEY}`);
  }

  let zeroed = 0;
  for (const ref of await dailyCol.listDocuments()) {
    if (live.has(ref.id)) continue;
    const day = ref.id.slice(0, 10);
    const pid = ref.id.slice(11);
    writes.push({ ref, data: aggToDaily(emptyAgg(), day, pid) });
    zeroed += 1;
  }

  await commitAll(defaultDb, writes);
  return { days: Object.keys(byDay).length, written: writes.length, zeroed };
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
exports.recomputeLifetime = recomputeLifetime;
exports.recomputeAllDaily = recomputeAllDaily;
exports.aggregateUsage = aggregateUsage;
exports.istDayWindow = istDayWindow;
exports.istDayString = istDayString;
exports.constants = { SOURCE_COLLECTION, DAILY_COLLECTION, LIFETIME_COLLECTION, STATE_COLLECTION, ALL_KEY };
