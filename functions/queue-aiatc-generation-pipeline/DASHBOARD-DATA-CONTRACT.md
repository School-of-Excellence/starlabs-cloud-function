# ATC Usage Dashboard — Data Contract

What the frontend reads to render the ATC pipeline dashboard. Two Firestore databases:
- **default** (`firestore`): `classify/pod_worker`, all `scope_enhancement_atc_usage_*`
- **`firestore-atc`**: `queue_atc_generation` (the raw job queue)

**Refresh cadence matters** — pick the source per panel:

| Source | Cadence | Use for |
|---|---|---|
| `classify/pod_worker` | **real-time** (listener) | pod status tile |
| `queue_atc_generation` (raw, `count()`) | **real-time** | live backlog / in-flight / today's done+errors |
| `scope_enhancement_atc_usage_dropoffs` | **real-time** (per-event) | "never created" (breaks) counter |
| `scope_enhancement_atc_usage_backlog` | **hourly** (atcJobWatchdog) | backlog trend |
| `scope_enhancement_atc_usage_daily` | **nightly** 01:00 IST | daily throughput/error trends |
| `scope_enhancement_atc_usage_lifetime` | **nightly** (once/day) | headline lifetime totals |

> Rule of thumb: **live tiles → read raw `queue_atc_generation` + `pod_worker`**; **trends/history → read the rollup `_daily`/`_lifetime`**; **breaks → `_dropoffs`**.

---

## 1. `classify/pod_worker`  (default DB, single doc — real-time)
Live state of the pod loop. Attach a Firestore realtime listener.

| field | type | meaning |
|---|---|---|
| `enabled` | bool | armed? `false` = lifecycle is a no-op (nothing drains) |
| `state` | string | `IDLE` \| `LOADING` \| `READY` \| `TERMINATING` \| `HALTED` |
| `halted` / `haltedReason` | bool / string | needs manual reset (clear `halted`) |
| `podid` | string | current RunPod pod id |
| `apiUrl` | string | pod inference base URL |
| `gpu` | `{gpu,count}` | GPU type + count |
| `workerRunning` | bool | drain Cloud Run job in flight |
| `currentJobPath` | string | job being inferred right now |
| `launchError` | string | last launch failure (soft) |
| `CONFIG_ID` / `model` | string | controller config + served model |
| `minJobsToStartPod` / `flushWaitMinutes` / `loadTimeoutMinutes` | number | launch + timeout thresholds |

**Pod status tile:** `enabled` + `state` (+ `haltedReason`, `podid`, `gpu`).

---

## 2. `queue_atc_generation`  (firestore-atc — real-time, the source of truth)
One doc per job. Use aggregation `count()` queries for live tiles (cheap).

| field | type | meaning |
|---|---|---|
| `status` | string | `dataincomplete` \| `pending` \| `processing` \| `completed` \| `error` |
| `type` | string | `form` \| `zoom` — own-stage type (drives `byType` rollup; always present) |
| `stagedata` | map | redesigned workflow: `stagename → {data,category,status,type,queueid,queuetokenid}` for the own stage + every pairing stage (`category`: `own`\|`mandatory`\|`atleastonerequired`; `status`: `resolved`\|`missing`). The dashboard reads this to show *which* pairing stage is missing on a `dataincomplete` doc. |
| `profileid` | string | coach |
| `stage` | string | queue stage (e.g. "Scope Enhancement") |
| `createdAt` | ts | enqueue time |
| `startedAt` / `claimedBy` | ts / string | when/by which pod claimed |
| `finalizedAt` | ts | terminal time (completed **or** error) — the rollup windows on this |
| `failureCategory` | string\|null | on error; see categories below |
| `output` | string | inference result (completed) |
| `attempts` | number | retry count |

**Live tiles (real-time):**
- Data-incomplete now: `where status==dataincomplete` → `count()` — created but blocked on missing mandatory/atleastonerequired pairing data; each is actionable via the `regenerateAtcDoc` button (reads `stagedata` to show what's missing)
- Pending now: `where status==pending` → `count()`
- In-flight: `where status==processing` → `count()`
- Stuck (live): `where status==processing AND startedAt <= now-30min` → `count()`
- Oldest pending age: `where status==pending orderBy createdAt asc limit 1`
- Done today / errors today: `where finalizedAt >= todayStartIST` then split by `status`

---

## 3. `scope_enhancement_atc_usage_dropoffs/{YYYY-MM-DD}`  (default DB — real-time)
Jobs that were **never created** because an S0/S1 gate bailed (the biggest silent failure class). One doc per IST day.

| field | type | meaning |
|---|---|---|
| `date` | string | IST `YYYY-MM-DD` |
| `total` | number | drop-offs that day |
| `byStage` | map | `{ S0: n, S1: n }` |
| `byReason` | map | counts per reason (below) |
| `lastReason` | string | most recent reason |
| `lastExtra` | map | `{ profileid, queueTokenId, stage, docid }` of the last one (debug) |

**Drop-off reasons:** `generateatc_false`, `no_form_submission`, `no_studio_session`, `no_liveassignment`, `no_zoom_meeting`, `transcript_fetch_failed`, `unknown_stage_type` (S0 — the OWN stage source could not be resolved, so no doc was created); `atcprompts_missing`, `no_stagedata`, `no_resolved_stages` (S1).

> **Redesigned-workflow note:** a *drop-off* now means only the **own-stage** source was unresolvable (nothing to generate from → no doc). Missing **pairing** data no longer drops off — it creates a `dataincomplete` doc instead (see §2 live tile + the `dataincompleteCount` gauge in §4). So "breaks" (never-created) and "dataincomplete" (created-but-blocked) are two distinct panels.

**Breaks tile:** `_dropoffs/{today}.total` + `byReason` breakdown.

---

## 4. `scope_enhancement_atc_usage_backlog/{latest | YYYY-MM-DD}`  (default DB — hourly)
Point-in-time gauge written by `atcJobWatchdog` (hourly). `latest` = newest sample; per-day docs = trend.

| field | type | meaning |
|---|---|---|
| `pendingCount` / `processingCount` / `stuckCount` | number | queue depth by state |
| `dataincompleteCount` | number | docs blocked on missing pairing data (redesigned workflow) |
| `oldestPendingAgeMin` | number | age of oldest pending job |
| `podState` | string | `pod_worker.state` at sample time |
| `collectionName` | string | source collection |
| `sampledAt` | ts | sample time |

> Hourly → for a **live** backlog tile read raw `queue_atc_generation` counts instead (§2).

---

## 5. `scope_enhancement_atc_usage_daily/{YYYY-MM-DD}_{profileid|__ALL}`  (default DB — nightly)
Per-coach + org-wide daily aggregate (idempotent overwrite). `_ALL` doc id suffix is `__ALL`.

| field | type | meaning |
|---|---|---|
| `date` / `profileid` | string | day + coach (`__ALL` = all) |
| `total` / `completed` / `failed` / `retried` | number | counts |
| `turnaroundMsSum` / `turnaroundCount` | number | avg turnaround = sum/count (completed only) |
| `byType` | map | per `type`: `{total,completed,failed,retried,turnaroundMsSum,turnaroundCount}` |
| `byFailure` | map | `{ failureCategory: n }` |

## 6. `scope_enhancement_atc_usage_lifetime/{profileid|__ALL}`  (default DB — nightly, incremental)
Same metrics as daily but cumulative (+ `firstSeen`, `lastUpdated`). Headline totals.

## 7. `scope_enhancement_atc_usage_rollup_state/{YYYY-MM-DD}`  (default DB — internal)
Idempotency marker (`lifetimeApplied`, `appliedAt`). **Not for the dashboard** — guards double-counting only.

---

## Failure categories (`failureCategory` / `byFailure`)
`infer_timeout`, `infer_error`, `empty_output`, `bad_json`, `pod_unavailable`, `max_attempts`, `unknown`.

## Panel → source quick reference
| Panel | Source | Cadence |
|---|---|---|
| Pod status | `classify/pod_worker` | live |
| Data-incomplete now (actionable) | `queue_atc_generation` `status==dataincomplete` count() (+ read `stagedata` per doc) | live |
| Backlog (pending/processing now) | `queue_atc_generation` count() | live |
| Stuck now | `queue_atc_generation` `processing & startedAt<now-30m` | live |
| Done / errors **today** | `queue_atc_generation` by `finalizedAt>=todayIST` | live |
| Error breakdown | `_daily.byFailure` (or live: `status==error`) | nightly / live |
| Breaks (never created) | `_dropoffs/{today}` | live |
| Backlog trend | `_backlog/{date}` | hourly |
| Daily throughput / turnaround | `_daily` | nightly |
| Lifetime totals | `_lifetime/__ALL` | nightly |

> **Note:** throughput/error/turnaround stay at zero until production is **armed** (`classify/pod_worker.enabled=true`) so jobs actually drain to a terminal state. Drop-offs and live raw-queue tiles populate regardless.

> **Known gap (deferred):** there is no *conversion* metric for the redesigned workflow (how many `dataincomplete` docs eventually reach `completed` after a regenerate). `dataincomplete` is non-terminal (like `pending`) so the nightly `_daily`/`_lifetime` rollups — which window on `finalizedAt` — intentionally exclude it. If a conversion funnel is wanted later, stamp a `dataincompleteAt` on creation and diff against `finalizedAt` in the rollup.
