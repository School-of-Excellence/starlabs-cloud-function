// atc_generation_resolver.js — single source of truth for the redesigned
// queue_atc_generation workflow. Ported verbatim (behaviour-for-behaviour) from
// the real-data-validated preview scripts/atc-generation-doc-preview.js, so the
// deployed trigger, the on-demand "regenerate" button, and the prompt-rebuild
// helper all resolve sources + build prompts IDENTICALLY.
//
// Everything here is DB-injected (defaultDb, formsDb) and free of module-level
// Firebase side effects, so it is unit-testable and reusable from both cloud
// functions (getFirestore()) and ADC scripts (admin.initializeApp()).
//
// Design (see functions/CLAUDE.md journal + the preview header):
//   - A gen doc is created only when the stage's atcrequiredstages entry has
//     generateatc === true (gated by the caller).
//   - Own + pairing stage sources are resolved level-by-level: current queue
//     first, then walk queue_token.transferredfrom / .tokentransferredfrom one
//     hop at a time, re-checking each ancestor's own active stage list.
//   - Zoom transcripts are read DIRECTLY off the live assignment doc (populated
//     proactively by zoom_transcript_capture.js) — never a synchronous Zoom API
//     call at crossing time.
//   - pairingstages may be a legacy flat array OR {mandatory, atleastonerequired}.
//   - status = "dataincomplete" if any mandatory pairing stage is missing, OR if
//     atleastonerequired stages are configured but none resolved; else complete.
"use strict";

const { buildUpLifeAspirationReport } = require("./atc_helpers");

const DEFAULT_MAX_HOPS = 25;

// Keep mandatory / atleastonerequired SEPARATE — they have different
// completeness rules. A legacy flat array is treated as all-mandatory (closest
// to today's behaviour, which never differentiates).
function normalizePairingStages(raw) {
  if (Array.isArray(raw)) {
    return { mandatory: raw.slice(), atleastonerequired: [], isLegacyShape: true };
  }
  if (raw && typeof raw === "object") {
    return {
      mandatory: raw.mandatory || [],
      atleastonerequired: raw.atleastonerequired || [],
      isLegacyShape: false,
    };
  }
  return { mandatory: [], atleastonerequired: [], isLegacyShape: false };
}

function locateStageConfig(queueData, stageName) {
  return (queueData.atcrequiredstages || []).find((s) => s.stage === stageName) || null;
}

// UNION of the base queue's stages and (if any) the token's variation stages —
// never variation-only. A variation may ADD stages but a degenerate variation
// (e.g. stages:["Transfered"]) must not silently subtract real ones.
async function resolveActiveStages(queueData, tokenData, defaultDb) {
  const base = queueData.stages || [];
  if (tokenData && tokenData.variationid) {
    const varSnap = await defaultDb.collection("queue variation").doc(tokenData.variationid).get();
    if (varSnap.exists && Array.isArray(varSnap.data().stages)) {
      return [...new Set([...base, ...varSnap.data().stages])];
    }
  }
  return base;
}

// For a PAIRING stage, stageproperty is a valid type source ONLY when the stage
// is also an active stage (stageproperty is a proven-unreliable superset).
// atcrequiredstages is a curated registration — trusted unconditionally, same
// as the deployed processStage.
function locatePairingStageType(queueData, stageName, activeStages) {
  if (activeStages.includes(stageName)) {
    const prop = (queueData.stageproperty || {})[stageName];
    if (prop) {
      if (prop.actiontype === "form") return { type: "form", via: "stageproperty.actiontype" };
      if (prop.enablezoom === true) return { type: "zoom", via: "stageproperty.enablezoom" };
    }
  }
  const cfg = locateStageConfig(queueData, stageName);
  if (cfg && cfg.type) return { type: cfg.type, via: "atcrequiredstages.type" };
  return null;
}

// Resolve the form/zoom source data for one stage, at whichever queue-level it
// is configured under. Never writes; never calls the live Zoom API.
async function resolveStageSource({ stageName, stageType, queueData, queueRef, profileid, defaultDb, formsDb }) {
  if (stageType === "form") {
    const formref = (queueData.stageproperty || {})[stageName]?.actionresource;
    if (!formref || !formref.id) return { ok: false, reason: `NO_ACTIONRESOURCE for "${stageName}"` };
    const snap = await formsDb.collection("formsByClient")
      .where("profileid", "==", profileid)
      .where("formid", "==", formref.id)
      .where("queueref", "==", formsDb.doc(queueRef.path))
      .orderBy("date", "desc")
      .get();
    if (snap.empty) return { ok: false, reason: `NO_FORM_SUBMISSION formid=${formref.id}` };
    const element = snap.docs[0].data();
    const formData = [];
    for (const el of element.formarray || []) {
      if (["label", "video", "audio"].includes(el.type)) continue;
      if (!el.value) continue;
      formData.push({
        questions: el.fieldname,
        answer: el.type === "date" ? new Date(el.value.toDate()).toISOString().substring(0, 10) : el.value,
      });
    }
    const data = await buildUpLifeAspirationReport(formData, element.formname);
    // Store the source as a PATH STRING, not a DocumentReference: this doc lives
    // in firestore-atc but the form lives in firestore-forms, and a cross-database
    // DocumentReference is unsupported (Firestore mis-resolves it to the current
    // DB + warns). The path string is all any consumer (dedup) needs.
    return { ok: true, type: "form", sourceref: snap.docs[0].ref.path, data, detail: `formid=${formref.id}` };
  }

  if (stageType === "zoom") {
    const logSnap = await defaultDb.collection("queue stage log")
      .where("currentstage", "==", stageName)
      .where("status", "==", "instudio")
      .where("profile_id", "==", profileid)
      .where("queueref", "==", queueRef)
      .orderBy("logdate", "desc")
      .get();
    if (logSnap.empty) return { ok: false, reason: "NO_STUDIO_SESSION" };
    const logData = logSnap.docs[0].data();
    if (!logData.liveassignmentid) return { ok: false, reason: "NO_LIVEASSIGNMENT" };

    const liveSnap = await defaultDb.collection("live assignment").doc(logData.liveassignmentid).get();
    const liveData = liveSnap.exists ? liveSnap.data() : null;
    if (!liveData) return { ok: false, reason: `LIVEASSIGNMENT_NOT_FOUND liveassignmentid=${logData.liveassignmentid}` };
    if (!liveData.transcript_text || !String(liveData.transcript_text).trim()) {
      const reason = liveData.zoomdata?.id
        ? `TRANSCRIPT_NOT_YET_CAPTURED meetingid=${liveData.zoomdata.id}`
        : "NO_ZOOM_MEETING";
      return { ok: false, reason };
    }
    return {
      ok: true,
      type: "zoom",
      // path string, not a cross-database DocumentReference (live assignment
      // lives in the default DB, this doc in firestore-atc) — see form branch.
      sourceref: liveSnap.ref.path,
      detail: `liveassignmentid=${logData.liveassignmentid}`,
      data: {
        transcript_text: liveData.transcript_text,
        transcript_raw: liveData.transcript_raw,
        zoom_topic: liveData.zoom_topic,
        zoom_start_time: liveData.zoom_start_time,
        zoom_duration: liveData.zoom_duration,
      },
    };
  }

  return { ok: false, reason: `UNKNOWN_STAGE_TYPE ${stageType}` };
}

// Compute completeness status from a resolved stagedata map + normalized pairing.
// Returns "dataincomplete" | "complete" (the caller maps "complete" → pending).
function computeStatus(stagedata, norm) {
  const mandatoryMissing = Object.values(stagedata)
    .filter((v) => v.category === "mandatory" && v.status === "missing").length;
  const atLeastOneConfigured = norm.atleastonerequired.length > 0;
  const atLeastOneResolved = Object.values(stagedata)
    .filter((v) => v.category === "atleastonerequired" && v.status === "resolved").length;
  return (mandatoryMissing > 0 || (atLeastOneConfigured && atLeastOneResolved === 0))
    ? "dataincomplete"
    : "complete";
}

/**
 * Resolve own + all pairing sources for one (profile, queue, stage) into a
 * stagedata map, walking the transferredfrom chain level-by-level. Never writes.
 *
 * @returns {Promise<{
 *   ok: boolean, reason?: string,        // ok=false ⇒ own-stage source unresolvable (caller no-ops)
 *   ownType?: string, ownSourceref?: any,
 *   stagedata?: object,                  // stagename -> {queuetokenid,queueid,data,category,status,type,sourceref}
 *   status?: string,                     // "dataincomplete" | "complete"
 *   norm?: object,
 * }>}
 */
async function resolveStageData({
  queueData, queueRef, tokenData, queueTokenId, profileid, stage, stageCfg,
  defaultDb, formsDb, maxHops = DEFAULT_MAX_HOPS,
}) {
  // 1) Own-stage source is mandatory — if it can't be resolved, no doc is created.
  const ownSrc = await resolveStageSource({
    stageName: stage, stageType: stageCfg.type, queueData, queueRef, profileid, defaultDb, formsDb,
  });
  if (!ownSrc.ok) return { ok: false, reason: ownSrc.reason };

  const norm = normalizePairingStages(stageCfg.pairingstages);
  const categoryOf = new Map();
  for (const s of norm.mandatory) if (s !== stage) categoryOf.set(s, "mandatory");
  for (const s of norm.atleastonerequired) if (s !== stage && !categoryOf.has(s)) categoryOf.set(s, "atleastonerequired");

  const stagedata = {
    [stage]: {
      queuetokenid: queueTokenId, queueid: queueRef.id, data: ownSrc.data,
      category: "own", status: "resolved", type: ownSrc.type, sourceref: ownSrc.sourceref,
    },
  };

  const remaining = new Set(categoryOf.keys());
  // For a stage that type-matches at a level but whose SOURCE isn't there, we
  // keep walking and remember the last level's type/reason so a never-resolved
  // stage still finalizes as `missing` with useful context.
  const lastMiss = new Map();
  let levelQueueData = queueData, levelQueueRef = queueRef, levelTokenData = tokenData, levelTokenId = queueTokenId, levelLabel = queueRef.id;
  let hops = 0;
  const visitedTokenIds = new Set([queueTokenId]);

  while (remaining.size > 0) {
    const activeStages = await resolveActiveStages(levelQueueData, levelTokenData, defaultDb);
    for (const pStage of [...remaining]) {
      const typeMatch = locatePairingStageType(levelQueueData, pStage, activeStages);
      if (!typeMatch) continue; // not part of this level's flow — try the next level back
      const category = categoryOf.get(pStage);
      const src = await resolveStageSource({
        stageName: pStage, stageType: typeMatch.type, queueData: levelQueueData, queueRef: levelQueueRef, profileid, defaultDb, formsDb,
      });
      if (src.ok) {
        stagedata[pStage] = { queuetokenid: levelTokenId, queueid: levelLabel, data: src.data, category, status: "resolved", type: src.type, sourceref: src.sourceref };
        remaining.delete(pStage);
      } else {
        // Type-matched here (this level's config lists the stage — often leftover
        // template config) but the participant's actual source isn't at THIS
        // level. Do NOT finalize as missing: the real submission may live deeper
        // on the transferredfrom lineage (e.g. a form submitted under an ancestor
        // queue). Keep it in `remaining` and retry at the next level back.
        lastMiss.set(pStage, { type: typeMatch.type, reason: src.reason, queueid: levelLabel });
      }
    }
    if (remaining.size === 0) break;

    if (!levelTokenData || !levelTokenData.transferredfrom || !levelTokenData.tokentransferredfrom) break;
    if (++hops > maxHops) break;
    const ancestorQueueRef = levelTokenData.transferredfrom;
    const ancestorTokenRef = levelTokenData.tokentransferredfrom;
    if (visitedTokenIds.has(ancestorTokenRef.id)) break; // circular chain
    visitedTokenIds.add(ancestorTokenRef.id);
    const [aq, at] = await Promise.all([ancestorQueueRef.get(), ancestorTokenRef.get()]);
    if (!aq.exists || !at.exists) break; // dangling ref
    levelQueueData = aq.data(); levelQueueRef = ancestorQueueRef; levelTokenData = at.data(); levelTokenId = ancestorTokenRef.id; levelLabel = ancestorQueueRef.id;
  }

  // Stages never resolved at any level on the chain → finalize as missing,
  // carrying the last level's type/queue context when we had a type-match.
  for (const pStage of remaining) {
    const lm = lastMiss.get(pStage) || {};
    stagedata[pStage] = { queuetokenid: null, queueid: lm.queueid || null, data: null, category: categoryOf.get(pStage), status: "missing", type: lm.type || null, sourceref: null };
  }

  return { ok: true, ownType: ownSrc.type, ownSourceref: ownSrc.sourceref, stagedata, status: computeStatus(stagedata, norm), norm };
}

// Build the PARTICIPANT_DATA / TRANSCRIPT block from resolved stage entries.
// Byte-for-byte identical to processAtcGenerationDoc's original render logic.
function buildParticipantBlock(stageEntries) {
  const formDocs = stageEntries.filter((d) => d.type === "form");
  const zoomDocs = stageEntries.filter((d) => d.type === "zoom");
  const participantType = formDocs.some((d) => /aspiration/i.test(d.stage || "")) ? "first_time" : "returning";
  const formType = formDocs.map((d) => d.stage).filter(Boolean).join(", ") || stageEntries[0]?.stage || "";
  const renderForm = (d) => `${d.stage}: ${typeof d.data === "object" ? JSON.stringify(d.data) : String(d.data ?? "")}`;
  const renderZoom = (d) => `${d.stage}: ${typeof d.data === "object" ? (d.data.transcript_text || JSON.stringify(d.data)) : String(d.data ?? "")}`;
  const participantBlock = [
    `PARTICIPANT_TYPE: ${participantType}`,
    `FORM_TYPE: ${formType}`,
    `PARTICIPANT_DATA:\n${formDocs.map(renderForm).join("\n\n")}`,
    `TRANSCRIPT:\n${zoomDocs.map(renderZoom).join("\n\n")}`,
  ].join("\n\n");
  return { participantType, formType, participantBlock };
}

// Build the full prompt string from a stagedata map (only status:resolved
// entries feed the render — same tolerant behaviour as the old trigger).
function buildPromptFromStageData(stagedata, basePrompt) {
  const resolvedEntries = Object.entries(stagedata)
    .filter(([, v]) => v.status === "resolved")
    .map(([stage, v]) => ({ stage, type: v.type, data: v.data }));
  const { participantType, formType, participantBlock } = buildParticipantBlock(resolvedEntries);
  const lastsentence = "Begin now with Part 1. Do not stop until the JSON closing brace has been emitted.";
  const prompt = `${basePrompt}\n\n${participantBlock}\n\n${lastsentence}`;
  return { prompt, participantType, formType, resolvedCount: resolvedEntries.length };
}

module.exports = {
  DEFAULT_MAX_HOPS,
  normalizePairingStages,
  locateStageConfig,
  resolveActiveStages,
  locatePairingStageType,
  resolveStageSource,
  resolveStageData,
  computeStatus,
  buildParticipantBlock,
  buildPromptFromStageData,
};
