// Signed-URL migration — VideoAsk (M-5).
//
// participantvideoask.fileurl used to hold a permanent download URL. New app versions
// store the Storage PATH instead (videoask/videoask/<date>_<name>). Publitio cannot read
// a path, so videoAskHLS asks this helper for a URL it can fetch:
//   - legacy http(s) value  -> passed through unchanged (old app versions, old rows)
//   - videoask/videoask/... -> V4 signed READ URL with a FIXED 10-minute lifetime
//   - anything else         -> rejected (never signs outside the VideoAsk folder)
//
// Why a fixed 10 minutes: Google Storage checks a signed URL's expiry when a download
// STARTS (a running download finishes after expiry), Publitio fetches during the
// files/create call, and videoAskHLS itself times out well before 10 minutes.
"use strict";

const VIDEOASK_PREFIX = "videoask/videoask/";
const SOURCE_TTL_MS = 10 * 60 * 1000;

function isHttpUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

/** True only for a clean object path inside the VideoAsk folder. */
function isVideoAskPath(value) {
  if (typeof value !== "string") return false;
  const p = value.trim();
  return p.startsWith(VIDEOASK_PREFIX) &&
    p.length > VIDEOASK_PREFIX.length &&
    !p.includes("..") &&
    !p.includes("\\");
}

/**
 * Resolve participantvideoask.fileurl to a URL Publitio can fetch.
 * No Storage metadata read and no download: signing is a local/IAM operation only.
 * @param {string} fileurl  value from the document
 * @param {{bucket: object, now?: number}} deps  bucket = admin.storage().bucket() (stubbed in tests)
 */
async function resolveVideoAskSourceUrl(fileurl, { bucket, now = Date.now() } = {}) {
  if (fileurl == null || (typeof fileurl === "string" && fileurl.trim() === "")) {
    return { error: "missing-fileurl" };
  }
  if (isHttpUrl(fileurl)) return { url: fileurl.trim(), kind: "legacy-url" };
  if (!isVideoAskPath(fileurl)) return { error: "path-outside-videoask" };

  const path = fileurl.trim();
  const expiresAt = now + SOURCE_TTL_MS;
  try {
    const [url] = await bucket.file(path).getSignedUrl({ version: "v4", action: "read", expires: expiresAt });
    return { url, kind: "signed", path, ttlMs: SOURCE_TTL_MS, expiresAt };
  } catch (err) {
    return { error: `sign-failed: ${(err && err.message) || err}` };
  }
}

/*
 * Publitio folder per environment, chosen from the RUNNING project id.
 *
 * Publitio's files/create documents `folder` as "Folder ID to place the file in" (default:
 * root). It is an ID, not a name, and the docs do not say what happens for an unknown value.
 * So each folder must be created once in the Publitio dashboard and its ID pasted here.
 * Until an ID is filled in, conversion is SKIPPED with an error (fail closed) rather than
 * guessing a name or silently uploading test videos next to production ones.
 */
const PUBLITIO_VIDEOASK_FOLDERS = {
  "starlabs-test": { name: "videoask-test", id: "8MLXGqjJ" },               // TODO: paste Publitio folder ID
  "fir-sample-aae4a": { name: "videoask-breakthroughs", id: "2xz6o8HS" },   // TODO: paste Publitio folder ID
};

/** Project id of the running function (GCLOUD_PROJECT, else FIREBASE_CONFIG.projectId). */
function runningProjectId(env = process.env) {
  if (env.GCLOUD_PROJECT) return env.GCLOUD_PROJECT;
  try { return JSON.parse(env.FIREBASE_CONFIG || "{}").projectId || null; } catch { return null; }
}

/**
 * @returns {{folder: string, name: string, projectId: string} | {error: string, projectId: string|null}}
 */
function videoAskPublitioFolder(projectId, folders = PUBLITIO_VIDEOASK_FOLDERS) {
  const entry = projectId ? folders[projectId] : undefined;
  if (!entry) return { error: "unknown-project", projectId: projectId || null };
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  if (!id) return { error: `publitio-folder-id-not-set (${entry.name})`, projectId };
  return { folder: id, name: entry.name, projectId };
}

/*
 * Should a participantvideoask WRITE start a Publitio conversion?
 *
 * The Product-delivery flow (arenaVideoAsk.dart) CREATES the document before the upload
 * finishes, without `fileurl`; AppServices.uploadVideoAsk adds `fileurl` later with an
 * UPDATE. An on-create trigger therefore never saw a file. Converting on write is safe only
 * with this guard:
 *   - document exists after the write, `fileurl` is a non-empty string,
 *   - not converted yet (no `hls`, `convertedtohls` not true),
 *   - and `fileurl` is new or changed in THIS write (so unrelated updates — tags,
 *     highlights, the function's own `hls` write — never start a second conversion).
 * The function's own success write sets `hls`, so the next invocation stops here: bounded.
 */
function shouldConvertVideoAsk(before, after) {
  if (!after) return { convert: false, reason: "deleted" };
  const url = after.fileurl;
  if (typeof url !== "string" || url.trim() === "") return { convert: false, reason: "no-fileurl" };
  if (after.hls || after.convertedtohls === true) return { convert: false, reason: "already-converted" };
  const prev = before ? before.fileurl : undefined;
  if (prev === url) return { convert: false, reason: "fileurl-unchanged" };
  return { convert: true, reason: before ? "fileurl-set-or-changed" : "created-with-fileurl" };
}

module.exports = {
  resolveVideoAskSourceUrl,
  shouldConvertVideoAsk,
  videoAskPublitioFolder,
  runningProjectId,
  PUBLITIO_VIDEOASK_FOLDERS,
  isVideoAskPath,
  isHttpUrl,
  VIDEOASK_PREFIX,
  SOURCE_TTL_MS,
};
