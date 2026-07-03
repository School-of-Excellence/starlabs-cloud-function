# BUILD PROMPT — ATC Usage / Pipeline Monitoring Dashboard

Build a new **ATC Usage / Pipeline Monitoring** dashboard screen inside this frontend codebase. It visualizes the health and throughput of the ATC generation pipeline in real time, backed by Firestore. Follow this spec exactly. Do **not** invent fields, collections, or statuses beyond what is listed here.

---

## 0. Before you write any code — inspect the codebase first

This spec is intentionally framework-agnostic. You MUST match what already exists in this repo rather than introducing new dependencies:

- **Framework & routing** — add the screen using the existing app's router / page convention.
- **Component library & design tokens** — reuse existing card/tile/table/badge components, spacing scale, color tokens, and typography. Do not hand-roll styling if primitives exist.
- **Charting library** — use whatever charting lib is already a dependency (Recharts, Chart.js, ECharts, visx, etc.). Do **not** add a new one. If none exists, use lightweight inline SVG sparklines/bars rather than pulling in a library.
- **Firebase SDK** — this spec assumes the **Firebase Web SDK v9 modular API**. Confirm the version in use and match it. If the app is on a different Firestore client, translate the query semantics faithfully (aggregation `count()`, realtime `onSnapshot`, one-time `getDoc`).

Locate the existing Firebase initialization module and extend it (see §Data Access Layer) — do not create a second competing init.

---

## 1. Purpose & the two-database note

The screen answers, at a glance: *Is the pipeline armed and draining? How much work is backed up right now? What broke today, and why? What are the throughput/turnaround trends?*

**The screen reads from TWO Firestore databases in the same GCP project:**

| Handle | Database ID | Holds |
|---|---|---|
| **default** | `firestore` (the app's default DB) | `classify/pod_worker`, all `scope_enhancement_atc_usage_*` rollup/gauge/dropoff collections |
| **atc** | `firestore-atc` (a **named** Firestore database) | `queue_atc_generation` — the raw job queue (source of truth for live tiles) |

Because `firestore-atc` is a *named* database, you must obtain a **second `Firestore` handle** pointed at it (Web SDK v9: `getFirestore(app, 'firestore-atc')`). Every read below is tagged **[default]** or **[atc]** — route it to the correct handle.

**Cadence discipline (critical):**
- **Live tiles** → read raw `queue_atc_generation` via `count()` aggregation + `classify/pod_worker` via realtime listener.
- **Trends / history** → read the nightly rollup docs `_daily` / `_lifetime`.
- **Breaks (never-created)** → read `_dropoffs`.
- **Backlog trend** → read the hourly `_backlog` gauge docs.

Never source a live tile from an hourly/nightly rollup, and never source a trend from a raw `count()`.

---

## 2. Panel-by-panel spec

> **IST day boundary:** several live tiles window on "today in IST" (Asia/Kolkata, UTC+05:30). Compute `todayStartIST` = midnight IST converted to a Firestore `Timestamp`, and `todayIST` = the `YYYY-MM-DD` string in IST. Centralize this in one helper; do not use the browser's local midnight.

### Panel A — Pod status tile  **[default] · realtime listener**
- **Source:** `classify/pod_worker` (single doc, collection `classify`, doc id `pod_worker`).
- **Read mechanism:** `onSnapshot` realtime listener.
- **Fields rendered:**
  - `enabled` (bool) — headline armed/disarmed indicator. `false` ⇒ lifecycle is a no-op, nothing drains.
  - `state` (string, one of `IDLE` | `LOADING` | `READY` | `TERMINATING` | `HALTED`) — status badge.
  - `haltedReason` (string) + `halted` (bool) — show prominently when `halted===true` ("needs manual reset").
  - `podid` (string) — current RunPod pod id.
  - `gpu` (`{gpu, count}` map) — render as e.g. `2× A100`.
  - Secondary/optional: `apiUrl`, `model`, `CONFIG_ID`, `workerRunning` (bool), `currentJobPath`, `launchError` (show if non-empty, it is a soft error).
- **Cadence:** real-time.

### Panel B — Data-incomplete NOW (actionable)  **[atc] · count() realtime + drill-in getDocs**
- **Source:** `queue_atc_generation`, `where('status','==','dataincomplete')`.
- **Read mechanism:** aggregation **`count()`** for the tile number; refresh on an interval or re-run when the screen is focused (aggregation queries are not realtime — see §Refresh below).
- **Meaning:** doc was created but is blocked on missing **mandatory / atleastonerequired pairing** data (distinct from "breaks" in Panel F, which are never-created).
- **Drill-in:** on expand, run `getDocs` of the same query (cap with `limit`, e.g. 50) and for each doc read the **`stagedata`** map:
  - `stagedata` shape: `stagename → { data, category, status, type, queueid, queuetokenid }`.
  - `category` ∈ `own` | `mandatory` | `atleastonerequired`; `status` ∈ `resolved` | `missing`.
  - List the stages where `status==='missing'` so the operator sees exactly *which* pairing stage is missing. Also surface `profileid`, `stage`, `createdAt`.
- **Actionable affordance:** each drill-in row is the target of the existing `regenerateAtcDoc` action (wire to the existing callable/handler if present; otherwise render the row and leave a clearly-marked hook). Do not implement a new backend.
- **Cadence:** live (count refreshed on interval; drill-in on demand).

### Panel C — Backlog (pending / processing now)  **[atc] · count() realtime**
- **Source:** `queue_atc_generation`.
- **Read mechanism:** two `count()` aggregation queries:
  - Pending now: `where('status','==','pending')`.
  - In-flight: `where('status','==','processing')`.
- **Also render Oldest-pending age:** `where('status','==','pending')` `orderBy('createdAt','asc')` `limit(1)`, then compute `now − createdAt` (minutes). One-time/interval read.
- **Fields:** the two counts + oldest-pending-age-minutes.
- **Cadence:** live.

### Panel D — Stuck now  **[atc] · count() realtime**
- **Source:** `queue_atc_generation`.
- **Read mechanism:** `count()` on `where('status','==','processing')` `and where('startedAt','<=', Timestamp(now − 30min))`. (Composite condition — a matching Firestore composite index on `status` + `startedAt` may be required; note this in the acceptance checks and surface a clear console/UI error if the index is missing.)
- **Fields:** the stuck count. Style as a warning when `> 0`.
- **Cadence:** live.

### Panel E — Done / errors TODAY  **[atc] · count() realtime**
- **Source:** `queue_atc_generation`, windowed on `finalizedAt >= todayStartIST` (`finalizedAt` is set on both `completed` and `error`).
- **Read mechanism:** two `count()` queries splitting by `status`:
  - Done today: `where('finalizedAt','>=',todayStartIST)` `and where('status','==','completed')`.
  - Errors today: `where('finalizedAt','>=',todayStartIST)` `and where('status','==','error')`.
- **Fields:** two counts (done, errors). May require a composite index on `finalizedAt` + `status`.
- **Cadence:** live.

### Panel F — Breaks / never-created (drop-offs)  **[default] · realtime listener**
- **Source:** `scope_enhancement_atc_usage_dropoffs/{YYYY-MM-DD}` — doc id = **`todayIST`**.
- **Read mechanism:** `onSnapshot` on that single day-doc (it's updated per-event, so realtime is appropriate).
- **Fields rendered:**
  - `total` (number) — headline drop-offs today.
  - `byStage` (map `{ S0, S1 }`).
  - `byReason` (map) — breakdown bars/list. Reasons:
    - **S0:** `generateatc_false`, `no_form_submission`, `no_studio_session`, `no_liveassignment`, `no_zoom_meeting`, `transcript_fetch_failed`, `unknown_stage_type`.
    - **S1:** `atcprompts_missing`, `no_stagedata`, `no_resolved_stages`.
  - `lastReason` (string) + `lastExtra` (`{ profileid, queueTokenId, stage, docid }`) — "most recent break" debug line.
- **Meaning note (render as help text):** a *break* means only the **own-stage** source was unresolvable (nothing to generate from → no doc created). Missing *pairing* data does NOT break — it produces a `dataincomplete` doc (Panel B). Keep these two panels visually distinct.
- **Cadence:** live (per-event).

### Panel G — Backlog trend  **[default] · hourly gauge docs, one-time read**
- **Source:** `scope_enhancement_atc_usage_backlog/{YYYY-MM-DD}` for a trailing window (e.g. last 7–14 days) for the chart, plus `scope_enhancement_atc_usage_backlog/latest` for the newest sample.
- **Read mechanism:** `getDoc`/`getDocs` (one-time, refresh hourly-ish or on manual refresh — the writer, `atcJobWatchdog`, only samples hourly, so more frequent reads are wasted).
- **Fields per doc:** `pendingCount`, `processingCount`, `stuckCount`, `dataincompleteCount`, `oldestPendingAgeMin`, `podState`, `sampledAt` (ts), `collectionName`.
- **Render:** multi-series line/area over `sampledAt` (pending / processing / stuck / dataincomplete). The `latest` doc feeds a small "as-of `sampledAt`" caption.
- **Cadence:** hourly.

### Panel H — Daily throughput / turnaround  **[default] · nightly rollup, one-time read**
- **Source:** `scope_enhancement_atc_usage_daily/{YYYY-MM-DD}_{profileid|__ALL}`. For the org-wide chart use doc ids `{date}___ALL` (the `__ALL` suffix, note the double underscore inside `_{__ALL}`) across the trailing window. Per-coach views substitute a `profileid`.
- **Read mechanism:** `getDocs` over the date range (one-time; data changes only at the nightly 01:00 IST rollup).
- **Fields per doc:** `date`, `profileid`, `total`, `completed`, `failed`, `retried`, `turnaroundMsSum`, `turnaroundCount`, `byType` (map per `type` → `{total,completed,failed,retried,turnaroundMsSum,turnaroundCount}`), `byFailure` (map `{failureCategory: n}`).
- **Render:**
  - Throughput chart: `completed` / `failed` / `total` per `date`.
  - **Avg turnaround** per day = `turnaroundMsSum / turnaroundCount` (guard divide-by-zero → show "—"). Completed-only.
  - Optional `byType` split (form vs zoom).
- **Cadence:** nightly.

### Panel I — Lifetime totals  **[default] · nightly incremental, one-time read**
- **Source:** `scope_enhancement_atc_usage_lifetime/__ALL` (org-wide). Per-coach = `scope_enhancement_atc_usage_lifetime/{profileid}`.
- **Read mechanism:** `getDoc` (one-time).
- **Fields:** same metric set as daily (`total`, `completed`, `failed`, `retried`, `turnaroundMsSum`, `turnaroundCount`, `byType`, `byFailure`) **plus** `firstSeen`, `lastUpdated`.
- **Render:** headline KPI row (lifetime total / completed / failed, lifetime avg turnaround = `turnaroundMsSum/turnaroundCount`, "since `firstSeen`", "updated `lastUpdated`").
- **Cadence:** nightly.

### Panel J — Error breakdown by `failureCategory`  **[default] nightly OR [atc] live**
- **Primary source (trend):** `_daily.byFailure` aggregated across the window (and/or `_lifetime.byFailure`).
- **Optional live source (today):** `queue_atc_generation` `where('status','==','error')` grouped by `failureCategory` — read via `getDocs` (cap with `limit`) and tally client-side, OR per-category `count()` queries.
- **Categories (exact set — do not add):** `infer_timeout`, `infer_error`, `empty_output`, `bad_json`, `pod_unavailable`, `max_attempts`, `unknown`. (`failureCategory` may be `null` when not an error.)
- **Render:** horizontal bar / breakdown of counts per category.
- **Cadence:** nightly (trend) or live (today's).

> **Do NOT build a conversion/funnel metric.** Per the contract, `dataincomplete` is non-terminal and intentionally excluded from `_daily`/`_lifetime` (those window on `finalizedAt`). There is no "dataincomplete → completed conversion" data available. Do not fabricate one.

---

## 3. Per-panel loading / empty / error / zero states

Implement all four states for every panel:

- **Loading:** skeleton/spinner in the tile or chart area; never a blank flash. Realtime listeners show loading only until first snapshot.
- **Empty / missing doc:** many day-docs legitimately don't exist yet.
  - `_dropoffs/{today}`, `_backlog/{today}`, `_daily/{today}___ALL`, `_lifetime/__ALL` may not exist → render a **neutral "no data yet"** zero-state (e.g. `total: 0`, empty breakdown), **not** an error. `getDoc(...).exists() === false` is normal.
  - Live `count()` returning `0` is a valid state → render `0`, not empty.
- **Error:** distinguish a genuine read failure (permissions, missing composite index, network) from an empty doc. Show a small inline error with a retry affordance; log the underlying error. A missing composite index (Panels D, E) must surface a clear, actionable message.
- **Zero-state caveat (render as a dashboard-level banner or per-panel note):** **throughput, error, and turnaround stay at zero until production is armed** (`classify/pod_worker.enabled === true`) so that jobs actually drain to a terminal state. When `pod_worker.enabled === false`, show a banner like *"Pipeline not armed — throughput/turnaround will read zero. Drop-offs and live queue counts still populate."* Drop-offs (F) and live raw-queue tiles (B–E) populate regardless of armed state.

---

## 4. Data-access layer spec

Centralize **all** Firestore reads in one service/hooks module (e.g. `atcDashboard.data.ts` + a set of hooks). No Firestore calls inline in components.

**Firebase handles (Web SDK v9 modular):**
```
import { getFirestore } from 'firebase/firestore';
const app = /* existing initialized app */;
const dbDefault = getFirestore(app);                 // firestore
const dbAtc     = getFirestore(app, 'firestore-atc'); // NAMED database
```
Extend the app's existing Firebase init module; export both handles from there. Do not re-initialize the app.

**Expose one function/hook per panel**, each returning `{ data, loading, error }` (or your app's existing async-state convention). Suggested surface:

- `subscribePodWorker(cb)` → `onSnapshot(doc(dbDefault,'classify','pod_worker'))`.
- `subscribeDropoffsToday(cb)` → `onSnapshot(doc(dbDefault,'scope_enhancement_atc_usage_dropoffs', todayIST))`.
- `getDataIncompleteCount()` → `getCountFromServer(query(collection(dbAtc,'queue_atc_generation'), where('status','==','dataincomplete')))`.
- `listDataIncomplete(limitN)` → `getDocs(...)` returning docs incl. `stagedata`.
- `getBacklogCounts()` → parallel `getCountFromServer` for pending & processing.
- `getOldestPending()` → `getDocs(query(..., where status==pending, orderBy createdAt asc, limit 1))`.
- `getStuckCount()` → `count()` with `status==processing` + `startedAt <= now-30m`.
- `getTodayDoneErrorCounts()` → two `count()` on `finalizedAt >= todayStartIST` split by status.
- `getBacklogTrend(days)` / `getBacklogLatest()` → `getDocs` / `getDoc` on `_backlog`.
- `getDailyRollups(days, profileid='__ALL')` → `getDocs` on `_daily/{date}_{profileid}`.
- `getLifetime(profileid='__ALL')` → `getDoc` on `_lifetime/{profileid}`.
- `getErrorBreakdown(...)` → from `_daily.byFailure` (trend) and/or live `status==error`.

**Conventions to enforce in the layer:**
- Use `getCountFromServer` (aggregation) for all count tiles — never `getDocs().size`.
- Tag every call's DB handle explicitly; a query built against the wrong handle is a silent bug.
- Realtime hooks (`onSnapshot`) MUST return/clean up their unsubscribe on unmount.
- Aggregation/one-time reads are **not** realtime — drive them from a single shared refresh mechanism (see below), not per-component intervals.
- Centralize the IST-day helpers (`todayIST` string, `todayStartIST` Timestamp) here.
- Normalize Firestore `Timestamp` → JS `Date`/millis at the edge of this layer so components never touch raw Timestamps.

**Refresh mechanism:** provide one dashboard-level refresh (auto every N seconds for live count tiles — e.g. 15–30s — plus a manual "Refresh" button and refresh-on-focus). Live count/one-time reads re-run on that tick; hourly `_backlog` and nightly `_daily`/`_lifetime` reads run once on mount + manual refresh only (do not poll them fast). Listeners (`pod_worker`, `_dropoffs`) update themselves.

---

## 5. Layout guidance

- **Top row — live tiles, most prominent** (these are the "is it healthy right now" signals): Pod status (A), Data-incomplete-now (B), Backlog pending+processing (C), Stuck-now (D), Done/Errors today (E), Breaks-today (F). Compact KPI tiles in a responsive grid. Use warning/critical color tokens for Stuck>0, Halted pod, and error counts.
- **Armed banner** across the top when `pod_worker.enabled===false` (see §3).
- **Second section — trends (charts):** Backlog trend (G), Daily throughput + turnaround (H), Error breakdown (J). Use the existing charting lib.
- **Headline strip / footer — Lifetime totals (I)** as a KPI row.
- **Drill-in** for Data-incomplete (B): expandable panel or side drawer listing blocked docs with their missing stages + regenerate action.
- Respect existing responsive breakpoints, card components, and design tokens. Live tiles should be scannable in under a second.

---

## 6. Acceptance checks

- [ ] Two distinct Firestore handles exist; `queue_atc_generation` reads hit `firestore-atc`, everything else hits default. No cross-wired queries.
- [ ] Pod status tile updates in real time via `onSnapshot`; halted/disarmed states are visually obvious.
- [ ] Data-incomplete tile uses `getCountFromServer`; drill-in reads `stagedata` and lists the exact stages where `status==='missing'` with their `category`.
- [ ] Backlog, Stuck, Done/Errors-today tiles use aggregation `count()` (not `.size`), windowed correctly; IST midnight (not browser-local) drives "today".
- [ ] Breaks panel reads `_dropoffs/{todayIST}` and renders `total` + `byReason` + `byStage` + `lastReason/lastExtra`; a missing doc shows a zero-state, not an error.
- [ ] Backlog trend reads `_backlog` day-docs + `latest`; charts pending/processing/stuck/dataincomplete over `sampledAt`.
- [ ] Daily panel reads `_daily/{date}___ALL`; turnaround = `turnaroundMsSum/turnaroundCount` with divide-by-zero guarded.
- [ ] Lifetime reads `_lifetime/__ALL`; shows `firstSeen`/`lastUpdated`.
- [ ] Error breakdown uses only the 7 allowed `failureCategory` values.
- [ ] Every panel implements loading / empty (missing doc) / error / zero states; missing day-docs are treated as zero, not failure.
- [ ] Armed-state banner appears when `pod_worker.enabled===false`, and throughput/turnaround zero-state is explained.
- [ ] Composite-index requirements (Panels D, E) verified in the target project; missing-index errors surface a clear message.
- [ ] No new framework/UI/charting dependency introduced; screen matches existing components, tokens, and router.
- [ ] All Firestore access lives in the single data-access module; listeners clean up on unmount; no fast polling of hourly/nightly sources.
- [ ] No invented fields, statuses, collections, or a conversion/funnel metric.
