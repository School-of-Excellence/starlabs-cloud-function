# 2026-07-05 — CF predeploy/postdeploy: no more local hub or `.env.cicd`

**Branch:** `cicd-rollout`. **Status:** implemented (`node --check` clean). Companion (architecture +
WHY) journal lives in the hub: `starlabs-e2e-tests/specs/journals/2026-07-05-cf-predeploy-option-b-identity-auth.md`.

## What changed for developers (the short version)
Deploying CF **no longer needs** a local hub checkout, `E2E_HUB_PATH`, `.env.cicd`, or `setscript.sh`.
The **only** setup is:
```bash
gh auth login          # once — used to record the deploy under your identity
```
Everything else (git, Node 22, Java 21, firebase-tools) you already have to deploy CF.

## How a deploy works now
```bash
firebase deploy --only functions        # (or --only functions:name)
```
1. **predeploy** checks you're logged in to `gh` (stops with `gh auth login` if not).
2. regenerates `functions-manifest.json`.
3. if the functions you're deploying include a Firestore trigger, it runs the **loop-guard**:
   - the **first time** on a machine it clones the public hub into `.cicd-hub/` (gitignored) and
     `npm ci`s it — a one-time "preparing guard environment…" pause (a few minutes);
   - after that it **reuses the cache**, re-cloning only when the hub's guard is updated;
   - the guard boots a local emulator with **your exact code** (uncommitted included) and asserts no
     function retriggers itself into an unbounded loop. **Fail ⇒ the deploy is aborted.**
4. **postdeploy** reports the deploy to the console's CF Board matrix using your **GitHub token**
   (`gh auth token`) — no shared secret needed. It's best-effort and never fails the deploy.

Skip the guard for a run with the interactive prompt, or `SKIP_TEST=1 firebase deploy …` (non-TTY/CI
always runs it).

## Why this shape
- **`.cicd-hub/` auto-managed cache** instead of `E2E_HUB_PATH`: the loop-guard's runner is a hub
  subsystem (emulator boot script + generated config + the hub's `node_modules`), not a couple of files —
  so we cache and reuse the hub's own `cf-predeploy.sh` verbatim (zero drift) rather than copying it here.
- **Identity auth (`gh auth token`)** instead of `CONSOLE_INGEST_TOKEN` in `.env.cicd`: GitHub secrets
  can't be read back by a local script, and a plaintext repo variable is too weak — so you authenticate
  as yourself. `recordCfDeploy` verifies you have push access to this repo and records `by` as your
  GitHub login.

## Follow-up fix (same day): inline functions were invisible to the guard
`generate-manifest.js` only recognized the repo convention `exports.X = module.fn` (component re-exports),
so a function defined INLINE in `index.js` (`exports.testHUB = onDocumentCreated("test/{docid}", …)`) was
missing from the manifest → the predeploy fast-path saw "no trigger" and skipped the guard. Fixes:
- `generate-manifest.js` — also parse the inline form (`exports.X = factory(...)`), using `index.js` as
  the body for type/trigger detection. (testHUB now appears: 140 fns / 85 triggers.)
- `predeploy.js` — fast-path now runs the guard when a deploying function is **unknown to the manifest**
  or typed `UNKNOWN` (fail-safe), not just when a known function has a `triggerPath`.
- NOTE: an inline function still needs adding to `functions/index.emulator.js` for the guard to *execute*
  it (`emulatorLoaded` flag) — the emulator boots the filtered entry by design.

## Files
- **Changed:** `scripts/cicd/predeploy.js` (gh-auth gate + `.cicd-hub` cache + run cached guard +
  fast-path fail-safe), `scripts/cicd/postdeploy.js` (`gh auth token` auth),
  `scripts/cicd/generate-manifest.js` (inline-function detection), `.gitignore` (`+ .cicd-hub/`).
- **Deleted:** `.env.cicd`, `.env.cicd.example`, `scripts/cicd/setscript.sh`.
- **Unchanged:** `scripts/cicd/generate-manifest.js`, `functions/index.emulator.js`, `firebase.json`
  (hooks already correct), `functions/package.json` (playwright lives in the cached hub, not here).

## Requires (operator, one-time)
- Deploy the hub functions so `recordCfDeploy` accepts GitHub-identity auth:
  `firebase deploy --only functions --project starlabs-cicd` (run from the hub).
- Then verify end-to-end from a dev machine: `gh auth login` → `firebase deploy --only functions` →
  first run clones `.cicd-hub` + guards local code → matrix row shows your GitHub login as `by`.
