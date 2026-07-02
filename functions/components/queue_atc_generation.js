// Firestore
const { getFirestore } = require("firebase-admin/firestore");
const adminDefault = getFirestore();
const adminATC = getFirestore("firestore-atc");

const path = require('path');
const fs = require('fs');
//components imports
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const { alertAtc } = require("./atc_alerts");
const { recordDropoff } = require("../scope-enhancement-atc-pipeline/se_atc_telemetry");

const CLASSIFY_PROMPT_DOCID = "atcprompts";
const RUN_JOBREQUEST_URL = "https://us-central1-fir-sample-aae4a.cloudfunctions.net/run_jobrequest";

const functionsApiKey = defineSecret("FUNCTIONS_SHARED_SECRET");
const BASE_PROMPT_PATH = path.join(__dirname, "..", "prompts", "prompt_1_ai_atc_generator.md");
const BASE_PROMPT = fs.readFileSync(BASE_PROMPT_PATH, "utf8");
const CHECKPOINT_PROMPT_PATH = path.join(__dirname, "..", "prompts", "prompt_2_checkpoint_verifier.md");
const CHECKPOINT_PROMPT = fs.readFileSync(CHECKPOINT_PROMPT_PATH, "utf8");

// ---------- Cloud Function: triggered on create ----------
exports.onQueueAtcGenerationCreate = onDocumentCreated(
  { document: "queue_atc_generation/{id}", secrets: [functionsApiKey], database: "firestore-atc" },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    await processAtcGenerationDoc(snap.id, snap.data());
  }
);

// ---------- Cloud Function: triggered on update (checkpoint gate) ----------
exports.onQueueAtcGenerationUpdate = onDocumentUpdated(
  { document: "queue_atc_generation/{id}", secrets: [functionsApiKey], database: "firestore-atc" },
  async (event) => {
    const change = event.data;
    if (!change) return;
    const before = change.before.data() || {};
    const after = change.after.data() || {};

    const statusJustCompleted = before["status"] !== after["status"] && after["status"] === "completed";
    const checkpointJustFlipped = before.checkpoint !== after.checkpoint && after.checkpoint === true;

    if(
      (statusJustCompleted || checkpointJustFlipped) &&
      after["status"] === "completed" &&
      after.checkpoint === true &&
      after.generateatc === true
    ){
      console.log("started processCheckpointVerificationDoc");
      await processCheckpointVerificationDoc(change.after.id, after);
    }

    // --- Rubrics scoring: extract overall_verdict from output on completion ---
    if (
      after.type === "rubrics scoring" &&
      after["status"] === "completed" &&
      before.overall_verdict !== after.overall_verdict
    ) {
      await extractAndSaveOverallVerdict(change.after.id, after);
    }

    // --- Vice-versa rubrics trigger ---
    // The AI pipeline (gen + checkpoint) and the specialist ATC (atc_alpha) can
    // finish in EITHER order. onAtcAlphaCreate covers "atc_alpha finishes last".
    // This covers "AI pipeline finishes last": when the checkpoint report
    // completes, pull any atc_alpha already waiting for that stage and create
    // rubrics. The rubrics dedup guard makes double-firing safe.
    if (
      after.type === "checkpoint report" &&
      before["status"] !== after["status"] &&
      after["status"] === "completed"
    ) {
      await maybeTriggerRubricsFromGeneration(after);
    }
  }
);

// When the AI pipeline finishes, look for a specialist ATC already submitted for
// the same stage and kick off rubrics scoring for it (reusing ATC.js's
// processAtcAlphaDoc, which re-validates and dedups internally).
async function maybeTriggerRubricsFromGeneration(checkpointDoc) {
  try {
    const sourceRef = checkpointDoc.sourceref;
    if (!sourceRef || typeof sourceRef.get !== "function") {
      return console.log("vice-versa rubrics: checkpoint has no resolvable sourceref");
    }
    const genSnap = await sourceRef.get();
    if (!genSnap.exists) return console.log("vice-versa rubrics: source gen doc missing");
    const gen = genSnap.data();

    const rawStage = gen.stage;
    const profileid = gen.profileid;
    const queueid = gen.queueref && gen.queueref.id ? gen.queueref.id : null;
    if (!rawStage || !profileid || !queueid) {
      return console.log("vice-versa rubrics: gen doc missing stage/profileid/queueid");
    }

    // Any specialist ATC already waiting in atc_alpha for this stage?
    const alphaSnap = await adminATC.collection("atc_alpha")
      .where("queueid", "==", queueid)
      .where("profileid", "==", profileid)
      .where("stagename", "==", rawStage)
      .get();
    if (alphaSnap.empty) {
      return console.log(`vice-versa rubrics: no atc_alpha waiting for stage "${rawStage}" — will fire on atc_alpha create`);
    }

    const { processAtcAlphaDoc } = require("./ATC");
    for (const alphaDoc of alphaSnap.docs) {
      await processAtcAlphaDoc(alphaDoc.ref, alphaDoc.data());
    }
  } catch (err) {
    await alertAtc("warn", `Vice-versa rubrics trigger failed: ${err.message}`, {
      stage: "Stage 3 rubrics",
      extra: { checkpointDocId: checkpointDoc.docid, stack: err.stack },
    });
  }
}

// ---------- Shared processor ----------
// async function processAtcGenerationDoc(docid, docData) {
//   if (!docData.generateatc) return console.log(`generateatc=false, skipping ${docid}`);
//    if (docData.type === "rubrics scoring") {
//     return console.log(`type=rubrics scoring, handled by rubrics pipeline — skipping ${docid}`);
//   }

//   const triggeredRef = admin.firestore().collection("queue_atc_generation").doc(docid);

//   // 1. Read prompt config from classify (written by update_classify_config.js).
//   const promptSnap = await admin.firestore()
//     .collection("classify").doc(CLASSIFY_PROMPT_DOCID).get();
//   if (!promptSnap.exists) return console.log("classify/atcprompts missing");
//   const promptCfg = promptSnap.data();

//   // 2. Find sibling docs for the same participant/token/queue and pick the
//   //    pairing-stage docs whose stage is in this doc's pairingstages.
//   const pairingstages = docData.pairingstages || [];
//   const siblingsSnap = await admin.firestore().collection("queue_atc_generation")
//     .where("profileid", "==", docData.profileid)
//     .where("queue_token_id", "==", docData.queue_token_id)
//     .where("queueref", "==", docData.queueref)
//     .get();

//   const pairingDocsByStage = {};
//   for (const d of siblingsSnap.docs) {
//     const dd = d.data();
//     if (pairingstages.includes(dd.stage)) pairingDocsByStage[dd.stage] = dd;
//   }

//   // 3. Compose the per-stage data block: start with the triggered doc's own
//   //    transcript, then append each pairing stage in declared order.
//   const ownBody = typeof docData.data === "object" ? docData.data.transcript_text : docData.data;
//   const pairingBlocks = [`${docData.stage}:\n${ownBody}`];
//   const missing = [];
//   for (const stage of pairingstages) {
//     if (stage === docData.stage) continue;
//     const pd = pairingDocsByStage[stage];
//     if (!pd) { missing.push(stage); continue; }
//     const body = typeof pd.data === "object" ? pd.data.transcript_text : pd.data;
//     pairingBlocks.push(`${stage}:\n${body}`);
//   }
//   if (missing.length) console.log(`${docid} missing pairing stages ${JSON.stringify(missing)} — proceeding with own data only`);

//   // 4. Construct the full prompt.
//   const prompt = [
//     promptCfg.prompttogenerateatc,
//     pairingBlocks.join("\n\n"),
//     promptCfg.approvedproceduresprompt,
//     `Approved A&H Procedures are : ${JSON.stringify(promptCfg.approvedProcedures)}`,
//     promptCfg.lastPrompt,
//   ].join("\n\n");

//   // 5. Persist prompt + systemprompt + status on the triggered doc.
//   await triggeredRef.set({
//     prompt: prompt,
//     systemprompt: promptCfg.systemprompt,
//     status: "pending",
//     promptUpdatedAt: new Date(),
//   }, { merge: true });

//   // 6. Kick off the pod via run_jobrequest.
//   await callRunJobRequest({ docid, promptCfg });
// }
async function processAtcGenerationDoc(docid, docData) {
  if (!docData.generateatc) {
    await recordDropoff("S1", "generateatc_false", { docid });
    return console.log(`generateatc=false, skipping ${docid}`);
  }
  if (!['form','zoom'].includes(docData.type)) {
    return console.log(`type=${docData.type}, handled by rubrics pipeline — skipping ${docid}`);
  }

  const triggeredRef = adminATC.collection("queue_atc_generation").doc(docid);

  // 1. Read prompt config from classify (written by update_classify_config.js).
  const promptSnap = await adminDefault.collection("classify").doc(CLASSIFY_PROMPT_DOCID).get();
  if (!promptSnap.exists) {
    await recordDropoff("S1", "atcprompts_missing", { docid });
    await alertAtc("critical", "classify/atcprompts config doc missing — ATC generation prompt cannot be built.", {
      stage: "Stage 1 generate", extra: { docid },
    });
    return console.log("classify/atcprompts missing");
  }
  const promptCfg = promptSnap.data();

  // 2. Find sibling docs for the same participant/token/queue and pick the
  //    pairing-stage docs whose stage is in this doc's pairingstages.
  const pairingstages = docData.pairingstages || [];
  const siblingsSnap = await adminATC.collection("queue_atc_generation")
    .where("profileid", "==", docData.profileid)
    .where("queue_token_id", "==", docData.queue_token_id)
    .where("queueref", "==", docData.queueref)
    .get();

  const pairingDocsByStage = {};
  for (const d of siblingsSnap.docs) {
    const dd = d.data();
    if (pairingstages.includes(dd.stage)) pairingDocsByStage[dd.stage] = dd;
  }

  // 3. Collect every doc in this generation (triggered + its pairings), then
  //    group by type: form docs feed PARTICIPANT_DATA, zoom docs feed TRANSCRIPT.
  const allDocs = [docData];
  const missing = [];
  for (const stage of pairingstages) {
    if (stage === docData.stage) continue;
    const pd = pairingDocsByStage[stage];
    if (!pd) { missing.push(stage); continue; }
    allDocs.push(pd);
  }
  if (missing.length) {
    console.log(`${docid} missing pairing stages ${JSON.stringify(missing)} — proceeding with available data only`);
    if (allDocs.length === 1 && pairingstages.length) {
      await alertAtc("warn", `All pairing stages missing for ${docid} — ATC generated from own data only.`, {
        stage: "Stage 1 generate", extra: { docid, missing, pairingstages },
      });
    }
  }

  const formDocs = allDocs.filter((d) => d.type === "form");
  const zoomDocs = allDocs.filter((d) => d.type === "zoom");

  const participantType = formDocs.some((d) => /aspiration/i.test(d.stage || ""))
    ? "first_time"
    : "returning";
  const formType = formDocs.map((d) => d.stage).filter(Boolean).join(", ") || docData.stage || "";

  const renderForm = (d) => {
    const body = typeof d.data === "object" ? JSON.stringify(d.data) : String(d.data ?? "");
    return `${d.stage}: ${body}`;
  };
  const renderZoom = (d) => {
    const body = typeof d.data === "object"
      ? (d.data.transcript_text || JSON.stringify(d.data))
      : String(d.data ?? "");
    return `${d.stage}: ${body}`;
  };

  const participantDataSection = formDocs.map(renderForm).join("\n\n");
  const transcriptSection = zoomDocs.map(renderZoom).join("\n\n");

  const participantBlock = [
    `PARTICIPANT_TYPE: ${participantType}`,
    `FORM_TYPE: ${formType}`,
    `PARTICIPANT_DATA:\n${participantDataSection}`,
    `TRANSCRIPT:\n${transcriptSection}`,
  ].join("\n\n");

  const lastsentence = "Begin now with Part 1. Do not stop until the JSON closing brace has been emitted."

  // 4. Construct the full prompt.
  const prompt = `${BASE_PROMPT}\n\n${participantBlock}\n\n${lastsentence}`;

  // 5. Persist prompt + systemprompt + status on the triggered doc.
  await triggeredRef.set({
    prompt: prompt,
    systemprompt: promptCfg.systemprompt,
    status: "pending",
    promptUpdatedAt: new Date(),
    checkpoint:true
  }, { merge: true });

  // 6. Kick off the pod via run_jobrequest.
  // await callRunJobRequest({ docid, promptCfg });
}

// ---------- Checkpoint verification processor ----------
async function processCheckpointVerificationDoc(triggeredDocId, triggeredDocData) {
  const atcToVerify = triggeredDocData.output;
  if (!atcToVerify || (typeof atcToVerify === "string" && atcToVerify.trim() === "")) {
    await alertAtc("warn", `Checkpoint: source doc ${triggeredDocId} has no output to verify — skipping.`, {
      stage: "Stage 2 checkpoint", extra: { sourceDocId: triggeredDocId },
    });
    return console.log(`checkpoint: triggered doc ${triggeredDocId} has no output — skipping`);
  }

  // 1. Read prompt config from classify (same source as the generator).
  const promptSnap = await adminDefault.collection("classify").doc(CLASSIFY_PROMPT_DOCID).get();
  if (!promptSnap.exists) {
    await alertAtc("critical", "classify/atcprompts config doc missing — checkpoint verification cannot run.", {
      stage: "Stage 2 checkpoint", extra: { sourceDocId: triggeredDocId },
    });
    return console.log("classify/atcprompts missing");
  }
  const promptCfg = promptSnap.data();

  // 2. Find sibling docs for the same participant/token/queue and pick the
  //    pairing-stage docs whose stage is in this doc's pairingstages.
  const pairingstages = triggeredDocData.pairingstages || [];
  const siblingsSnap = await adminATC.collection("queue_atc_generation")
    .where("profileid", "==", triggeredDocData.profileid)
    .where("queue_token_id", "==", triggeredDocData.queue_token_id)
    .where("queueref", "==", triggeredDocData.queueref)
    .get();

  const pairingDocsByStage = {};
  for (const d of siblingsSnap.docs) {
    const dd = d.data();
    if (pairingstages.includes(dd.stage)) pairingDocsByStage[dd.stage] = dd;
  }

  // 3. Collect every doc in this generation (triggered + its pairings), then
  //    group by type: form docs feed PARTICIPANT_DATA, zoom docs feed TRANSCRIPT.
  const allDocs = [triggeredDocData];
  const missing = [];
  for (const stage of pairingstages) {
    if (stage === triggeredDocData.stage) continue;
    const pd = pairingDocsByStage[stage];
    if (!pd) { missing.push(stage); continue; }
    allDocs.push(pd);
  }
  if (missing.length) console.log(`checkpoint ${triggeredDocId} missing pairing stages ${JSON.stringify(missing)} — proceeding with available data only`);

  const formDocs = allDocs.filter((d) => d.type === "form");
  const zoomDocs = allDocs.filter((d) => d.type === "zoom");

  const participantType = formDocs.some((d) => /aspiration/i.test(d.stage || ""))
    ? "first_time"
    : "returning";
  const formType = formDocs.map((d) => d.stage).filter(Boolean).join(", ") || triggeredDocData.stage || "";

  const renderForm = (d) => {
    const body = typeof d.data === "object" ? JSON.stringify(d.data) : String(d.data ?? "");
    return `${d.stage}: ${body}`;
  };
  const renderZoom = (d) => {
    const body = typeof d.data === "object"
      ? (d.data.transcript_text || JSON.stringify(d.data))
      : String(d.data ?? "");
    return `${d.stage}: ${body}`;
  };

  const participantDataSection = formDocs.map(renderForm).join("\n\n");
  const transcriptSection = zoomDocs.map(renderZoom).join("\n\n");
  const atcToVerifyStr = typeof atcToVerify === "string" ? atcToVerify : JSON.stringify(atcToVerify);

  const participantBlock = [
    `PARTICIPANT_TYPE: ${participantType}`,
    `FORM_TYPE: ${formType}`,
    `PARTICIPANT_DATA:\n${participantDataSection}`,
    `TRANSCRIPT:\n${transcriptSection}`,
    `ATC_TO_VERIFY:\n${atcToVerifyStr}`,
  ].join("\n\n");

  // 4. Construct the full prompt using prompt_2_checkpoint_verifier.
  const prompt = `${CHECKPOINT_PROMPT}\n\n${participantBlock}`;

  // 5. Create a new queue_atc_generation doc for the checkpoint report.
  // Dedup guard: the update trigger can re-fire (any write that keeps
  // status=completed & checkpoint=true). The checkpoint report is 1:1 with its
  // source gen doc, so key on sourceref + type and skip if it already exists.
  const sourceGenRef = adminATC.collection("queue_atc_generation").doc(triggeredDocId);
  const existingCheckpoint = await adminATC.collection("queue_atc_generation")
    .where("sourceref", "==", sourceGenRef)
    .where("type", "==", "checkpoint report")
    .limit(1)
    .get();
  if (!existingCheckpoint.empty) {
    await alertAtc("info", `Checkpoint report already exists for source ${triggeredDocId} — skipping duplicate.`, {
      stage: "Stage 2 checkpoint",
      extra: { sourceDocId: triggeredDocId, existingDocId: existingCheckpoint.docs[0].id },
    });
    return console.log(`checkpoint report already exists for source ${triggeredDocId} — skipping (existing ${existingCheckpoint.docs[0].id})`);
  }

  const newDocId = adminATC.collection("queue_atc_generation").doc().id;
  const checkpointStage = `${triggeredDocData.stage} checkpoint report`;
  const payload = {
    docid: newDocId,
    queueref: adminATC.doc(triggeredDocData.queueref.path),
    profileid: triggeredDocData.profileid,
    queue_token_id: triggeredDocData.queue_token_id,
    stage: checkpointStage,
    generateatc: true,
    type: 'checkpoint report',
    pairingstages: pairingstages,
    sourceref: sourceGenRef,
    data:atcToVerify,
    prompt: prompt,
    systemprompt: promptCfg.systemprompt,
    status: "pending",
    createdAt: new Date(),
    promptUpdatedAt: new Date(),
    checkpoint:false
  };

  await adminATC.collection("queue_atc_generation").doc(newDocId).set(payload);
  console.log(`checkpoint doc created ${newDocId} for source ${triggeredDocId} (stage="${checkpointStage}")`);

  // 6. Kick off the pod via run_jobrequest.
  // await callRunJobRequest({ docid: newDocId, promptCfg });
}

// ---------- Extract overall_verdict from rubrics scoring output and save ----------
async function extractAndSaveOverallVerdict(docId, docData) {
  const raw = docData.output;
  if (!raw) {
    return console.log(`rubrics verdict: doc ${docId} has no output — skipping`);
  }

  const parsed = extractAssistantFinalJson(raw);
  if (!parsed || typeof parsed !== 'object') {
    return console.log(`rubrics verdict: doc ${docId} — could not extract JSON from output`);
  }

  const verdict = (parsed.meta && parsed.meta.overall_verdict) || null;
  if (!verdict) {
    return console.log(`rubrics verdict: doc ${docId} — no meta.overall_verdict found in extracted JSON`);
  }

  // Only save if the document doesn't already have the same value
  if (docData.overall_verdict === verdict) {
    return console.log(`rubrics verdict: doc ${docId} — overall_verdict already "${verdict}", skipping save`);
  }

  await adminATC.collection("queue_atc_generation").doc(docId).set(
    { overall_verdict: verdict },
    { merge: true }
  );
  console.log(`rubrics verdict: doc ${docId} — saved overall_verdict="${verdict}"`);
}
// Exposed for integration tests (not deployed functions). The onDocument
// triggers drive these internally; tests call them directly to exercise the
// Stage-1/Stage-2 and vice-versa-rubrics logic deterministically.
exports.processAtcGenerationDoc = processAtcGenerationDoc;
exports.processCheckpointVerificationDoc = processCheckpointVerificationDoc;
exports.maybeTriggerRubricsFromGeneration = maybeTriggerRubricsFromGeneration;
exports.extractAndSaveOverallVerdict = extractAndSaveOverallVerdict;

// ---------- Extract assistant final JSON from raw output ----------
const { extractAssistantFinalJson } = require("./atc_helpers");
// ---------- run_jobrequest invocation ----------
async function callRunJobRequest({ docid, promptCfg }) {
  const podtemplateid = promptCfg.podtemplateid;
  if (!podtemplateid) {
    console.log("classify.podtemplateid not configured — skipping run_jobrequest call");
    return;
  }

  const payload = {
    TEMPLATEID: podtemplateid,
    SLACK_WEBHOOK_URL: promptCfg.SLACK_WEBHOOK_URL || "",
    FIREBASE_FETCH_URL: promptCfg.FIREBASE_FETCH_URL || "",
    FIREBASE_SUBMIT_URL: promptCfg.FIREBASE_SUBMIT_URL || "",
    FIREBASE_COLLECTION_NAME: "queue_atc_generation",
    AUTO_TERMINATE: "true",
    DOC_ID: docid,
  };

  const resp = await fetch(RUN_JOBREQUEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": functionsApiKey.value() || process.env.FUNCTIONS_API_KEY ,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => "");
    console.log(`run_jobrequest failed: ${resp.status} ${err}`);
    return;
  }
  const data = await resp.json().catch(() => ({}));
  console.log("run_jobrequest ok", data);
}