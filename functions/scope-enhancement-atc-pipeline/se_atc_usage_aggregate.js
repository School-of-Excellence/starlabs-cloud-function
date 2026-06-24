/**
 * se_atc_usage_aggregate.js — scope-enhancement-atc-pipeline (usage dashboard)
 *
 * PURE aggregation helpers (no Firestore / firebase-admin), so they unit-test
 * without the emulator — same split as components/atc_helpers.js. se_atc_usage.js
 * imports these and handles all I/O.
 */
"use strict";

// Coerce a Firestore Timestamp / JS Date / {seconds} / epoch-ms into millis.
function toMillis(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v.getTime === "function") return v.getTime();
  if (typeof v.seconds === "number") return v.seconds * 1000 + (v.nanoseconds || 0) / 1e6;
  return null;
}

function emptyBucket() {
  return { total: 0, completed: 0, failed: 0, retried: 0, turnaroundMsSum: 0, turnaroundCount: 0 };
}
function emptyAgg() {
  return { byType: {}, byFailure: {}, total: 0, completed: 0, failed: 0, retried: 0, turnaroundMsSum: 0, turnaroundCount: 0 };
}

// Fold one job row into an aggregate (mutates `agg`). Turnaround is counted for
// completed reports only (time to produce a usable report).
function foldRow(agg, row) {
  const type = row.type || "unknown";
  if (!agg.byType[type]) agg.byType[type] = emptyBucket();
  const b = agg.byType[type];

  agg.total += 1; b.total += 1;

  if (row.status === "completed") {
    agg.completed += 1; b.completed += 1;
    const c = toMillis(row.createdAt);
    const f = toMillis(row.finalizedAt);
    if (c != null && f != null && f >= c) {
      const ms = f - c;
      agg.turnaroundMsSum += ms; agg.turnaroundCount += 1;
      b.turnaroundMsSum += ms; b.turnaroundCount += 1;
    }
  } else if (row.status === "error") {
    agg.failed += 1; b.failed += 1;
    const cat = row.failureCategory || "unknown";
    agg.byFailure[cat] = (agg.byFailure[cat] || 0) + 1;
  }

  if ((row.attempts || 0) > 0) { agg.retried += 1; b.retried += 1; }
  return agg;
}

/**
 * Group rows by profileid (plus an org-wide ALL aggregate).
 * @param {Array} rows  {profileid,type,status,attempts,createdAt,finalizedAt,failureCategory}
 * @returns {{byProfile:Object, all:Object}}
 */
function aggregateUsage(rows) {
  const byProfile = {};
  const all = emptyAgg();
  for (const row of rows || []) {
    const pid = row.profileid || "unknown";
    if (!byProfile[pid]) byProfile[pid] = emptyAgg();
    foldRow(byProfile[pid], row);
    foldRow(all, row);
  }
  return { byProfile, all };
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // Asia/Kolkata, no DST

/**
 * Previous IST calendar day window relative to `now`.
 * @returns {{start:Date, end:Date, dateStr:string}}  [start,end), dateStr = YYYY-MM-DD (IST)
 */
function istDayWindow(now = new Date(), dayOffset = -1) {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const startTodayUTC = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_OFFSET_MS;
  const start = new Date(startTodayUTC + dayOffset * 86400000);
  const end = new Date(startTodayUTC + (dayOffset + 1) * 86400000);
  const startIst = new Date(start.getTime() + IST_OFFSET_MS);
  const dateStr =
    `${startIst.getUTCFullYear()}-` +
    `${String(startIst.getUTCMonth() + 1).padStart(2, "0")}-` +
    `${String(startIst.getUTCDate()).padStart(2, "0")}`;
  return { start, end, dateStr };
}

module.exports = { toMillis, aggregateUsage, istDayWindow, emptyBucket, emptyAgg };
