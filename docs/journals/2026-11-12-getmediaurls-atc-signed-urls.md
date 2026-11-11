# 2026-11-12 — `getMediaUrls`: ATC notes media moved to signed URLs

**Status:** implemented and deployed to `starlabs-test` only. 29 unit tests green
(`npx jest test/unit/media_signed_url.test.js`). **Not on production.**
Companion journals (the Angular side, the UI mechanics, the full test logs) live in the
Angular repo: `specs/journals/2026-11-11-atc-signed-urls.md` and
`2026-11-12-atc-signed-urls-option-c.md`.

**If you are about to touch `components/media_signed_url.js`, or anything that reads
`atc_notes`, read this first.**

---

## Why this function exists

Every media URL in Firestore used to be a Firebase **download URL** carrying a
`firebaseStorageDownloadTokens` value. Those tokens have **no TTL** and **bypass Storage
Rules entirely**, so one leaked row was a permanent, public, unauthenticated handle on the
object. `atc_notes` holds participants' recorded consultations.

`getMediaUrls` takes an object **path** and returns a short-lived V4 signed URL. The paths
now stored in Firestore are useless on their own.

## The contract, as it stands

| Rule | Value |
|---|---|
| Who measures a clip's length | **this function**, from the file's own WAV header |
| Audio lifetime | `duration + 20 min`, exact — no rounding |
| Image lifetime | 15 min |
| Header unreadable | 30 min |
| Link reused while | `remaining ≥ duration + 5 min` (images: `≥ 5 min`) |
| Ceiling constant | **none** — there is nothing to clamp |
| Duration in Firestore | **none** |

`refs` may be bare path strings, or `{path}` objects from older clients. **Any `duration` a
caller sends is ignored.**

## Four things that will bite you

**1. Never accept a duration from the client.** An earlier revision did. Anyone signed in
could open devtools and ask for a year — measured, and the server granted **6.33 hours**
against a 4-hour cap. The length is read from the file; that is what makes a ceiling
unnecessary.

**2. Never round the expiry to a multiple of the ttl.** An earlier revision snapped
`expires` up to a ttl boundary so every caller agreed on the URL string. That makes real
validity **1× to 2× the ttl** — which is where that 6.33 hours came from. Sharing is now
achieved by *reusing* a live link (see the contract above), which gets the same
identical-string benefit with an exact expiry.

**3. Never cache a failed header read.** A note page asked for 25 clips at once; 23 reads
failed under that concurrency and the failures were cached, leaving those clips permanently
mis-measured on a 30-minute fallback. Retried one at a time, every one read fine. There is
now a 4-at-a-time throttle (`HEADER_CONCURRENCY`) and failures are **not** kept. The
signature cache had always refused to cache failures deliberately; the duration cache did
not, and only real files exposed it.

**4. The fence is about WHERE, not WHO.** `PREFIXES` restricts which prefixes can be signed.
It does **not** check that the caller is entitled to that participant's note. Any signed-in
user can sign any object under an allowed prefix. **Per-caller authorisation is still
missing** and is the main security work left here.

## Storage Rules interaction — measured, not assumed

`starlabs-test` runs `allow read: if false` / `allow write: if request.auth.uid != null`.
Tested against it with no credentials:

| Request | Result |
|---|---|
| `?alt=media&token=<valid>` | **206 — still serves the file** |
| `?alt=media` (no token) | 403 |
| metadata `GET /v0/b/…/o/<path>` | 403 |
| list | 403 |
| `getDownloadURL()` (signed in, SDK) | throws `storage/unauthorized` |

So **`read: if false` does not stop an existing download URL.** A valid token is checked
before rules and overrides them. The rule only stops *minting a new one*.

Two consequences:

- **Rules alone protect nothing already issued.** Only revoking
  `firebaseStorageDownloadTokens` closes that, and it is irreversible.
- **92 files in the Angular app still call `getDownloadURL()`** — avatars, notifications,
  chat, content, workshops. Under this rule each throws after a successful upload. That is
  why the rule is not on production.

## Scope today

Signed prefixes: `<name>/profile/**` (avatars), `signed-url-test/**` (a deletable harness),
`ATC_Audio_Notes/**`, `Uploaded ATC/**`, `Online ATC Images/**`.

`call_recordings/**` — 7,822 objects — is **deliberately outside the fence**. Adding it
would hand every signed-in caller a worse exposure than the one being fixed. Do not widen it
without per-caller authorisation first.

**Only this file touches ATC media.** `communication.js`, `user_registration.js` and
`service.js` mention download URLs but have zero ATC references.

## Known stale comment

`index.js:333` still says "fenced to `<name>/profile/**`". It now covers the ATC prefixes
too.

## Pending

Per-caller authorisation · production deploy · production data migration · token revocation
(irreversible, do last) · the 92 `getDownloadURL()` callers · cross-instance link sharing
(each CF instance keeps its own caches, so two viewers on different instances can get two
different valid links — would need Memorystore).
