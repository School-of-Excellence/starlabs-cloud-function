# scope-enhancement-atc-pipeline — ATC Usage Dashboard

Pre-aggregated usage data for the frontend **ATC usage dashboard**. Scope: business
throughput only — reports generated, success/failure (incl. *why*), turnaround.
**No** GPU/cost tracking. Sliced by **coach (`profileid`) × type**.

## How it works

1. **Capture** (existing pipeline, 2 fields added in `../components/pod_jobs.js`): every
   terminal `queue_atc_generation` doc (firestore-atc) now carries
   - `finalizedAt` — server timestamp set on **both** success and terminal failure (the field
     the rollup windows on),
   - `failureCategory` — normalized reason (`null` on success), from `se_atc_failure_classifier.js`.
   Everything else (`profileid`, `type`, `stage`, `status`, `createdAt`, `attempts`) already existed.
2. **Rollup** (`se_atc_usage.js`, scheduled fn `seAtcUsageRollup`, **01:00 IST daily**): queries
   the previous IST day's finished jobs, groups by `profileid × type`, and writes the
   collections below. Daily docs are an idempotent overwrite; lifetime docs are incremented
   **once per date** (guarded by the rollup-state marker), so re-runs never double-count.

```
queue_atc_generation (firestore-atc, finalizedAt windowed)
        │  seAtcUsageRollup (01:00 IST)
        ▼
 default DB:
   scope_enhancement_atc_usage_daily/{date}_{profileid}   (+ _ALL)
   scope_enhancement_atc_usage_lifetime/{profileid}        (+ __ALL)
   scope_enhancement_atc_usage_rollup_state/{date}         (internal marker)
```

## Files

| File | Role |
|---|---|
| `se_atc_usage.js` | scheduled `seAtcUsageRollup` + `runUsageRollup(now)` (I/O) |
| `se_atc_usage_aggregate.js` | pure `aggregateUsage(rows)` / `istDayWindow(now)` (unit-tested) |
| `se_atc_failure_classifier.js` | pure `classifyFailure({reason,finishReason,error,emptyOutput})` |

## Collections the frontend reads (default DB)

### `scope_enhancement_atc_usage_daily/{YYYY-MM-DD}_{profileid}`  (+ `{date}___ALL`)
```jsonc
{
  "date": "2026-06-17",
  "profileid": "p1",
  "byType": {
    "generation":        { "total":12,"completed":10,"failed":2,"retried":3,"turnaroundMsSum":540000,"turnaroundCount":12 },
    "checkpoint report": { "...": "..." },
    "rubrics scoring":   { "...": "..." }
  },
  "byFailure": { "infer_timeout":2, "empty_output":1 },
  "total":31, "completed":28, "failed":3, "retried":4,
  "turnaroundMsSum":1245000, "turnaroundCount":31,
  "updatedAt": <serverTimestamp>
}
```

### `scope_enhancement_atc_usage_lifetime/{profileid}`  (+ `__ALL`)
Same fields, cumulative, plus `firstSeen` (YYYY-MM-DD) and `lastUpdated`.

### Field meanings
- `total` — terminal reports (completed + error) in the bucket.
- `completed` / `failed` — `status==="completed"` / `"error"`.
- `retried` — jobs with `attempts > 0`.
- `turnaroundMsSum` / `turnaroundCount` — **completed only**; avg = `sum / count` (ms). Summable
  across days, so the average is correct at any date range.
- `byType` — per artifact (`generation` / `checkpoint report` / `rubrics scoring`).
- `byFailure` — counts by `failureCategory`: `infer_timeout | infer_error | empty_output |
  bad_json | pod_unavailable | max_attempts | unknown`.

## Frontend queries

```js
// Trend: reports/day for a coach this month  (needs the composite index below)
db.collection("scope_enhancement_atc_usage_daily")
  .where("profileid", "==", coachId)
  .where("date", ">=", "2026-06-01").where("date", "<=", "2026-06-30")
  .orderBy("date");

// Org-wide trend: docs "{date}___ALL"  (profileid == "__ALL")
// Headline cards: read scope_enhancement_atc_usage_lifetime/{coachId}  (or __ALL)
// Avg turnaround (seconds): turnaroundMsSum / turnaroundCount / 1000
```

**Required composite index** (default DB — `firestore.indexes.json`):
`scope_enhancement_atc_usage_daily` → `profileid ASC, date ASC`.

## Deploy notes
- Function: `exports.seAtcUsageRollup` in `../index.js` (region `asia-south1`).
- Index: `firebase deploy --only firestore:indexes` — this repo now registers a `(default)`
  database entry in `firebase.json`. **Review the printed diff before confirming** (this is the
  first default-DB index file; the CLI lists any adds/deletes).
- Forward-only: only jobs finishing after `finalizedAt` ships appear in rollups. Optional
  backfill: set `finalizedAt = completedAt` on historical `completed` docs.

## Tests
- Unit: `test/unit/se_atc_usage.test.js` (`aggregateUsage`, `istDayWindow`, `classifyFailure`).
- Integration: `test/integration/se_atc_usage.test.js` (rollup + idempotency, emulator).
