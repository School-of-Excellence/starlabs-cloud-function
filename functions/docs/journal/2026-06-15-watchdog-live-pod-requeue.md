# Journal — Watchdog requeues `processing` jobs without checking for a live pod

**Date:** 2026-06-15
**Status:** DEFERRED (to be addressed alongside the pod run-process work)
**Area:** `functions/components/runpod_ai.js` → `atcJobWatchdog` (branch 1), `getJobRequest`, `submitJobResult`

## The problem

`atcJobWatchdog` requeues stuck jobs using a single condition — there is **no
check for whether a pod is alive and still working on the job**:

```js
// atcJobWatchdog, branch 1
const cutoff = new Date(Date.now() - stuckMin * 60000);   // stuckMin = 30 (default)
const stuckSnap = await atcDb.collection(collectionName)
  .where("status", "==", "processing")
  .where("startedAt", "<=", cutoff)          // <-- the ONLY condition
  .get();
// → resets every match to status:"pending" (drops claimedBy/startedAt)
```

No `podid` check, no liveness check, no `claimedBy` ownership check. Any job in
`processing` longer than `stuckProcessingMinutes` (30m default) is reset to
`pending` — **even if the assigned pod is alive and legitimately still
generating** (long transcript / big prompt / slow GPU tier).

`submitJobResult` compounds it: it writes the result **unconditionally**
(`batch.set(doc, {status:"completed", output...}, {merge:true})`) with no guard
that the doc is still `processing` or still owned by that pod. `getJobRequest`
likewise re-claims any `pending` doc with no in-flight-duplicate guard.

### Race

```
t=0     Pod A claims J → processing, claimedBy=A, startedAt=0
t=0..35 J is a long job; Pod A is STILL working on it
t=30    watchdog: startedAt ≤ now-30 → resets J to "pending"        ⚠ false positive
t≈hh    atcPodScheduler (hourly) re-flushes → reuses Pod A → J re-claimed → processed twice
t=35    Pod A finishes original run → submitJobResult writes completed (unconditional)
        ...re-claimed run later finishes → writes completed AGAIN
```

**Impact:** wasted GPU (job runs twice) and the doc flips `processing→completed`
twice, firing `onQueueAtcGenerationUpdate` twice. Correctness of downstream
artifacts IS currently saved by the Stage-2 / Stage-3 **dedup guards**
(sourceref+type / queueref+profileid+queue_token_id+stage+type) — so no duplicate
checkpoint/rubrics docs — but the duplicate processing/work is real.

The 30-minute threshold is the only thing protecting a live slow job; it is safe
only if **no legitimate job ever runs longer than `stuckProcessingMinutes`**.

## Fix options (decide when we do the pod run-process work)

1. **Heartbeat (most correct).** Pod stamps `heartbeatAt` on its in-flight docs
   every ~60s. Watchdog requeues only when `heartbeatAt` is stale, not when
   `startedAt` is old. Distinguishes "slow but alive" from "dead" regardless of
   job length. Requires a small change in the pod worker (the script calling
   `getJobRequest`/`submitJobResult`).
2. **Pod-status check (no worker change).** Before requeuing, watchdog looks up
   the template `podid` / job `claimedBy` and calls RunPod `get-pod`. Pod gone or
   exited → requeue; still running → leave it. Still needs a long timeout
   fallback for a hung-but-not-dead pod.
3. **Ownership guard (defense in depth, runpod_ai.js only).** `getJobRequest`
   claims via a transaction; `submitJobResult` writes only if the doc is still
   `processing` AND `claimedBy === podId`. Doesn't prevent the bad requeue but
   stops the double-processing fallout.

**Recommendation:** (1) heartbeat as primary + (3) ownership guard as a cheap
safety net. If the pod worker image is out of this repo, do (2)+(3) here now and
leave the heartbeat field documented for the worker.

## Related change shipped same day (2026-06-15)

To reduce pod churn while this is deferred, `atcPodScheduler` was moved from
`every 2 minutes` to `every 1 hours`, and `DEFAULT_FLUSH_WAIT_MINUTES` from `15`
to `120` (2h). Note `flushWaitMinutes` is shared: the watchdog's branch-2
"backlog not draining" alert now also uses the 2h window. The branch-1 requeue
issue described above is **unchanged** by that and remains open.
