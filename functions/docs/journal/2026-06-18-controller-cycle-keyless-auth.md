# Journal — Full pod cycle wired to the external controller + keyless auth

**Date:** 2026-06-18
**Status:** CODE COMPLETE — full launch→ready→drain→terminate cycle wired & tested; remaining work is deploy-time only (IAM + config + drain Job deploy)
**Area:** `functions/components/pod_controller.js` (new), `pod_worker.js`, `worker/drain.js`, `runpod_ai.js`, `index.js`, `workflow.json`

## Context

[[2026-06-17-single-job-pod-loop]] left the pod = dumb inference server + Cloud Run
drain Job design with the external endpoints **stubbed**. This change resolves the
stubs against the REAL controller (`ei_ai/vllm-controller-firebase`, project
`ai-project-4e149`) — contracts confirmed by exploring that repo and verified live.

## Decisions (locked)

1. **Controller path is the live one; the in-pod self-loop is retired.** Pod
   creation/termination + inference go through the external controller, not the
   RunPod-direct `ensurePod`/`doTerminatePod` or the `getJobRequest`/`submitJobResult`
   self-loop. Those are un-exported from `index.js` (kept in `runpod_ai.js` for rollback).
2. **Controller auth = self-minted Firebase deployer ID token, KEYLESS.** The
   controller's `require_deployer` only trusts a Firebase ID token w/ claims
   `approved:true` + role `poddeployer`/`admin`. We mint one:
   `createCustomToken({approved,role})` → `signInWithCustomToken(webApiKey)` → idToken
   (cached ~1h). **No service-account key is stored**: the functions runtime SA
   impersonates a dedicated role-less signer SA `pod-token-minter@ai-project-4e149`
   via IAM `signBlob` (`applicationDefault()` + `serviceAccountId`). Chosen over a
   stored SA key because a leaked key = full controller-project access; the keyless
   binding grants only "mint controller tokens".
3. **State machine clock = `atcPodLifecycle` (every 2 min).** IDLE→launch gate
   (batched `shouldStartPod`), LOADING→`/health` poll→ready. Drain Job signals
   completion back to the function (which holds the deployer creds) — the Job never
   touches controller credentials.

## Contracts resolved (controller, project ai-project-4e149)

- `launchPod({config_id})` → `{pod_id, public_url, gpu_used}`; one-pod-per-config
  lock (FAILED_PRECONDITION), per-user cooldown (RESOURCE_EXHAUSTED).
- `getPodBearer({pod_id})` → `{bearer_token}` (inference bearer, fetched on ready).
- `terminatePod({pod_id})` → `{pod_id, cost_usd}`; NOT_FOUND = already gone (idempotent).
- inference: `POST {public_url}/v1/chat/completions` Bearer → OpenAI
  `{choices[0].message.content, finish_reason}` + `usage.total_tokens`.
- readiness: `GET {public_url}/health` (unauthenticated).
- The controller has its OWN idle watchdog (server-side reap) — a safety net behind
  our terminate.

## Shipped this change

- **`components/pod_controller.js`** (new) — keyless deployer-token minter (cached)
  + `launchPod`/`getPodBearer`/`terminatePod` with `{data}`/`{result}` handling and
  tagged controller error statuses.
- **`pod_worker.js`** — `launchAndLoad` (IDLE→LOADING via launchPod), `podHealthy`,
  `advanceToReady` (getPodBearer→markReady→start/terminate), real `triggerWorkerJob`
  (Cloud Run Jobs `:run` via metadata token), `terminateAndReset` (controller
  `terminatePod`), `atcPodLifecycle` scheduler + load-timeout HALT, `drained` event.
- **`worker/drain.js`** — `callInfer` → `/v1/chat/completions`; `signalDrained` POSTs
  `podWorkerUpdate {event:"drained"}` (env `PODWORKER_UPDATE_URL` + `FUNCTIONS_SHARED_SECRET`).
- **`runpod_ai.js`** — watchdog liveness now reads `classify/pod_worker` state (not
  `llmmodels`). `ensurePod`/`doTerminatePod`/job HTTP/`atcPodScheduler` retired.
- **`index.js`** — exports `atcPodLifecycle`; legacy exports commented out.
- **`workflow.json`** — restored (was missing from the dev branch) + updated to the
  controller path; 21/26 nodes done; `pending[]` = deploy-time only.

## Verified

- **Live auth chain** against the real controller: minted token passed
  `require_deployer` (getPodBearer returned 500 INTERNAL on a bogus pod id — i.e.
  *past* auth, not 401/403). No pod launched; read-only probe only.
- **35 unit + 44 integration + 6 invariants — green.** Integration ran on an
  ISOLATED emulator (port 8085) so the dev 8080 emulator data was untouched
  (see [[integration-tests-emulator-port]]).

## Still pending (deploy-time only — see `workflow.json.pending`)

1. **Keyless IAM** (ai-project-4e149, by an IAM admin): create role-less
   `pod-token-minter@ai-project-4e149`; grant the starlabs functions runtime SA
   `roles/iam.serviceAccountTokenCreator` on it.
2. **Fill `classify/pod_worker`**: `CONFIG_ID`, `WORKER_JOB_NAME`/`WORKER_REGION`,
   `model`, `FIREBASE_COLLECTION_NAME`, `SLACK_WEBHOOK_URL`.
3. **Deploy the drain Job** (`gcloud run jobs deploy atc-drain-worker … --max-retries 0`).
4. **Grant** the runtime SA `run.jobs.run` on the drain Job.
5. OPTIONAL: point the controller's ready webhook at `podWorkerUpdate` (the
   `/health` poll already covers readiness); delete retired `runpod_ai.js` code once
   the controller path is proven in prod.
