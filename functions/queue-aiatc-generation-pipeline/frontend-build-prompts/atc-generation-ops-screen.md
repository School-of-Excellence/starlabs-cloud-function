# BUILD PROMPT — ATC Generation Ops Screen (`dataincomplete` review + prompt view/rebuild)

Build an internal operator screen in THIS frontend codebase for managing ATC generation documents. It has two feature areas: **(A) Data-Incomplete Review** and **(B) Prompt View / Rebuild**. Read every section before writing code. All contracts below are derived from the actual deployed backend source — do not invent field names, argument names, or reason strings.

---

## 0. Non-negotiable ground rules

1. **This screen NEVER writes to Firestore directly.** All mutations go through exactly two deployed Firebase **callable** functions: `regenerateAtcDoc` and `rebuildAtcPrompt`. The only Firestore access is a **read-only real-time listener** for the list.
2. **Match the existing codebase.** Before writing anything, inspect this repo and reuse its conventions:
   - Framework (React/Vue/Svelte/etc.), routing, and state management already in use.
   - The existing component library / design system (buttons, tables, modals, toasts, badges, spinners). Do **not** introduce a new UI kit.
   - The existing **Firebase initialization** pattern (`firebase/app` `initializeApp`, the exported `app`/`db`/`functions` handles, region config, env vars). Reuse it.
   - The existing **auth** wiring. Assume Firebase Auth is already configured and a user is signed in — both callables reject unauthenticated calls (`HttpsError('unauthenticated')`). Do **not** build a login flow; just guard the screen behind whatever auth gate the app already uses and surface an "auth expired, sign in again" state if an `unauthenticated` error ever comes back.
3. **Firestore database + collection (read side):** the docs live in a **secondary** Firestore database named **`firestore-atc`**, collection **`queue_atc_generation`**. This is NOT the app's default database. You must obtain a db handle bound to that named database (Web SDK v9: `getFirestore(app, 'firestore-atc')`). If the app's existing Firebase init only exposes the default db, add a second exported handle for `firestore-atc` alongside it — do not repoint the default handle.
4. **Callables region:** `us-central1` (v2 `onCall`). Use `getFunctions(app, 'us-central1')` then `httpsCallable(functions, '<name>')`.

---

## 1. Firebase wiring (Web SDK v9, modular)

```ts
import { getFirestore, collection, query, where, onSnapshot } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
// reuse the app instance the codebase already exports
const atcDb    = getFirestore(app, 'firestore-atc');   // named DB — read only
const functions = getFunctions(app, 'us-central1');

const regenerateAtcDoc = httpsCallable<RegenerateReq, RegenerateOk>(functions, 'regenerateAtcDoc');
const rebuildAtcPrompt = httpsCallable<RebuildReq,   RebuildOk>(functions, 'rebuildAtcPrompt');
```

### Callable types (exact, from source)

```ts
// ---- regenerateAtcDoc ----
type RegenerateReq = { docid: string };
type RegenerateOk =
  | { ok: true; status: 'dataincomplete'; missing: Array<{ stage: string; category: 'mandatory' | 'atleastonerequired' }> }
  | { ok: true; status: 'pending'; resolvedStages: number; missing: Array<{ stage: string; category: string }> };
// on failure: throws FirebaseError, code = 'functions/failed-precondition', message = <reason string> (see §4)
// (missing docid / no auth throw too — see §4)

// ---- rebuildAtcPrompt ----
type RebuildReq = { docid: string; requeue?: boolean };
type RebuildOk  = { ok: true; status: 'pending'; requeued: boolean; promptChars: number };
// on failure: throws FirebaseError, code = 'functions/failed-precondition', message = <reason string> (see §4)
```

> How errors arrive on the client: the backend does `throw new HttpsError('failed-precondition', reason)`. In the Web SDK the caught error is a `FirebaseError` where `error.code === 'functions/failed-precondition'` and **`error.message === reason`** (the raw reason string). Match on `error.message`. `unauthenticated` arrives as `error.code === 'functions/unauthenticated'`.

---

## 2. Data model read from `queue_atc_generation` (firestore-atc)

Fields you render (only these are needed; ignore the rest):

| field | type | use |
|---|---|---|
| `status` | `'dataincomplete' \| 'pending' \| 'processing' \| 'completed' \| 'error'` | filter + badge |
| `profileid` | string | participant/coach identifier |
| `stage` | string | queue stage name (e.g. "Guided Self ATC") |
| `type` | `'form' \| 'zoom'` | own-stage source type |
| `createdAt` | Firestore Timestamp | enqueue time (format via existing date util) |
| `prompt` | string (can be large) | Feature B viewer |
| `systemprompt` | string | Feature B viewer |
| `output` | string | (optional) show for `completed` in Feature B |
| `stagedata` | map | the breakdown — see below |

### `stagedata` shape (exact)

`stagedata` is an object keyed by stage name. Each entry:

```ts
type StageDataEntry = {
  data: unknown | null;
  category: 'own' | 'mandatory' | 'atleastonerequired';
  status: 'resolved' | 'missing';
  type: 'form' | 'zoom' | null;
  queueid: string | null;
  queuetokenid: string | null;
  // sourceref may also be present; ignore it in the UI
};
type StageData = Record<string /* stageName */, StageDataEntry>;
```

**Completeness rule (mirror it in the UI so operators understand *why* a doc is blocked):** a doc is `dataincomplete` when **either** at least one `category === 'mandatory'` entry has `status === 'missing'`, **or** there is at least one `category === 'atleastonerequired'` entry configured but **none** of them are `resolved`. The `own` entry is always `resolved` on an existing doc (a doc is never created without its own source). So render the two missing-classes distinctly:

- **Missing mandatory** → hard blocker (red). Every one must be resolved.
- **atleastonerequired, none resolved** → group blocker (amber). The group needs ≥1 resolved; show them as a set with a "need any 1 of N" note.
- `resolved` entries → green/neutral check.

---

## 3. Component breakdown

Build under a single route (e.g. `/ops/atc-generation`) with a master/detail layout: left = Feature A list, right = Feature B detail for the selected doc. Selecting any row (any status) opens Feature B for that doc.

### Feature A — Data-Incomplete Review (list)

- **Data source:** real-time listener on
  `query(collection(atcDb,'queue_atc_generation'), where('status','==','dataincomplete'))`.
  Use `onSnapshot`; clean up on unmount. Keep the list sorted by `createdAt` (client-side sort is fine; if you add `orderBy('createdAt')` be ready for a composite-index prompt and prefer client sort to avoid it).
- **Row renders:** `profileid`, `stage`, `type` badge, `createdAt` (relative + absolute tooltip), and a compact **stagedata breakdown**:
  - one chip per pairing stage (skip the `own` entry or show it muted as "own ✓"),
  - color by the rule in §2 (red missing-mandatory, amber atleast-one-group, green resolved),
  - group the `atleastonerequired` chips together under a "need any 1" label.
- **Primary action per row: "Generate / Retry"** → `regenerateAtcDoc({ docid })`.
  - Button shows in-flight spinner + disables while the call is pending (one in-flight call per row; do not disable the whole list).
  - **On `{ status: 'pending' }`** → success toast ("Sources complete — queued for generation"); the row will disappear on its own via the listener (status left `dataincomplete`). Do **not** optimistically remove it; let the snapshot drive removal, but you may optimistically mark the row "queued…" until the snapshot updates.
  - **On `{ status: 'dataincomplete', missing }`** → row stays; refresh its displayed missing list from the returned `missing[]` (and the snapshot will also refresh `stagedata`). Show an inline "Still missing: …" note listing `stage (category)`.
  - **On thrown error** → map `error.message` via §4 table to a friendly message (toast or inline row error). Never show the raw reason string.
- **States:** loading (initial snapshot pending), empty ("No data-incomplete docs 🎉"), listener-error (show retry), per-row in-flight, per-row error.

### Feature B — Prompt View / Rebuild (detail panel)

- **Input:** the selected `docid` (from a row click, or a docid search box). Read that single doc — you already have it from the list snapshot if it's in the list; otherwise attach a `doc()` listener (or one-time `getDoc`) on `queue_atc_generation/{docid}` in `atcDb`. It may be any status.
- **Render:** status badge; `stage`; `profileid`; a **large read-only `prompt` viewer** (monospace, scrollable, wrapped, with a copy-to-clipboard button and a char count); a smaller **`systemprompt`** viewer; and for `completed` optionally an `output` viewer. If `prompt`/`systemprompt` are empty, show "not built yet".
- **Actions (guarded by status):**
  - **`status === 'pending'`** → **"Rebuild prompt"** button → `rebuildAtcPrompt({ docid })`. On success toast "Prompt rebuilt (N chars)" using `promptChars`.
  - **`status ∈ {processing, completed, error}`** → **"Rebuild & requeue"** button (visually distinct / warning style) → open a **confirm dialog** explaining: *"This rebuilds the prompt AND flips the doc back to `pending`, clearing claim/terminal markers so a GPU pod re-claims it and re-runs inference from scratch. This consumes compute. Continue?"* On confirm → `rebuildAtcPrompt({ docid, requeue: true })`. On success toast "Rebuilt & requeued".
  - **`status === 'dataincomplete'`** → do NOT offer rebuild here; show a link/CTA that jumps to Feature A's "Generate / Retry" for this doc (rebuild will reject with `dataincomplete_use_regenerate`).
- **States:** loading doc, doc-not-found, in-flight button, error (map via §4), success.

---

## 4. Failure-reason → UI mapping (EXACT reason strings from source)

Match on `error.message`. Some reasons are **dynamic** (contain interpolated ids) — match by prefix.

### `regenerateAtcDoc`

| reason (error.message) | match | user-facing message | recommended UI action |
|---|---|---|---|
| `missing_docid` | exact | "No document selected." | dev/guard error; shouldn't happen — log it |
| `doc_not_found` | exact | "This generation doc no longer exists." | remove row / refresh list |
| `status_processing_not_regeneratable` | exact | "This job is already being processed by a pod — can't regenerate now." | disable action; suggest waiting |
| `status_completed_not_regeneratable` | exact | "This job already completed. Use 'Rebuild & requeue' if you need to re-run it." | deep-link to Feature B requeue |
| `no_queueref` | exact | "Doc is missing its queue reference — data problem, escalate." | show escalate/contact-eng note |
| `queue_<id>_not_found` | prefix `queue_` + suffix `_not_found` | "The source queue for this doc wasn't found." | escalate |
| `token_<id>_not_found` | prefix `token_` + suffix `_not_found` | "The queue token for this doc wasn't found." | escalate |
| `stage_not_in_config` | exact | "This stage is no longer configured for ATC generation." | escalate / no retry |
| `generateatc_false` | exact | "ATC generation is turned off for this stage." | no retry; config change needed |
| `own_unresolvable:<detail>` | **prefix** `own_unresolvable:` | "Can't resolve the participant's own source data yet." + show the detail (see sub-table) | usually "retry later" |
| `atcprompts_missing` | exact | "The base ATC prompt config is missing — backend/config issue, escalate." | escalate |

**`own_unresolvable:` detail suffixes** (surface the human hint after the colon):

| detail suffix | hint |
|---|---|
| `NO_ACTIONRESOURCE for "…"` | Stage isn't wired to a form resource — config issue. |
| `NO_FORM_SUBMISSION formid=…` | Participant hasn't submitted the required form yet. |
| `NO_STUDIO_SESSION` | No studio session logged for this participant/stage. |
| `NO_LIVEASSIGNMENT` | Studio session has no live assignment yet. |
| `LIVEASSIGNMENT_NOT_FOUND liveassignmentid=…` | Live assignment record is missing. |
| `TRANSCRIPT_NOT_YET_CAPTURED meetingid=…` | Zoom transcript hasn't been captured yet — retry later. |
| `NO_ZOOM_MEETING` | No Zoom meeting associated with the session. |
| `UNKNOWN_STAGE_TYPE …` | Stage type isn't form/zoom — config issue, escalate. |

> For `own_unresolvable:*` and the `TRANSCRIPT_NOT_YET_CAPTURED` case especially, present it as **transient**: "Retry later" rather than a hard failure.

### `rebuildAtcPrompt`

| reason (error.message) | match | user-facing message | recommended UI action |
|---|---|---|---|
| `missing_docid` | exact | "No document selected." | guard error; log |
| `doc_not_found` | exact | "This generation doc no longer exists." | refresh/close panel |
| `dataincomplete_use_regenerate` | exact | "This doc is missing source data — use 'Generate / Retry' instead." | **redirect to Feature A** for this docid |
| `no_stagedata` | exact | "This doc has no resolved sources to build a prompt from." | escalate / regenerate first |
| `status_processing_needs_requeue` | exact | "This job is processing. To rebuild you must requeue (re-runs inference)." | show the "Rebuild & requeue" confirm flow |
| `status_completed_needs_requeue` | exact | "This job already completed. To rebuild you must requeue (re-runs inference)." | show the "Rebuild & requeue" confirm flow |
| `status_error_needs_requeue` | exact | "This job errored. To rebuild you must requeue (re-runs inference)." | show the "Rebuild & requeue" confirm flow |
| `atcprompts_missing` | exact | "The base ATC prompt config is missing — escalate." | escalate |
| `no_resolved_stages` | exact | "No resolved stages — nothing to build a prompt from." | escalate / regenerate first |

> The three `status_*_needs_requeue` reasons only fire when `requeue` was **not** sent. Your UI should already route those statuses to the requeue confirm dialog, so treat these as "you clicked plain rebuild on a non-pending doc → prompt the requeue path."

Also handle generically: `error.code === 'functions/unauthenticated'` → "Your session expired. Please sign in again." Any other/unknown error → "Something went wrong. Try again." (and log the raw error).

---

## 5. Acceptance checks

- [ ] List shows only `status == dataincomplete` docs from **`firestore-atc`** `queue_atc_generation` and updates in real time (new blocked docs appear, regenerated ones vanish) without a manual refresh.
- [ ] Each row's stagedata breakdown visually distinguishes **missing mandatory** (hard, red) from **atleastonerequired-none-resolved** (group, amber) from **resolved** (green), and hides/mutes the `own` entry.
- [ ] "Generate / Retry" calls `regenerateAtcDoc({docid})`; on `pending` the row leaves the list; on `dataincomplete` the row stays and its missing list refreshes from the returned `missing[]`.
- [ ] Every reason string in §4 maps to a friendly message; **no raw reason string is ever shown**; dynamic reasons (`queue_*_not_found`, `token_*_not_found`, `own_unresolvable:*`) match by prefix and surface their detail hint.
- [ ] Feature B shows `prompt` (large, read-only, copyable, char count) + `systemprompt` + status for any selected doc.
- [ ] "Rebuild prompt" is only offered for `pending`; `processing/completed/error` show "Rebuild & requeue" behind a confirm dialog that explains it re-runs inference and calls `rebuildAtcPrompt({docid, requeue:true})`; `dataincomplete` redirects to Feature A.
- [ ] All buttons show in-flight/disabled state and are individually scoped (one row/action at a time), never freezing the whole screen.
- [ ] The screen performs **zero direct Firestore writes** — verify all mutations flow through the two callables only.
- [ ] Firebase init, auth gating, UI components, and styling reuse the existing codebase patterns; no new UI framework or duplicate default-db handle was introduced (only an added `firestore-atc` handle if one didn't exist).
- [ ] `unauthenticated` errors surface a "sign in again" state.
