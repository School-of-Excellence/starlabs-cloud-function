// media_signed_url.js — getMediaUrls({ refs }) → short-lived V4 signed read URLs.
//
// BEFORE CHANGING ANYTHING HERE, read
//   docs/journals/2026-11-12-getmediaurls-atc-signed-urls.md
// It records four mistakes already made and reverted in this file: accepting a duration
// from the client, rounding the expiry to a ttl boundary, caching a failed header read,
// and mistaking the prefix fence for authorisation.
//
// WHY this exists: every media URL stored in Firestore used to be a Firebase download URL
// carrying a `token` query param. Those tokens have NO TTL and they bypass Storage
// Security Rules entirely, so a single leaked row was a permanent public handle on the
// object. This callable takes an object reference — or a LEGACY download URL, whose token
// it discards — and hands back a V4 signed URL that actually expires.
//
// Two gates, both required by the brief:
//   * authenticated request — onCall verifies a Firebase ID token before this body runs.
//   * this project only     — that ID token must be minted by THIS project's Auth.
//
// ── How long a link lives ────────────────────────────────────────────────────────────
//
//   audio   duration + 20 min        duration read from the file itself (see below)
//   images  15 min
//   unknown 30 min                   header unreadable; a brief is ~10 min at most, so
//                                    10 + 20 covers it, and the client renews if not
//
// There is NO ceiling constant and no clamp, because there is nothing to clamp: the
// duration is measured server-side, never supplied by the caller. An earlier revision
// accepted `duration` from the client, which meant anyone signed in could ask for a
// year-long URL from the browser console — measured, and it worked.
//
// ── Why the duration is read from the WAV header ─────────────────────────────────────
//
// RecordRTC records at the AudioContext's default sample rate: 44.1 kHz on most machines,
// 48 kHz on some. Inferring length from byte size assumes one of those and is ~9% out on
// the other. The RIFF header carries the real sampleRate, channels and bit depth, so a
// 4 KiB ranged read gives the exact length. It is read ONCE per object — a file's length
// never changes — and only for the audio prefix.
//
// ── Why the same link is handed to everyone ──────────────────────────────────────────
//
// A link is reused while it still has `duration + 5 min` left, so every caller gets a URL
// they can play the clip through on, with five minutes spare. Reuse therefore lasts
// exactly 15 minutes — (duration + 20) − (duration + 5) — whatever the clip length.
//
// An identical URL string means the browser treats it as the same file: reload the page
// and it comes from cache rather than downloading a large recording again, and the
// signature is computed once rather than once per viewer.
//
// EXPIRY IS EXACT — `now + ttl`, nothing rounded. An earlier revision snapped expiry up to
// a multiple of the ttl so callers would agree on the string; that made real validity
// anywhere between 1x and 2x the ttl, which turned a 4-hour cap into a measured 6.33
// hours. Reuse achieves the same agreement without the overshoot.
//
// PER-REF ERRORS ARE RETURNED, NOT THROWN. One unparseable row must not blank a whole
// page, so the result array carries `{ref, error}` for rows that failed and
// `{ref, url, expiresAt, duration}` for rows that worked.
"use strict";

const admin = require("firebase-admin");
const { onCall, HttpsError } = require("firebase-functions/v2/https");

const MAX_REFS = 200;                        // keeps a single call bounded

const PAD_MS = 20 * 60 * 1000;               // added to an audio clip's own length
const REUSE_MARGIN_MS = 5 * 60 * 1000;       // spare time a reused link must still carry
const IMAGE_TTL_MS = 15 * 60 * 1000;
const FALLBACK_TTL_MS = 30 * 60 * 1000;      // length unreadable: 10 min brief + 20 min pad

const WAV_HEADER_BYTES = 4096;               // ample for a RIFF header; a full read is ~5 MB/min

// Prefixes this callable will sign, and how each one's lifetime is decided. Deliberately a
// short allow-list, not a wildcard: a general "sign anything for any signed-in user"
// endpoint would hand every authenticated caller the 7,822 objects under call_recordings/,
// which is a worse exposure than the one being fixed. Each new screen adds its prefix here
// on purpose.
//
// NOTE the fence is about WHERE, not WHO. Until per-caller authorization lands, any
// signed-in user can sign any object under these prefixes.
const PREFIXES = [
  { re: /^[^/]+\/profile\/.+$/, kind: "fixed" },      // avatars
  { re: /^signed-url-test\/.+$/, kind: "fixed" },     // sandbox; safe to delete wholesale
  { re: /^ATC_Audio_Notes\/.+$/, kind: "audio" },     // changeworkbrief
  { re: /^Uploaded ATC\/.+$/, kind: "fixed" },        // imagenotes
  { re: /^Online ATC Images\/.+$/, kind: "fixed" },   // prescription_image
];

function prefixFor(path) {
  if (path.includes("..")) return null;
  return PREFIXES.find((p) => p.re.test(path)) || null;
}

// ── Caches ───────────────────────────────────────────────────────────────────────────
// `linkCache` is what makes viewers share a URL: path → the live link and its expiry.
// `durationCache` is permanent for the instance — an object's length cannot change.
//
// WHY NOT a Firestore collection: a signed URL is a bearer capability. Persisting it would
// put working, unauthenticated access back into the database, which is the exact property
// this migration exists to remove.
//
// Scope limit, stated honestly: Cloud Functions runs several instances and each holds its
// own caches, so two viewers served by different instances can get different (both valid)
// links. Sharing across instances would need a shared cache such as Memorystore.
const CACHE_MAX = 5000;
const linkCache = new Map();
const durationCache = new Map();

function cacheSet(cache, key, value) {
  if (cache.size >= CACHE_MAX) cache.clear();   // cheap, and only costs re-signing
  cache.set(key, value);
}

// decodeURIComponent THROWS URIError on a stray '%' — and object names like
// "100%_done.jpg" are legal in GCS. An unguarded throw would escape the per-ref error
// handling and 500 the whole call for the sake of one filename.
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// A ref is a bare path string. `{path}` objects are still accepted because earlier clients
// sent them; any `duration` they carry is IGNORED — length is measured here, never trusted
// from the caller.
function normalizeRef(raw) {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && typeof raw.path === "string") return raw.path;
  return null;
}

// Accept the shapes that exist in the database and return { bucket, path } with any
// token/query string stripped. Returns null for anything unrecognised — callers treat that
// as a per-ref error, never as "sign the whole bucket".
function parseRef(raw, defaultBucket) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const s = raw.trim();

  if (s.startsWith("gs://")) {
    const rest = s.slice(5);
    const i = rest.indexOf("/");
    if (i <= 0 || i === rest.length - 1) return null;
    return { bucket: rest.slice(0, i), path: safeDecode(rest.slice(i + 1)) };
  }

  if (s.startsWith("https://") || s.startsWith("http://")) {
    let u;
    try { u = new URL(s); } catch { return null; }

    // Firebase download URL: /v0/b/<bucket>/o/<url-encoded path>?alt=media&token=…
    // The token is deliberately DROPPED — that is the whole point of the migration.
    const fb = u.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);
    if (fb) return { bucket: fb[1], path: safeDecode(fb[2]) };

    if (u.hostname === "storage.googleapis.com") {
      const gcs = u.pathname.match(/^\/([^/]+)\/(.+)$/);
      if (gcs) return { bucket: gcs[1], path: safeDecode(gcs[2]) };
    }
    return null;
  }

  return { bucket: defaultBucket, path: s.replace(/^\/+/, "") };
}

// ── WAV length ───────────────────────────────────────────────────────────────────────
// Walks the RIFF chunk list for `fmt ` (sampleRate, channels, bit depth) and `data` (byte
// count). Returns null rather than guessing, so an unparsable file falls to FALLBACK_TTL_MS
// and the client's own renewal covers it.
function wavDuration(buf) {
  try {
    if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
      return null;
    }
    let off = 12, rate = 0, channels = 0, bits = 0, dataBytes = 0;
    while (off + 8 <= buf.length) {
      const id = buf.toString("ascii", off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (id === "fmt " && off + 24 <= buf.length) {
        channels = buf.readUInt16LE(off + 10);
        rate = buf.readUInt32LE(off + 12);
        bits = buf.readUInt16LE(off + 22);
      } else if (id === "data") {
        dataBytes = size;                  // the chunk header is enough; the audio is not read
        break;
      }
      off += 8 + size + (size % 2);        // chunks are word-aligned
    }
    const bytesPerSec = rate * channels * (bits / 8);
    if (!bytesPerSec || !dataBytes) return null;
    return +(dataBytes / bytesPerSec).toFixed(2);
  } catch {
    return null;
  }
}

// Header reads are throttled. A note page asked for 25 clips at once, which issued 25
// concurrent ranged downloads — 23 of them failed, and because the failures were cached
// those clips were left permanently "unmeasured" and fell back to a flat 30 minutes.
// Retried one at a time, every single one read correctly. So the files were always fine;
// the concurrency was not.
const HEADER_CONCURRENCY = 4;
let headerActive = 0;
const headerWaiting = [];

function headerSlot() {
  if (headerActive < HEADER_CONCURRENCY) { headerActive++; return Promise.resolve(); }
  return new Promise((release) => headerWaiting.push(release));
}

function headerRelease() {
  const next = headerWaiting.shift();
  if (next) next();            // hand the slot straight on; headerActive stays the same
  else headerActive--;
}

/**
 * Seconds of audio for `path`, or null. Read once per object, then remembered.
 *
 * The PROMISE is cached, not the value: two refs to the same clip in one request resolve
 * concurrently, so caching only the settled value let both miss and read the header twice.
 *
 * A FAILED read is NOT kept. Caching null would turn one transient error into a permanent
 * wrong answer for that object — which is exactly what happened before the throttle above.
 */
function durationOf(bucket, path, cache) {
  const hit = cache.get(path);
  if (hit !== undefined) return hit;

  const pending = (async () => {
    await headerSlot();
    try {
      const [head] = await bucket.file(path).download({ start: 0, end: WAV_HEADER_BYTES - 1 });
      return wavDuration(head);
    } catch {
      return null;                         // object may still sign fine; just unmeasured
    } finally {
      headerRelease();
    }
  })();

  cacheSet(cache, path, pending);
  // Forget an unmeasurable result so the next request can try again.
  pending.then((secs) => { if (secs === null) cache.delete(path); });
  return pending;
}

/** ttl and the spare time a reused link must still carry, for one ref. */
function policyFor(kind, durationSecs) {
  if (kind !== "audio") {
    return { ttlMs: IMAGE_TTL_MS, reuseMarginMs: REUSE_MARGIN_MS, duration: null };
  }
  if (durationSecs === null) {
    return { ttlMs: FALLBACK_TTL_MS, reuseMarginMs: REUSE_MARGIN_MS, duration: null };
  }
  const d = durationSecs * 1000;
  return { ttlMs: d + PAD_MS, reuseMarginMs: d + REUSE_MARGIN_MS, duration: durationSecs };
}

// Bucket- and cache-injected + exported for unit tests. Tests pass fresh Maps so one case
// cannot reuse a link the next case expects to be minted.
async function getMediaUrlsCore(refs, { bucket, now = Date.now(), links = linkCache, durations = durationCache }) {
  const defaultBucket = bucket.name;

  const entries = await Promise.all(refs.map(async (raw) => {
    const ref = normalizeRef(raw);
    if (ref === null) return { ref: raw, error: "unparseable" };

    const parsed = parseRef(ref, defaultBucket);
    if (!parsed) return { ref, error: "unparseable" };
    // Only ever sign objects in our own bucket — the service account can reach others.
    if (parsed.bucket !== defaultBucket) return { ref, error: "bucket-not-allowed" };

    const prefix = prefixFor(parsed.path);
    if (!prefix) return { ref, error: "path-not-allowed" };

    const secs = prefix.kind === "audio" ? await durationOf(bucket, parsed.path, durations) : null;
    return { ref, path: parsed.path, ...policyFor(prefix.kind, secs) };
  }));

  // One link per DISTINCT object, reused while it still carries its margin.
  const minted = new Map();
  let reused = 0;
  const distinct = [...new Map(entries.filter((e) => e.path).map((e) => [e.path, e])).values()];

  await Promise.all(distinct.map(async (e) => {
    const live = links.get(e.path);
    if (live && live.expiresAt - now >= e.reuseMarginMs) {
      minted.set(e.path, { url: live.url, expiresAt: live.expiresAt });
      reused++;
      return;
    }
    const expiresAt = now + e.ttlMs;        // exact, never rounded
    try {
      const [url] = await bucket.file(e.path).getSignedUrl({
        version: "v4",
        action: "read",
        expires: expiresAt,
      });
      cacheSet(links, e.path, { url, expiresAt });
      minted.set(e.path, { url, expiresAt });
    } catch (err) {
      // Most likely cause on a fresh project: the runtime service account lacks
      // roles/iam.serviceAccountTokenCreator on itself, so signBlob is denied.
      // NOT cached — a transient denial must not poison later requests.
      minted.set(e.path, { error: `sign-failed: ${(err && err.message) || err}` });
    }
  }));

  const results = entries.map((e) => {
    if (e.error) return { ref: e.ref, error: e.error };
    const m = minted.get(e.path);
    return m.url
      ? { ref: e.ref, url: m.url, expiresAt: m.expiresAt, duration: e.duration }
      : { ref: e.ref, error: m.error };
  });

  // One structured line per call. Per-ref rejections are returned as DATA, which means that
  // without this log they are invisible server-side and can only be diagnosed from the
  // caller's browser console.
  const outcomes = results.reduce((acc, r) => {
    const key = r.error ? (r.error.startsWith("sign-failed") ? "sign-failed" : r.error) : "ok";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  console.log(JSON.stringify({
    fn: "getMediaUrls",
    refs: refs.length,
    distinctObjects: distinct.length,
    linksMinted: distinct.length - reused,
    linksReused: reused,              // >0 proves viewers are sharing a URL
    allowedBucket: defaultBucket,
    outcomes,
    sample: entries.slice(0, 3).map((e) => ({
      ref: String(e.ref).slice(0, 140),
      parsedPath: e.path ?? null,
      durationSecs: e.duration ?? null,
      ttlMs: e.ttlMs ?? null,
      error: e.error ?? null,
    })),
  }));

  return { results };
}

function assertAuthed(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign-in required.");
}

exports.getMediaUrls = onCall(async (request) => {
  assertAuthed(request);
  const refs = request.data && request.data.refs;
  if (!Array.isArray(refs) || refs.length === 0) {
    throw new HttpsError("invalid-argument", "refs must be a non-empty array.");
  }
  if (refs.length > MAX_REFS) {
    throw new HttpsError("invalid-argument", `refs must hold at most ${MAX_REFS} entries.`);
  }
  return getMediaUrlsCore(refs, { bucket: admin.storage().bucket() });
});

// exported for unit tests
exports.getMediaUrlsCore = getMediaUrlsCore;
exports.parseRef = parseRef;
exports.normalizeRef = normalizeRef;
exports.wavDuration = wavDuration;
exports.PAD_MS = PAD_MS;
exports.REUSE_MARGIN_MS = REUSE_MARGIN_MS;
exports.IMAGE_TTL_MS = IMAGE_TTL_MS;
exports.FALLBACK_TTL_MS = FALLBACK_TTL_MS;
