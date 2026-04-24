const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
//components imports
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");

const CLASSIFY_PROMPT_DOCID = "atcprompts";
const RUN_JOBREQUEST_URL = "https://us-central1-fir-sample-aae4a.cloudfunctions.net/run_jobrequest";

const functionsApiKey = defineSecret("FUNCTIONS_SHARED_SECRET");
const BASE_PROMPT_PATH = path.join(__dirname, "..", "prompts", "prompt_1_ai_atc_generator.md");
const BASE_PROMPT = fs.readFileSync(BASE_PROMPT_PATH, "utf8");
const CHECKPOINT_PROMPT_PATH = path.join(__dirname, "..", "prompts", "prompt_2_checkpoint_verifier.md");
const CHECKPOINT_PROMPT = fs.readFileSync(CHECKPOINT_PROMPT_PATH, "utf8");

// ---------- Cloud Function: triggered on create ----------
exports.onQueueAtcGenerationCreate = onDocumentCreated(
  { document: "queue_atc_generation/{id}", secrets: [functionsApiKey] },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    await processAtcGenerationDoc(snap.id, snap.data());
  }
);

// ---------- Cloud Function: triggered on update (checkpoint gate) ----------
exports.onQueueAtcGenerationUpdate = onDocumentUpdated(
  { document: "queue_atc_generation/{id}", secrets: [functionsApiKey] },
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
  }
);

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
  if (!docData.generateatc) return console.log(`generateatc=false, skipping ${docid}`);
  if (!['form','zoom'].includes(docData.type)) {
    return console.log(`type=${docData.type}, handled by rubrics pipeline — skipping ${docid}`);
  }

  const triggeredRef = admin.firestore().collection("queue_atc_generation").doc(docid);

  // 1. Read prompt config from classify (written by update_classify_config.js).
  const promptSnap = await admin.firestore()
    .collection("classify").doc(CLASSIFY_PROMPT_DOCID).get();
  if (!promptSnap.exists) return console.log("classify/atcprompts missing");
  const promptCfg = promptSnap.data();

  // 2. Find sibling docs for the same participant/token/queue and pick the
  //    pairing-stage docs whose stage is in this doc's pairingstages.
  const pairingstages = docData.pairingstages || [];
  const siblingsSnap = await admin.firestore().collection("queue_atc_generation")
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
  if (missing.length) console.log(`${docid} missing pairing stages ${JSON.stringify(missing)} — proceeding with available data only`);

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
    return console.log(`checkpoint: triggered doc ${triggeredDocId} has no output — skipping`);
  }

  // 1. Read prompt config from classify (same source as the generator).
  const promptSnap = await admin.firestore()
    .collection("classify").doc(CLASSIFY_PROMPT_DOCID).get();
  if (!promptSnap.exists) return console.log("classify/atcprompts missing");
  const promptCfg = promptSnap.data();

  // 2. Find sibling docs for the same participant/token/queue and pick the
  //    pairing-stage docs whose stage is in this doc's pairingstages.
  const pairingstages = triggeredDocData.pairingstages || [];
  const siblingsSnap = await admin.firestore().collection("queue_atc_generation")
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
  const newDocId = admin.firestore().collection("queue_atc_generation").doc().id;
  const checkpointStage = `${triggeredDocData.stage} checkpoint report`;
  const payload = {
    docid: newDocId,
    queueref: triggeredDocData.queueref,
    profileid: triggeredDocData.profileid,
    queue_token_id: triggeredDocData.queue_token_id,
    stage: checkpointStage,
    generateatc: true,
    type: 'checkpoint report',
    pairingstages: pairingstages,
    sourceref: admin.firestore().collection("queue_atc_generation").doc(triggeredDocId),
    data:atcToVerify,
    prompt: prompt,
    systemprompt: promptCfg.systemprompt,
    status: "pending",
    createdAt: new Date(),
    promptUpdatedAt: new Date(),
    checkpoint:false
  };

  await admin.firestore().collection("queue_atc_generation").doc(newDocId).set(payload);
  console.log(`checkpoint doc created ${newDocId} for source ${triggeredDocId} (stage="${checkpointStage}")`);

  // 6. Kick off the pod via run_jobrequest.
  await callRunJobRequest({ docid: newDocId, promptCfg });
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

  await admin.firestore().collection("queue_atc_generation").doc(docId).set(
    { overall_verdict: verdict },
    { merge: true }
  );
  console.log(`rubrics verdict: doc ${docId} — saved overall_verdict="${verdict}"`);
}
// ---------- Extract assistant final JSON from raw output ----------
function extractAssistantFinalJson(raw) {
  if (typeof raw !== 'string') return raw;
  const marker = /assistantfinal/i;
  const m = raw.match(marker);
  const tail = m ? raw.slice(m.index + m[0].length) : raw;

  const start = tail.indexOf('{');
  if (start === -1) return raw;

  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < tail.length; i++) {
    const ch = tail[i];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const jsonStr = tail.slice(start, i + 1);
        try {
          return JSON.parse(jsonStr);
        } catch {
          return jsonStr;
        }
      }
    }
  }
  return raw;
}
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