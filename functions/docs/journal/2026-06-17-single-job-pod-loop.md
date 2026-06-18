# Journal — Single-job pod loop (worker-owned) + ownership guard

**Date:** 2026-06-17
**Status:** PARTIAL — claim/guard shipped; create/terminate endpoint wiring pending URLs
**Area:** `functions/components/runpod_ai.js`

## Decisions (locked with product owner)

1. **Worker self-loops.** The pod owns the loop: claim → infer → submit → claim,
   repeating until `getJobRequest` returns `{jobs:[]}`, then it calls
   `terminatePod`. The cloud functions no longer drive the loop.
2. **Worker self-starts on health-ready.** Model load takes **10–20 min** after
   pod create; the worker polls its own `/health` and starts pulling jobs itself
   once the model is loaded. Functions never poll or trigger.
3. **Pod create returns the RunPod `podid`** (create endpoint on a separate
   project, HTTP). **Terminate** is a separate HTTP endpoint on that project:
   send `{podid}` → it terminates → on success we clear `llmmodels.podid`.

## Why single-job

The pod loads the model with the **full context window** and can process only
ONE request at a time — batching is not feasible. The old loop claimed up to 100
jobs at once (`getJobRequest` `.limit(100)`), marking all 100 `processing` with
`startedAt=now`; with one-at-a-time consumption, 99 sat "processing" but unstarted
and the 30-min watchdog would wrongly requeue them. Single-job claim aligns the
queue state with real consumption.

## Shipped this change

- **`claimNextJob`** (new, exported for tests) — transactional FIFO claim of the
  single oldest pending job (`orderBy createdAt asc, limit 1`). Concurrent pods
  are safe (one TXN retries, never double-claims). `getJobRequest` now wraps it
  and returns `{jobs:[1]}` or `{jobs:[]}` (the drain signal).
- **`writeJobResult`** (new, exported) — ownership-guarded write: persists only
  if the doc is still `processing` AND `claimedBy===podId`. `submitJobResult`
  now wraps it and **no longer does lifecycle dispatch** (no re-trigger, no
  terminate) — the worker owns that. This is option (3) "ownership guard" from
  [[2026-06-15-watchdog-live-pod-requeue]], now SHIPPED.
- **`triggerProcess` deleted** (function + all calls in `ensurePod`). The
  `{podid}-8000.proxy.runpod.net/process` mechanism is gone; the worker
  self-starts.
- Tests: `test/integration/podloop.test.js` (8) — FIFO claim, no-double-claim
  across concurrent pods, drain→null, ownership guard rejects foreign/late/
  already-completed writes, empty-output failure flag.

## Still pending (needs the two endpoint URLs)

- **`ensurePod`** — swap RunPod-REST list/create for the create endpoint;
  reuse = trust stored `podid` as source of truth (no list-API race → fixes the
  duplicate-pod-during-load-window gap G1). Add `POD_CREATE_URL` to config.
- **`doTerminatePod`** — swap RunPod DELETE for the terminate endpoint
  (`POST {podid}`, treat 404/already-gone as success), keep orphan sweep +
  `llmmodels.podid` clear. Add `POD_TERMINATE_URL` to config.

## Open risk still tracked

- **G5** — if one full-context inference can exceed `stuckProcessingMinutes`
  (30), the watchdog still requeues the single live job (now bounded to 1, and
  the ownership guard prevents a double-write). Confirm max single-job time < 30m
  or add a heartbeat. See [[2026-06-15-watchdog-live-pod-requeue]] option (1).
- **Prod config absent** — `classify/pod_scheduler` does not exist in prod, so
  the whole loop is a silent no-op until it's created (with `podtemplateid`,
  `FIREBASE_FETCH_URL`, `FIREBASE_SUBMIT_URL`, and the new create/terminate URLs).

## Update (same day) — redesign: pod = inference server, worker = Cloud Run Job

The "worker self-loops inside the pod" model was replaced after clarifying the
pod actually behaves as a dumb **inference server**:

- **create** loads the model (10–20m) and returns `{podid, apiUrl, bearerToken}`.
- readiness is **push-based**: the GPU side calls our new endpoint
  `podWorkerUpdate` with `event:"ready"` / `"unhealthy"` (no polling).
- the long **drain** (can run >1h) is a **Cloud Run JOB**, not a function
  (functions cap at 60m). Started only when ready AND pending>0 AND no worker
  already running (singleton).
- failure policy: **requeue + alert + HALT** (no auto-recreate; human resets).
- config + state **merged** into one doc `classify/pod_worker`.

### Scaffold shipped
- `components/pod_jobs.js` — shared data layer (no firebase-functions):
  `claimNextJob`, `writeJobResult`, **`requeueJob` (attempts cap)** so the drain
  loop can never reprocess the same job forever. `runpod_ai.js` now imports these.
- `components/pod_worker.js` — `podWorkerUpdate` onRequest endpoint + `markReady`
  / `markUnhealthy` state transitions + `STATES`/`WORKER_DOC`. Exported in
  `index.js`.
- `worker/drain.js` + `worker/README.md` — Cloud Run Job skeleton (drain loop,
  `/infer` stubbed behind a clear contract, terminate TODO).
- tests: `podworker.test.js` (6) + requeue cases in `podloop.test.js` (4).
  Totals now 16 unit + 38 integration.

### Still pending (URLs / contract)
1. `/infer` request+response shape + auth + max inference time (`callInfer`).
2. create endpoint URL/response → wire into `ensurePod` (or a LAUNCHING step).
3. terminate endpoint URL → `terminateAndReset` / `doTerminatePod`.
4. `triggerWorkerJob` → Cloud Run Jobs API (`WORKER_JOB_NAME`/`WORKER_REGION`).
5. fold `atcPodScheduler`/`atcJobWatchdog` config reads onto `pod_worker` doc.
