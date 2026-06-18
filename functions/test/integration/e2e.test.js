/**
 * END-TO-END cascade — drives the whole ATC pipeline through the emulator by
 * chaining the inner handlers in the order the real onDocument/onSchedule
 * triggers would fire them. The pod is simulated by claimNextJob + writeJobResult
 * (no real /infer).
 *
 *   Stage 0 (form)  → gen doc
 *   Stage 1         → prompt, status:pending
 *   POD            → claim → result(completed, output)
 *   branch A → Stage 2 → checkpoint report (pending)
 *   POD            → claim → result(completed)
 *   branch C → Stage 3 (vice-versa) + atc_alpha → exactly ONE rubrics doc
 *
 * Plus a pod drain-loop e2e proving the worker processes each job once and the
 * loop terminates.
 */
"use strict";

jest.mock("../../components/atc_alerts", () => ({
  alertAtc: jest.fn(async () => {}),
  notifySlack: jest.fn(async () => {}),
  DEFAULT_WEBHOOK: "mock-webhook",
}));

const { defaultDb, atcDb, formsDb, clearAll } = require("./helpers");
const alerts = require("../../components/atc_alerts");
const { processStage } = require("../../components/queuesystem");
const {
  processAtcGenerationDoc,
  processCheckpointVerificationDoc,
  maybeTriggerRubricsFromGeneration,
} = require("../../components/queue_atc_generation");
const { processAtcAlphaDoc } = require("../../components/ATC");
const { claimNextJob, writeJobResult } = require("../../components/pod_jobs");
const { markReady, WORKER_DOC, STATES } = require("../../components/pod_worker");

const PROFILE = "p1";
const TOKEN = "tok1";
const QUEUE_ID = "q1";
const QUEUE_PATH = `queue generation/${QUEUE_ID}`;
const FORM_ID = "form123";
const COLL = "queue_atc_generation";

async function seedConfigsAndInputs() {
  await defaultDb.collection("classify").doc("atcprompts").set({
    systemprompt: "SYS_PROMPT", prompttogenerateatc: "gen", approvedProcedures: [],
  });
  await defaultDb.collection("classify").doc("rubrics_prompt").set({ systemprompt: "SYS_RUBRICS" });
  await defaultDb.collection("queue generation").doc(QUEUE_ID).set({
    atcrequiredstages: [{ stage: "stage1", generateatc: true }],
  });
  await formsDb.collection("formsByClient").doc("fc1").set({
    profileid: PROFILE,
    formid: FORM_ID,
    queueref: formsDb.doc(QUEUE_PATH),
    date: new Date(),
    formname: "LifeAspirationForm",
    formarray: [{ type: "text", fieldname: "Goal", value: "be happy" }],
  });
  await atcDb.collection("atc_alpha").doc("a1").set({
    queueid: QUEUE_ID, stagename: "stage1", profileid: PROFILE,
    status: "validated", product: "uP!", isdelete: false,
  });
}

const stage0QueueData = () => ({
  atcrequiredstages: [{ stage: "stage1", type: "form", generateatc: true, pairingstages: [] }],
  stageproperty: { stage1: { actionresource: defaultDb.doc(`forms/${FORM_ID}`) } },
});

// Simulate the pod processing exactly one pending job (what the drain worker does).
async function podProcessOne(output) {
  const job = await claimNextJob({ collectionName: COLL, podId: "podA" });
  expect(job).not.toBeNull();
  await writeJobResult({
    result: { path: job.path, output, finishReason: "stop", tokensGenerated: 10 },
    podId: "podA",
    modelName: "m1",
  });
  return job;
}

async function getOne(type) {
  const snap = await atcDb.collection(COLL).where("type", "==", type).get();
  return snap.docs[0];
}

beforeEach(async () => {
  await clearAll();
  alerts.alertAtc.mockClear();
});

describe("E2E — full pipeline cascade", () => {
  test("form → gen → pod → checkpoint → pod → rubrics (exactly one rubrics doc)", async () => {
    await seedConfigsAndInputs();

    // ── Stage 0: token moves past stage1 (form) → one gen doc ──
    await processStage({
      queueData: stage0QueueData(),
      queueRef: defaultDb.doc(QUEUE_PATH),
      tokenData: { profile_id: PROFILE },
      queueTokenId: TOKEN,
      currentStage: "stage1",
    });
    let genDoc = await getOne("form");
    expect(genDoc).toBeTruthy();
    const genId = genDoc.id;
    expect(genDoc.data().generateatc).toBe(true);
    expect(genDoc.data().queueref.path).toBe(QUEUE_PATH);

    // ── Stage 1: build prompt → status:pending ──
    await processAtcGenerationDoc(genId, genDoc.data());
    genDoc = await atcDb.collection(COLL).doc(genId).get();
    expect(genDoc.data().status).toBe("pending");
    expect(genDoc.data().checkpoint).toBe(true);

    // ── POD: claim the gen job, return generated ATC ──
    const claimed = await podProcessOne("GENERATED ATC BODY");
    expect(claimed.jobId).toBe(genId);
    genDoc = await atcDb.collection(COLL).doc(genId).get();
    expect(genDoc.data().status).toBe("completed");
    expect(genDoc.data().output).toBe("GENERATED ATC BODY");

    // ── branch A → Stage 2: checkpoint report ──
    await processCheckpointVerificationDoc(genId, genDoc.data());
    let cpDoc = await getOne("checkpoint report");
    expect(cpDoc).toBeTruthy();
    expect(cpDoc.data().status).toBe("pending");
    expect(cpDoc.data().sourceref.path).toBe(`${COLL}/${genId}`);

    // ── POD: claim the checkpoint job ──
    const claimedCp = await podProcessOne("CHECKPOINT VERIFIED");
    expect(claimedCp.jobId).toBe(cpDoc.id);
    cpDoc = await atcDb.collection(COLL).doc(cpDoc.id).get();
    expect(cpDoc.data().status).toBe("completed");

    // ── branch C → Stage 3 (vice-versa): atc_alpha already waiting → rubrics ──
    await maybeTriggerRubricsFromGeneration({
      docid: cpDoc.id,
      sourceref: atcDb.doc(`${COLL}/${genId}`),
    });

    const rubrics = await atcDb.collection(COLL).where("type", "==", "rubrics scoring").get();
    expect(rubrics.size).toBe(1);
    expect(rubrics.docs[0].data().stage).toBe("rubrics_scoring_stage1");
    expect(rubrics.docs[0].data().status).toBe("pending");

    // No queue_atc_generation doc left pending except the new rubrics job.
    const pending = await atcDb.collection(COLL).where("status", "==", "pending").get();
    expect(pending.size).toBe(1);
    expect(pending.docs[0].data().type).toBe("rubrics scoring");

    // Whole cascade ran with zero alerts.
    expect(alerts.alertAtc).not.toHaveBeenCalled();
  });

  test("both rubrics entry points fire → still exactly one rubrics doc (dedup)", async () => {
    await seedConfigsAndInputs();
    // Pre-stage the AI side (gen + checkpoint completed) so processAtcAlphaDoc can run.
    await atcDb.collection(COLL).doc("gen1").set({
      profileid: PROFILE, queueref: atcDb.doc(QUEUE_PATH), stage: "stage1", type: "form",
      output: "AI ATC", queue_token_id: TOKEN, pairingstages: [], data: "r", createdAt: new Date(),
    });
    await atcDb.collection(COLL).doc("cp1").set({
      type: "checkpoint report", sourceref: atcDb.doc(`${COLL}/gen1`), output: "ok", createdAt: new Date(),
    });

    // atc_alpha-create path AND the vice-versa path both fire for the same stage.
    await processAtcAlphaDoc(atcDb.doc("atc_alpha/a1"), {
      queueid: QUEUE_ID, stagename: "stage1", profileid: PROFILE,
      status: "validated", product: "uP!", isdelete: false,
    });
    await maybeTriggerRubricsFromGeneration({ docid: "cp1", sourceref: atcDb.doc(`${COLL}/gen1`) });

    const rubrics = await atcDb.collection(COLL).where("type", "==", "rubrics scoring").get();
    expect(rubrics.size).toBe(1);
  });
});

describe("E2E — pod drain loop", () => {
  test("ready → drain N jobs, each processed once, loop terminates", async () => {
    // Three pending jobs of increasing age.
    for (let i = 0; i < 3; i++) {
      await atcDb.collection(COLL).doc(`d${i}`).set({
        status: "pending", prompt: `p${i}`, systemprompt: "s", createdAt: new Date(Date.now() - (3 - i) * 1000),
      });
    }
    // Pod becomes ready with work to do → worker should start.
    await defaultDb.collection("classify").doc(WORKER_DOC).set({ state: STATES.LOADING, podid: "podA" });
    const decision = await markReady({ podid: "podA", apiUrl: "http://pod", bearerToken: "t" });
    expect(decision.action).toBe("start-worker");

    // Simulate the drain Job loop: claim → result until empty.
    let claims = 0;
    for (;;) {
      const job = await claimNextJob({ collectionName: COLL, podId: "podA" });
      if (!job) break;
      claims++;
      await writeJobResult({
        result: { path: job.path, output: `done-${job.jobId}`, finishReason: "stop" },
        podId: "podA", modelName: "m1",
      });
    }

    expect(claims).toBe(3); // each job claimed exactly once
    const pending = await atcDb.collection(COLL).where("status", "==", "pending").get();
    expect(pending.size).toBe(0); // fully drained → loop ended
    const completed = await atcDb.collection(COLL).where("status", "==", "completed").get();
    expect(completed.size).toBe(3);
  });
});
