// atc_ondemand.js — on-demand ATC generation actions invoked from the dashboard.
//
//   regenerateAtcDoc({docid})  — item 3: a "dataincomplete" doc is shown on the
//     dashboard; clicking Generate re-resolves its sources (own + pairing, across
//     the transferredfrom chain) via the shared resolver. If now complete it
//     builds the prompt and flips status → "pending" (the pod loop then drains
//     it); if still incomplete it refreshes `stagedata` and stays "dataincomplete"
//     so the UI can show exactly what's still missing.
//
//   rebuildAtcPrompt({docid, requeue}) — item 5: a "pending" doc's sources are
//     already captured in `stagedata`; this rebuilds ONLY the prompt from that
//     existing stagedata (no source re-resolution) — e.g. after the base prompt /
//     systemprompt changed. Keeps status "pending". Refuses on processing/
//     completed/error unless requeue=true (which flips it back to pending).
//
// Both share the resolver + prompt builder with S0/S1, so behaviour never drifts.
// Cores are DB-injected + exported for unit tests; onCall wrappers are the
// deployed transport (browser dashboard, Firebase-Auth gated).
"use strict";

const path = require("path");
const fs = require("fs");
const { getFirestore } = require("firebase-admin/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const {
  resolveStageData,
  buildPromptFromStageData,
} = require("./atc_generation_resolver");

const CLASSIFY_PROMPT_DOCID = "atcprompts";
const BASE_PROMPT_PATH = path.join(__dirname, "..", "..", "prompts", "prompt_1_ai_atc_generator.md");
const BASE_PROMPT = fs.readFileSync(BASE_PROMPT_PATH, "utf8");

function queueIdFromRef(ref) {
  if (!ref) return null;
  if (typeof ref.id === "string" && ref.id) return ref.id;
  const p = typeof ref === "string" ? ref : ref.path;
  return typeof p === "string" ? p.split("/").pop() : null;
}

// ---------- item 3: regenerate a doc on demand ----------
async function regenerateAtcDocCore(docid, { defaultDb, atcDb, formsDb }) {
  if (!docid) return { ok: false, reason: "missing_docid" };
  const ref = atcDb.collection("queue_atc_generation").doc(docid);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, reason: "doc_not_found" };
  const docData = snap.data();

  // Don't disturb an in-flight or finished job.
  if (["processing", "completed"].includes(docData.status)) {
    return { ok: false, reason: `status_${docData.status}_not_regeneratable` };
  }

  const queueid = queueIdFromRef(docData.queueref);
  if (!queueid) return { ok: false, reason: "no_queueref" };
  const queueSnap = await defaultDb.doc(`queue generation/${queueid}`).get();
  if (!queueSnap.exists) return { ok: false, reason: `queue_${queueid}_not_found` };
  const queueData = queueSnap.data();

  const tokenId = docData.queue_token_id;
  const tokenSnap = await defaultDb.collection("queue_token").doc(tokenId).get();
  if (!tokenSnap.exists) return { ok: false, reason: `token_${tokenId}_not_found` };
  const tokenData = tokenSnap.data();

  const stageCfg = (queueData.atcrequiredstages || []).find((s) => s.stage === docData.stage);
  if (!stageCfg) return { ok: false, reason: `stage_not_in_config` };
  if (stageCfg.generateatc !== true) return { ok: false, reason: "generateatc_false" };

  const resolved = await resolveStageData({
    queueData, queueRef: queueSnap.ref, tokenData, queueTokenId: tokenId,
    profileid: docData.profileid, stage: docData.stage, stageCfg, defaultDb, formsDb,
  });
  if (!resolved.ok) return { ok: false, reason: `own_unresolvable:${resolved.reason}` };

  const { stagedata, status } = resolved;
  const update = {
    stagedata,
    data: stagedata[docData.stage].data,
    sourceref: resolved.ownSourceref,
    type: resolved.ownType,
    regeneratedAt: new Date(),
  };
  const missing = Object.entries(stagedata)
    .filter(([, v]) => v.status === "missing")
    .map(([s, v]) => ({ stage: s, category: v.category }));

  if (status === "dataincomplete") {
    update.status = "dataincomplete";
    await ref.set(update, { merge: true });
    return { ok: true, status: "dataincomplete", missing };
  }

  // Complete → build prompt + set pending. This transition is an UPDATE, so the
  // onQueueAtcGenerationCreate (S1) trigger does NOT fire — we build here.
  const promptSnap = await defaultDb.collection("classify").doc(CLASSIFY_PROMPT_DOCID).get();
  if (!promptSnap.exists) return { ok: false, reason: "atcprompts_missing" };
  const { prompt, resolvedCount } = buildPromptFromStageData(stagedata, BASE_PROMPT);
  update.status = "pending";
  update.prompt = prompt;
  update.systemprompt = promptSnap.data().systemprompt;
  update.promptUpdatedAt = new Date();
  update.checkpoint = true;
  await ref.set(update, { merge: true });
  return { ok: true, status: "pending", resolvedStages: resolvedCount, missing };
}

// ---------- item 5: rebuild prompt only (no source re-resolution) ----------
async function rebuildAtcPromptCore(docid, { defaultDb, atcDb, requeue = false }) {
  if (!docid) return { ok: false, reason: "missing_docid" };
  const ref = atcDb.collection("queue_atc_generation").doc(docid);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, reason: "doc_not_found" };
  const docData = snap.data();

  if (docData.status === "dataincomplete") {
    return { ok: false, reason: "dataincomplete_use_regenerate" };
  }
  const stagedata = docData.stagedata;
  if (!stagedata || typeof stagedata !== "object") return { ok: false, reason: "no_stagedata" };

  // Only safe while pending. processing/completed/error need an explicit requeue,
  // which flips the doc back to pending so the rebuilt prompt actually re-runs.
  if (["processing", "completed", "error"].includes(docData.status) && !requeue) {
    return { ok: false, reason: `status_${docData.status}_needs_requeue` };
  }

  const promptSnap = await defaultDb.collection("classify").doc(CLASSIFY_PROMPT_DOCID).get();
  if (!promptSnap.exists) return { ok: false, reason: "atcprompts_missing" };
  const { prompt, resolvedCount } = buildPromptFromStageData(stagedata, BASE_PROMPT);
  if (resolvedCount === 0) return { ok: false, reason: "no_resolved_stages" };

  const update = {
    prompt,
    systemprompt: promptSnap.data().systemprompt,
    promptUpdatedAt: new Date(),
    status: "pending",
  };
  if (requeue) {
    // clear claim/terminal markers so the pod re-claims and re-runs from scratch
    const { FieldValue } = require("firebase-admin/firestore");
    update.claimedBy = FieldValue.delete();
    update.startedAt = FieldValue.delete();
    update.finalizedAt = FieldValue.delete();
    update.completedAt = FieldValue.delete();
  }
  await ref.set(update, { merge: true });
  return { ok: true, status: "pending", requeued: !!requeue, promptChars: prompt.length };
}

// ---------- deployed onCall wrappers ----------
function assertAuthed(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign-in required.");
}

exports.regenerateAtcDoc = onCall(async (request) => {
  assertAuthed(request);
  const docid = request.data && request.data.docid;
  const res = await regenerateAtcDocCore(docid, {
    defaultDb: getFirestore(),
    atcDb: getFirestore("firestore-atc"),
    formsDb: getFirestore("firestore-forms"),
  });
  if (!res.ok) throw new HttpsError("failed-precondition", res.reason);
  return res;
});

exports.rebuildAtcPrompt = onCall(async (request) => {
  assertAuthed(request);
  const docid = request.data && request.data.docid;
  const requeue = !!(request.data && request.data.requeue);
  const res = await rebuildAtcPromptCore(docid, {
    defaultDb: getFirestore(),
    atcDb: getFirestore("firestore-atc"),
    requeue,
  });
  if (!res.ok) throw new HttpsError("failed-precondition", res.reason);
  return res;
});

// exported for unit tests
exports.regenerateAtcDocCore = regenerateAtcDocCore;
exports.rebuildAtcPromptCore = rebuildAtcPromptCore;
