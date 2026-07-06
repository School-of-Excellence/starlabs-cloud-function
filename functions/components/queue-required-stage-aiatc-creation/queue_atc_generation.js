// Firestore
const { getFirestore } = require("firebase-admin/firestore");
const adminDefault = getFirestore();
const adminATC = getFirestore("firestore-atc");

const path = require('path');
const fs = require('fs');
//components imports
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const { alertAtc } = require("./atc_alerts");
const { buildPromptFromStageData } = require("./atc_generation_resolver");
const { recordDropoff } = require("../../queue-aiatc-generation-pipeline/se_atc_telemetry");

const CLASSIFY_PROMPT_DOCID = "atcprompts";
const RUN_JOBREQUEST_URL = "https://us-central1-fir-sample-aae4a.cloudfunctions.net/run_jobrequest";

const functionsApiKey = defineSecret("FUNCTIONS_SHARED_SECRET");
const BASE_PROMPT_PATH = path.join(__dirname, "..", "..", "prompts", "prompt_1_ai_atc_generator.md");
const BASE_PROMPT = fs.readFileSync(BASE_PROMPT_PATH, "utf8");

// ---------- Cloud Function: triggered on create ----------
exports.onQueueAtcGenerationCreate = onDocumentCreated(
  { document: "queue_atc_generation/{id}", secrets: [functionsApiKey], database: "firestore-atc" },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    await processAtcGenerationDoc(snap.id, snap.data());
  }
);

// ---------- Shared processor ----------
// Fires on queue_atc_generation create (firestore-atc). Redesigned workflow:
// the doc already carries a resolved `stagedata` map (own + pairing) written by
// S0 (queuesystem.js processStage via atc_generation_resolver). This function is
// STATUS-AWARE — it only builds the prompt + promotes to "pending" for a freshly
// created, complete doc. A "dataincomplete" doc is left alone (the regenerate
// button owns its completion); an already-set status is never rebuilt.
async function processAtcGenerationDoc(docid, docData) {
  // A doc created incomplete waits for the on-demand regenerate button — do NOT
  // auto-promote it to pending (the old bug: status was set unconditionally).
  if (docData.status === "dataincomplete") {
    return console.log(`status=dataincomplete — waiting for regenerate button, skipping ${docid}`);
  }
  // Already claimed/inflight/terminal (or already pending) — never rebuild here.
  if (["pending", "processing", "completed", "error"].includes(docData.status)) {
    return console.log(`status=${docData.status} already set — skipping ${docid}`);
  }
  if (!docData.generateatc) {
    await recordDropoff("S1", "generateatc_false", { docid });
    return console.log(`generateatc=false, skipping ${docid}`);
  }
  const stagedata = docData.stagedata;
  if (!stagedata || typeof stagedata !== "object") {
    await recordDropoff("S1", "no_stagedata", { docid });
    return console.log(`no stagedata on ${docid} — cannot build prompt, skipping`);
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

  // 2. Build the prompt from the resolved stagedata map (own + resolved pairing
  //    stages). Shared builder — byte-for-byte the same render S0/preview use.
  const { prompt, resolvedCount } = buildPromptFromStageData(stagedata, BASE_PROMPT);
  if (resolvedCount === 0) {
    // Own stage is always resolved by S0 before a doc is created, so this should
    // never happen for a complete doc — guard anyway rather than emit an empty prompt.
    await recordDropoff("S1", "no_resolved_stages", { docid });
    return console.log(`no resolved stages in stagedata for ${docid} — skipping`);
  }

  // 3. Persist prompt + systemprompt + status:pending on the triggered doc.
  await triggeredRef.set({
    prompt: prompt,
    systemprompt: promptCfg.systemprompt,
    status: "pending",
    promptUpdatedAt: new Date(),
    checkpoint: true,
  }, { merge: true });
  console.log(`S1 built prompt (${resolvedCount} stage(s)) + set pending for ${docid}`);

  // 4. Kick off the pod via run_jobrequest.
  // await callRunJobRequest({ docid, promptCfg });
}

// Exposed for integration tests (not deployed functions). onQueueAtcGenerationCreate
// drives this internally; tests call it directly to exercise the Stage-1 logic
// deterministically.
exports.processAtcGenerationDoc = processAtcGenerationDoc;

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