# ATC pipeline — integration tests (option a: per-handler)

These tests drive **one inner pipeline function at a time** against the local
Firestore emulator and assert the document it writes (or the alert it raises).
They are deterministic and never touch production.

## Run

```bash
npm run test:integration
```

This wraps jest in `firebase emulators:exec --only firestore`, which starts a
throwaway Firestore emulator and sets `FIRESTORE_EMULATOR_HOST` so every
admin-SDK call is redirected to the sandbox. Requires Java (JRE) for the
emulator.

Other suites:
- `npm test` — fast pure-logic unit tests (`test/unit`, no emulator).
- `npm run test:invariants` — read-only checks against **live** firestore-atc
  (needs `GOOGLE_APPLICATION_CREDENTIALS`).

## What each file covers

| File | Stage | Cases |
|---|---|---|
| `stage0.test.js` | `processStage` / `resolvePreviousStage` (queuesystem.js) | TC0.1 form, TC0.3 dedup, TC0.4 no config, TC0.5 form missing, TC0.2-pre/TC0.7 previous-stage |
| `stage1.test.js` | `processAtcGenerationDoc` (queue_atc_generation.js) | TC1.1 prompt build, TC1.2 type skip, TC1.3 config missing, TC1.4 pairings missing |
| `stage2.test.js` | `processCheckpointVerificationDoc` | TC2.1 happy, TC2.2 dedup, TC2.3 no output, TC2.4 config missing |
| `stage3.test.js` | `processAtcAlphaDoc` + `maybeTriggerRubricsFromGeneration` | TC3.1 happy, TC3.2 dedup, TC3.3 AI not ready, TC3.7 vice-versa, TC3.8 vice-versa dedup |

`atc_alerts` is mocked in every file, so Slack is never posted and
alert-on-failure cases are asserted via the mock.

## Multiple databases — verified isolated

The emulator **does** isolate the three named databases (default,
`firestore-atc`, `firestore-forms`). Verified empirically: writing a different
value to the same path in each database and reading it back returns each
database's own value.

firebase-tools 14.7.0 prints a warning when `firebase.json`'s `firestore` array
has more than one entry:

```
Cloud Firestore Emulator does not support multiple databases yet.
```

That warning is **only about loading security `rules`** — the CLI can't pick a
single rules file for multiple database configs, so it skips rules and allows
all reads/writes (which is exactly what tests want). It is NOT a statement about
runtime data isolation. Source: `firebase-tools/lib/emulator/controller.js`
emits it on the rules-resolution branch (`firestoreConfigs.length !== 1`).

Because the databases are genuinely separate, these tests **do** exercise
cross-database routing. `TC0.9` is the explicit regression guard: it seeds
`formsByClient` in the wrong database (firestore-atc) and asserts the Stage-0
read (scoped to firestore-forms) finds nothing, then asserts the gen doc is
written to firestore-atc and NOT to the default DB. Live cross-DB integrity is
additionally covered by `test/invariants.js` **INV.4**.
