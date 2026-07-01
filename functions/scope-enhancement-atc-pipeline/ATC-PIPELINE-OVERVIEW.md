# ATC Pipeline — Full Scope Overview

> **Purpose of this doc:** a single shareable reference so a new engineer or stakeholder can
> understand the whole ATC generation pipeline as it runs in **production today**.
> It is layered: **Part 1** is a plain-language overview (no code needed); **Part 2** is the
> technical deep-dive; **Part 3** is the operational runbook (how to keep it healthy).
>
> Project: `starlabs-cloud-function` · Prod GCP project: `fir-sample-aae4a` (region `us-central1`,
> rollup in `asia-south1`). Last reviewed: **2026-06-25**.

---

# Part 1 — The Plain-Language Overview

## What is this pipeline?

It **automatically generates ATC reports** (the AI-written coaching analysis a coach receives after
a session) instead of producing them by hand. When a learner crosses a stage in their program —
either by submitting a **form** or completing a **Zoom** coaching session — the system gathers the
input, asks a large language model (LLM) to write the ATC, and stores the result.

Think of it as an **assembly line** with four working stations:

```
  Learner crosses a stage
          │
          ▼
  ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
  │  1. INPUT (S0)  │ → │ 2. GENERATE(S1) │ → │  3. AI INFERENCE│ → │  4. USAGE/      │
  │  gather form or │   │  build the LLM  │   │  a GPU pod runs │   │  TELEMETRY      │
  │  zoom transcript│   │  prompt, queue  │   │  the model,     │   │  count what was │
  │                 │   │  a "job"        │   │  writes the ATC │   │  done / dropped │
  └─────────────────┘   └─────────────────┘   └─────────────────┘   └─────────────────┘
```

1. **Input (Stage 0)** — detects the stage crossing, fetches the form submission or the Zoom
   transcript, and creates a "job" document describing what to generate.
2. **Generate (Stage 1)** — builds the actual LLM prompt and marks the job as **pending** (ready to run).
3. **AI inference (the pod loop)** — when enough work has piled up, the system rents a **GPU pod**
   (a powerful cloud machine), loads the model, runs every pending job through it, writes the
   results, and then **shuts the pod down to save money**.
4. **Usage / telemetry** — records what got produced, what failed (and why), and what was **never
   even created** (dropped at an earlier gate), so a dashboard can show the health of the pipeline.

## Current scope — what's live vs on hold

The pipeline was designed with more stages than are currently switched on. **As of 2026-06-24 the
production scope was deliberately narrowed** to the generation path only:

| Stage | What it does | Status in prod |
|---|---|---|
| **S0 — Input** | Detect crossing, fetch form/zoom, create job | ✅ **Live** |
| **S1 — Generate** | Build prompt, queue pending job | ✅ **Live** |
| **Pod loop** | Run the model, write the ATC | ✅ **Live** (armed 2026-06-24) |
| **Usage rollup + telemetry** | Daily metrics + drop-off/backlog capture | ✅ **Live** |
| **S2 — Checkpoint verify** | A second AI pass that checks the ATC | ⏸️ **On hold (deleted from prod)** |
| **S3A — Specialist assemble** | Combine specialist + AI ATC | ⏸️ **On hold (deleted from prod)** |
| **S3B — Rubrics scoring** | Score the result, produce a verdict | ⏸️ **On hold (deleted from prod)** |

So today, **production runs S0 → S1 → pod → usage rollup only.** S2/S3 code still exists in the repo
but the functions that trigger them were removed from prod; they can be restored by re-exporting and
redeploying.

## Status snapshot (2026-06-25)

- The pipeline is **armed** and has completed real production runs on the 120B model (60+ jobs, 0
  errors, ~12–15s per job).
- **Known caution:** the GPU pod is currently **HALTED** (it failed to load the model within the
  30-minute timeout on a prior launch). A halted pod does **not** restart on its own — see Part 3.
- Telemetry is **live and capturing** (drop-offs and backlog gauges are being written).

---

# Part 2 — The Technical Deep-Dive

## Architecture at a glance

**Two Firestore databases:**

| Database | Holds |
|---|---|
| **default** (`firestore`) | `classify/*` (config + pod state), `queue_token`, `procedures`, all `scope_enhancement_atc_usage_*` (dashboard data) |
| **`firestore-atc`** | `queue_atc_generation` (the job queue — source of truth), `atc_alpha` (specialist ATCs, S3 input) |

**One-line flow:** `form/zoom → [S1 generate] → pod drains pending → terminal job → nightly rollup`.
(The on-hold extension was: `→ [S2 verify] → (specialist uploads atc_alpha) → [S3A assemble] → [S3B rubrics → overall_verdict]`.)

All working job documents live in **`queue_atc_generation`** (firestore-atc). Each doc is one job and
moves through a status machine: `pending → processing → completed | error`.

## The stages in detail

### S0 — Input  ·  `components/queuesystem.js` → `onQueueStageChange` → `processStage`
- **The ONLY producer of generation docs in prod.** Fires when a `queue_token`'s `currentstage`
  changes; replays the crossed stage and creates job docs in `queue_atc_generation`
  (`type=form|zoom`, `generateatc`, pairing stages).
- **⚠️ No automatic recovery for missed docs.** The trigger has no retry, and its catch block does
  not rethrow. If the form/transcript isn't ready yet (especially **async Zoom transcripts** that
  arrive minutes-to-hours later), `processStage` early-returns and creates **no** doc — a permanent
  miss until a **manual backfill**. This is the single biggest correctness gap (see Part 3).

### S1 — Generate  ·  `components/queue_atc_generation.js` → `onQueueAtcGenerationCreate` → `processAtcGenerationDoc`
- **Gates:** `type ∈ {form, zoom}`, `generateatc == true`, and `classify/atcprompts` config exists
  (a missing config is **critical** — generation can't proceed).
- Builds the prompt from `prompt_1_ai_atc_generator.md`, writes
  `{ prompt, systemprompt, status: "pending", checkpoint: true }`.
- It does **not** call the pod directly (the old `callRunJobRequest` is commented out). The pod loop
  pulls pending jobs on its own schedule.

### S2 / S3 — On hold (code present, deleted from prod 2026-06-24)
- **S2 Verify** `onQueueAtcGenerationUpdate` → `processCheckpointVerificationDoc` — second AI pass;
  creates `type="checkpoint report"` jobs.
- **S2B Bridge** `maybeTriggerRubricsFromGeneration` — race handler that bridges into S3 when a
  specialist ATC already exists.
- **S3A Specialist** `components/ATC.js` `onAtcAlphaCreate` → `processAtcAlphaDoc` — assembles
  specialist + verified-AI ATC; creates `type="rubrics scoring"` jobs.
- **S3B Rubrics (terminal)** `extractAndSaveOverallVerdict` — parses the model output's
  `meta.overall_verdict` into an `overall_verdict` field. (Suspected to never fire even when live —
  an open finding.)
- **Why deleted, not just commented:** commenting out the exports (2026-06-23) did **not** remove the
  deployed functions (targeted deploys don't prune). They kept running until an explicit
  `firebase functions:delete onQueueAtcGenerationUpdate onAtcAlphaCreate --project production`.
  **Lesson: commenting an export ≠ removing the deployed function.**

## The pod loop (AI inference)  ·  `components/pod_worker.js`

A small state machine, stored as a **single document `classify/pod_worker`**, that rents a GPU pod
only when there's enough work and tears it down when done. It is driven by a scheduled function
**`atcPodLifecycle` (every 10 minutes)** plus server-to-server pushes to **`podWorkerUpdate`**.

```
  IDLE ──(pending ≥ minJobsToStartPod[20]  OR  oldest pending ≥ flushWaitMinutes;  gate: enabled==true)──▶ launchPod
   ▲                                                                                        │
   │                                                                                        ▼
   │                                                                                     LOADING ──(model loads > loadTimeoutMinutes[30])──▶ HALTED
   │                                                                                        │                                                  │
   │                                                                            (/health OK + getPodBearer)                            (manual reset needed)
   │                                                                                        ▼
   └──────────(queue empty → drain Job POSTs "drained" → terminatePod)◀── READY ──(drain loop: claim → infer → writeJobResult)
```

- **States:** `IDLE → LOADING → READY → (TERMINATING) → IDLE`; any failure → **`HALTED`**.
- **Arm switch:** the whole loop is a no-op unless `classify/pod_worker.enabled == true`. This lets
  you deploy/configure without auto-launching a costly pod.
- **`HALTED` is the failure parking state.** It requires a **human reset** and — critically —
  **`enabled` does NOT override `HALTED`** (see Part 3, the #1 gotcha).
- **External GPU controller** lives in a separate project, `ai-project-4e149`
  (`components/pod_controller.js`): `launchPod → {pod_id, public_url, gpu_used}`,
  `getPodBearer → {bearer_token}`, `terminatePod → {pod_id, cost_usd}`. Auth is **keyless** (the
  runtime SA impersonates a token-minter signer — no stored key). Controller errors are **soft**
  (never auto-HALT; a bad `CONFIG_ID` retries forever).
- **Prod config:** `CONFIG_ID 2Kkl…` = GPT_OSS_120B_ATC, model `gpt-oss-120b`, **2×H200**.

## The job state machine  ·  `components/pod_jobs.js`

```
  pending ──claimNextJob (atomic FIFO)──▶ processing ──writeJobResult──▶ completed (finalizedAt set)
                                              │
                                       pod failure → requeueJob
                                              │
                            attempts < 3 → back to pending
                            attempts ≥ 3 → error (TERMINAL, finalizedAt set)
```

- `finalizedAt` is stamped on **both** success and terminal failure — it's the field the usage
  rollup windows on.
- `classifyFailure` (in `se_atc_failure_classifier.js`) normalizes the cause into:
  `infer_timeout | infer_error | empty_output | bad_json | pod_unavailable | max_attempts | unknown`.

## Telemetry & the usage dashboard  ·  `scope-enhancement-atc-pipeline/`

This is the data layer the **ATC usage dashboard** reads. It answers "what got done, what failed and
why, and what was never created." **Business throughput only — no GPU/cost tracking.** Sliced by
coach (`profileid`) × type.

**Three capture mechanisms, all writing to the default DB:**

| Mechanism | Where | Writes to | Cadence |
|---|---|---|---|
| **Drop-offs** (`recordDropoff`) | S0 (7 reasons) + S1 (2 reasons) bail-out points | `scope_enhancement_atc_usage_dropoffs/{IST-day}` | real-time, per-event |
| **Backlog gauge** (`writeBacklogGauge`) | `atcJobWatchdog` (hourly) | `scope_enhancement_atc_usage_backlog/{latest, day}` | hourly |
| **Daily/lifetime rollup** (`seAtcUsageRollup`) | scheduled **01:00 IST** | `..._daily/{date}_{profileid}` + `..._lifetime/{profileid}` (+ `__ALL`) | nightly |

- **Drop-offs** are the biggest silent failure class — jobs **never created** because an S0/S1 gate
  bailed (e.g. `transcript_fetch_failed`, `generateatc_false`, `empty_transcript`,
  `atcprompts_missing`). Before this, they were only visible in Slack/logs.
- All telemetry writes are **best-effort** — wrapped so a telemetry failure can **never** break the
  generation pipeline.
- The **rollup** is idempotent: daily docs overwrite; lifetime docs increment **once per date**
  (guarded by a `rollup_state` marker) so re-runs never double-count.
- **Full field-by-field frontend contract:** see [`DASHBOARD-DATA-CONTRACT.md`](./DASHBOARD-DATA-CONTRACT.md).
- **Module README** (rollup internals, indexes, tests): see [`README.md`](./README.md).

## Deployed functions & schedules (current prod scope)

| Function | Trigger | Role |
|---|---|---|
| `onQueueStageChange` | Firestore (queue_token) | **S0** input → create gen docs |
| `onQueueAtcGenerationCreate` | Firestore (queue_atc_generation create) | **S1** build prompt → pending |
| `atcPodLifecycle` | schedule **every 10 min** | pod loop clock (IDLE→launch, LOADING→ready) |
| `podWorkerUpdate` | HTTPS | pod lifecycle pushes (ready/drained/unhealthy) |
| `atcJobWatchdog` | schedule **every 1 hour** | requeue stuck jobs + backlog gauge + non-drain alert |
| `seAtcUsageRollup` | schedule **01:00 IST** | nightly daily/lifetime usage rollup |
| `atc-drain-worker` | Cloud Run Job | the drain worker the pod loop starts to run inference |

**Deleted from prod (on hold):** `onQueueAtcGenerationUpdate` (S2/S2B/S3B), `onAtcAlphaCreate` (S3A).

## Key files

`components/`: `queuesystem.js` (S0), `queue_atc_generation.js` (S1), `ATC.js` (S3A),
`pod_worker.js` (pod FSM), `pod_controller.js` (GPU controller client), `pod_jobs.js` (job FSM),
`atc_helpers.js` (`shouldStartPod`, `extractAssistantFinalJson`), `atc_alerts.js` (`alertAtc`).
`scope-enhancement-atc-pipeline/`: `se_atc_usage.js` (rollup), `se_atc_usage_aggregate.js` (pure agg),
`se_atc_failure_classifier.js` (failure categories), `se_atc_telemetry.js` (drop-off + backlog).

---

# Part 3 — Operational Runbook

## ⚠️ #1 Gotcha — `enabled=true` does NOT restart a HALTED pod

If the pod loop is `HALTED`, **toggling `classify/pod_worker.enabled` does nothing.** The lifecycle
checks `enabled` only when the state is `IDLE`; once `HALTED`, it bails on every tick regardless of
`enabled`. There is **no auto-recreate after a failure** — by design.

**To resume, manually edit `classify/pod_worker` (default DB):**

| field | set to | note |
|---|---|---|
| `state` | `IDLE` | **the lever that matters** — the loop gates on `state`, not the `halted` bool |
| `halted` | `false` | clears the human-facing marker |
| `haltedReason` | *(delete / empty)* | tidy-up |

> Clearing only `halted` is **not enough** — you must reset `state` to `IDLE`. After the reset, with
> `enabled=true`, the next 10-min tick launches a pod if the gate passes (pending ≥ 20 **OR** oldest
> pending older than the flush window).

**If it HALTED on a load timeout** (`haltedReason: load timeout > 30m`), a plain reset may just
re-HALT. Mitigate by raising `loadTimeoutMinutes` (e.g. 30→45) on the same doc, and/or checking the
controller pod logs in `ai-project-4e149`.

## Other operational notes

- **No auto-recovery for missed gen docs (S0).** If S0 misses a doc (async Zoom transcript not ready,
  etc.) there is no scheduled reconciler. Repair is **manual**: `npm run atc:report` to find gaps,
  then `npm run atc:backfill-missing-jobs` (use `ATC_ALERTS_SILENT` / `--quiet` to avoid Slack flood).
  A faithful backfill replays **all** `atcrequiredstages` per token.
- **Orphan-race on teardown.** Terminating a pod out-of-band **while armed** with a pending job can
  make the next tick launch a fresh (orphan) pod. Safe teardown order: **disarm first** (`enabled=false`),
  then terminate the tracked `podid`, then restore config.
- **Deploy gotcha — `main` in `package.json`.** `main=index.emulator.js` exports only 16 functions;
  full deploys need `main=index.js` (166 exports). A bare deploy with the wrong `main` **prunes prod
  down to 16 functions.**
- **Alert silencing.** `ATC_ALERTS_SILENT=1` suppresses the Slack POST (alerts still go to Cloud
  Logging) — for offline backfills/replays so a one-off run can't flood the pipeline channel.

## Handy read-only tooling (all use ADC, default to prod)

| Command | What it shows |
|---|---|
| `npm run atc:monitor` | live pod state + queue counts; watch a run's `IDLE→LOADING→READY→IDLE` |
| `node scripts/verify-telemetry-capture.js` | one-shot snapshot of `_dropoffs`/`_backlog`/`pod_worker`/queue vs the data contract |
| `npm run atc:report` | find queue gaps / missing jobs |
| `npm run atc:validate-s1` | check pending S1 jobs are claimable |

---

## Glossary

- **ATC** — the AI-generated coaching analysis report (the pipeline's output).
- **Coach / `profileid`** — the coach a report belongs to; the main slicing dimension for usage.
- **Job / gen doc** — one document in `queue_atc_generation`; one unit of work.
- **Pod** — a rented GPU machine that runs the LLM to produce ATCs.
- **Drop-off** — a job that was **never created** because an S0/S1 gate bailed.
- **Armed** — `classify/pod_worker.enabled == true`; the pod loop is allowed to launch pods.
- **HALTED** — the pod loop's failure parking state; requires a manual `state=IDLE` reset.
