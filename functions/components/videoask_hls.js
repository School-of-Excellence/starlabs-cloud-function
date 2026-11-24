// VideoAsk → Publitio conversion with a status field (signed-URL migration M-5).
//
// participantvideoask.hlsstatus:  inprogress | success | failed | retry   (+ hlserror, hlsupdatedat)
//
//   new upload (fileurl new/changed, no hls)  ─claim→ inprogress ─convert→ success | failed
//   admin sets hlsstatus = 'retry'            ─claim→ inprogress ─convert→ success | failed
//
// The claim is a Firestore TRANSACTION, so a double click or two overlapping triggers can
// convert a record only once. Every write this module makes is a status write that
// decideVideoAskAction() maps to "none", so the function never re-triggers itself.
// Out of scope (by decision): scheduled automatic retry, retry limits / attempt counters.
"use strict";

const {
  resolveVideoAskSourceUrl,
  videoAskPublitioFolder,
  shouldConvertVideoAsk,
} = require("./videoask_source_url");

const STATUS = Object.freeze({
  INPROGRESS: "inprogress",
  SUCCESS: "success",
  FAILED: "failed",
  RETRY: "retry",
});

/** What a write to participantvideoask/{id} should do: "convert" | "retry" | "none". */
function decideVideoAskAction(before, after) {
  if (!after) return { action: "none", reason: "deleted" };
  const status = after.hlsstatus ?? null;
  const prevStatus = before ? (before.hlsstatus ?? null) : null;

  if (status === STATUS.RETRY) {
    // Only the transition INTO retry starts work; a second write of 'retry' is ignored.
    if (prevStatus === STATUS.RETRY) return { action: "none", reason: "retry-already-requested" };
    return { action: "retry", reason: "retry-requested" };
  }
  if (status === STATUS.INPROGRESS) return { action: "none", reason: "in-progress" };

  const c = shouldConvertVideoAsk(before, after);
  if (!c.convert) return { action: "none", reason: c.reason };
  return { action: "convert", reason: c.reason };
}

/**
 * Claim the record for one conversion, inside a transaction.
 * @returns {Promise<{claimed: true, data: object} | {claimed: false, reason: string}>}
 */
async function claimVideoAsk(db, ref, action, now) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { claimed: false, reason: "deleted" };
    const d = snap.data() || {};
    if (d.hls || d.convertedtohls === true) {
      // A retry on something already converted just closes the request.
      if (action === "retry" && d.hlsstatus !== STATUS.SUCCESS) {
        tx.update(ref, { hlsstatus: STATUS.SUCCESS, hlserror: null, hlsupdatedat: now });
      }
      return { claimed: false, reason: "already-converted" };
    }
    if (action === "retry" && d.hlsstatus !== STATUS.RETRY) return { claimed: false, reason: "retry-already-claimed" };
    if (action === "convert" && (d.hlsstatus === STATUS.INPROGRESS || d.hlsstatus === STATUS.RETRY)) {
      return { claimed: false, reason: `status-${d.hlsstatus}` };
    }
    tx.update(ref, { hlsstatus: STATUS.INPROGRESS, hlserror: null, hlsupdatedat: now });
    return { claimed: true, data: d };
  });
}

/**
 * The Publitio steps (unchanged from the original videoAskHLS): signed source → upload into the
 * environment folder → 480p version. Never throws.
 * @returns {Promise<{ok: true, result: object} | {ok: false, error: string}>}
 */
async function convertVideoAsk({ id, data, publitio, bucket, projectId, log = console }) {
  const folder = videoAskPublitioFolder(projectId);
  if (folder.error) return { ok: false, error: `no Publitio folder for project ${folder.projectId} (${folder.error})` };

  const source = await resolveVideoAskSourceUrl(data.fileurl, { bucket });
  if (source.error) return { ok: false, error: `no source for Publitio (${source.error})` };
  if (source.kind === "signed") log.log(`videoAskHLS ${id}: signed ${source.path} ttlMs=${source.ttlMs}`);

  let result;
  try {
    result = await publitio.uploadRemoteFile({ file_url: source.url, privacy: 1, option_hls: 0, folder: folder.folder });
  } catch (err) {
    return { ok: false, error: `Publitio upload error: ${(err && err.message) || err}` };
  }
  log.log(result);
  if (!result || result.code != 201) {
    const code = result && result.code;
    const msg = result && (result.error || result.message);
    return { ok: false, error: `Publitio upload failed: ${code}${msg ? ` ${typeof msg === "string" ? msg : JSON.stringify(msg)}` : ""}` };
  }
  try {
    const version = await publitio.call("/files/versions/create/" + result.id, "POST", { extension: "mp4", options: "h_480" });
    log.log("Version Created ---------", version);
  } catch (err) {
    return { ok: false, error: `Publitio 480p version error: ${(err && err.message) || err}` };
  }
  return { ok: true, result };
}

/**
 * Handle one write event. deps: { db, ref, publitio(), bucket, projectId, now(), log }.
 * publitio is a factory so secrets are only read when a conversion really runs.
 */
async function handleVideoAskWrite({ id, before, after }, deps) {
  const log = deps.log || console;
  const decision = decideVideoAskAction(before, after);
  if (decision.action === "none") {
    log.log(`videoAskHLS ${id}: no conversion (${decision.reason})`);
    return { outcome: "none", reason: decision.reason };
  }

  const claim = await claimVideoAsk(deps.db, deps.ref, decision.action, deps.now());
  if (!claim.claimed) {
    log.log(`videoAskHLS ${id}: not claimed (${claim.reason})`);
    return { outcome: "not-claimed", reason: claim.reason };
  }

  const res = await convertVideoAsk({
    id, data: claim.data, publitio: deps.publitio(), bucket: deps.bucket, projectId: deps.projectId, log,
  });
  if (res.ok) {
    await deps.ref.update({
      hls: res.result, convertedtohls: true,
      hlsstatus: STATUS.SUCCESS, hlserror: null, hlsupdatedat: deps.now(),
    });
    log.log(`videoAskHLS ${id}: success (${decision.action})`);
    return { outcome: "success" };
  }
  await deps.ref.update({ hlsstatus: STATUS.FAILED, hlserror: String(res.error).slice(0, 500), hlsupdatedat: deps.now() });
  log.error(`videoAskHLS ${id}: failed (${decision.action}) — ${res.error}`);
  return { outcome: "failed", error: res.error };
}

module.exports = { STATUS, decideVideoAskAction, claimVideoAsk, convertVideoAsk, handleVideoAskWrite };
