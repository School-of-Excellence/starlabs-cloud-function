const admin = require('firebase-admin');
//components imports
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");

const CLASSIFY_PROMPT_DOCID = "atcprompts";
const RUN_JOBREQUEST_URL = "https://us-central1-fir-sample-aae4a.cloudfunctions.net/run_jobrequest";

const functionsApiKey = defineSecret("FUNCTIONS_SHARED_SECRET");

// ---------- Cloud Function: triggered on create ----------
exports.onQueueAtcGenerationCreate = onDocumentCreated(
  { document: "queue_atc_generation/{id}", secrets: [functionsApiKey] },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    await processAtcGenerationDoc(snap.id, snap.data());
  }
);
// ---------- Shared processor ----------
async function processAtcGenerationDoc(docid, docData) {
  if (!docData.generateatc) return console.log(`generateatc=false, skipping ${docid}`);

  const triggeredRef = admin.firestore().collection("queue_atc_generation").doc(docid);

  // 1. Read prompt config from classify (written by update_classify_config.js).
  const promptSnap = await admin.firestore()
    .collection("classify").doc(CLASSIFY_PROMPT_DOCID).get();
  if (!promptSnap.exists) return console.log("classify/atcprompts missing");
  const promptCfg = promptSnap.data();

  // 2. Find sibling docs for the same participant/token/queue and pick the
  //    pairing-stage docs whose stage is in this doc's pariringstages.
  const pariringstages = docData.pariringstages || [];
  const siblingsSnap = await admin.firestore().collection("queue_atc_generation")
    .where("profileid", "==", docData.profileid)
    .where("queue_token_id", "==", docData.queue_token_id)
    .where("queueref", "==", docData.queueref)
    .get();

  const pairingDocsByStage = {};
  for (const d of siblingsSnap.docs) {
    const dd = d.data();
    if (pariringstages.includes(dd.stage)) pairingDocsByStage[dd.stage] = dd;
  }

  // 3. Compose the per-stage data block in the order declared in pariringstages.
  const pairingBlocks = [];
  for (const stage of pariringstages) {
    const pd = pairingDocsByStage[stage];
    if (!pd) {
      console.log(`pairing stage ${stage} not yet available — aborting`);
      return;
    }
    const body = typeof pd.data === "string" ? pd.data : JSON.stringify(pd.data);
    pairingBlocks.push(`${stage}:\n${body}`);
  }

  // 4. Construct the full prompt.
  const prompt = [
    promptCfg.prompttogenerateatc,
    pairingBlocks.join("\n\n"),
    promptCfg.approvedproceduresprompt,
    `Approved A&H Procedures are : ${JSON.stringify(promptCfg.approvedProcedures)}`,
    promptCfg.lastPrompt,
  ].join("\n\n");

  // 5. Persist prompt + systemprompt + status on the triggered doc.
  await triggeredRef.set({
    prompt: prompt,
    systemprompt: promptCfg.systemprompt,
    status: "pending",
    promptUpdatedAt: new Date(),
  }, { merge: true });

  // 6. Kick off the pod via run_jobrequest.
  await callRunJobRequest({ docid, promptCfg });
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