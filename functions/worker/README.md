# ATC drain worker — Cloud Run Job

`drain.js` is the long-running worker (NOT a cloud function). It is started by
`podWorkerUpdate` when the pod reports `ready`, drains all pending jobs through
the pod's `/infer`, then exits. A Cloud Run Job can run for hours (no 60-min
function cap).

## Loop / no-reprocessing guarantees
- one execution per start (the process exits when drained → deploy with
  `--max-retries=0` so a crashed execution is NOT auto-retried);
- `claimNextJob` moves `pending→processing` (a job is handed out once);
- a failed inference is requeued with an **attempts cap** (`requeueJob`) → after
  `maxAttempts` (default 3) the job becomes `error` and leaves the pending pool;
- the loop ends the moment `claimNextJob` returns `null`.

## State / config doc — `classify/pod_worker` (default DB)
Read by the worker: `state`, `podid`, `apiUrl`, `bearerToken`,
`FIREBASE_COLLECTION_NAME`, `maxAttempts`, `model`.
Written by the worker: `currentJobPath`, `workerRunning`.

## Pending wiring (before this runs for real)
1. **`/infer` contract** — fill `callInfer()` request/response shape + auth.
2. **`INFER_TIMEOUT_MS`** — set to ≥ max single-inference time.
3. **Terminate** — call `POD_TERMINATE_URL` at end of `main()` (or let the
   cloud function terminate on `workerRunning=false` + drained).
4. **Singleton start** — `triggerWorkerJob()` in `pod_worker.js` must call the
   Cloud Run Jobs API (`.../jobs/<name>:run`); set `WORKER_JOB_NAME` /
   `WORKER_REGION` in the config doc.

## Deploy (sketch)
```
gcloud run jobs deploy atc-drain-worker \
  --source . \
  --region <region> \
  --max-retries 0 \
  --task-timeout 24h \
  --set-env-vars INFER_TIMEOUT_MS=1200000
```
