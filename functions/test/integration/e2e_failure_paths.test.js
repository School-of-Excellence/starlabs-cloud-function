/**
 * END-TO-END failure / retry / pod-death paths — the scenarios the happy-path
 * e2e.test.js does not cover. Everything runs against the live Firestore
 * emulator with realistically-seeded sample data and drives the REAL exported
 * pipeline functions (no reimplementations):
 *
 *   A. Transient infer failure → requeue → re-claim → success → pipeline resumes
 *   B. Terminal failure at the attempts cap → status:error → pipeline stops
 *   C. Empty AI output → flagged failure → checkpoint warns, no checkpoint doc
 *   D. Pod dies mid-flight (markUnhealthy) → in-flight job requeued, never lost
 *   E. Mixed drain batch (one good, one empty) → loop drains both, classifies
 *
 * The pod is simulated by claimNextJob + writeJobResult + requeueJob (the exact
 * calls the Cloud Run drain worker makes), so these are the actual job-layer
 * transitions, not stand-ins.
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
} = require("../../components/queue_atc_generation");
const { claimNextJob, writeJobResult, requeueJob } = require("../../components/pod_jobs");
const { markReady, markUnhealthy, WORKER_DOC, STATES } = require("../../components/pod_worker");

const PROFILE = "p1";
const TOKEN = "tok1";
const QUEUE_ID = "q1";
const QUEUE_PATH = `queue generation/${QUEUE_ID}`;
const FORM_ID = "form123";
const COLL = "queue_atc_generation";
const POD = "podA";

// ── Realistic seeded sample data (config + a real-looking form submission) ──
async function seedConfigsAndInputs() {
  await defaultDb.collection("classify").doc("atcprompts").set({
    systemprompt: "You are an ATC generator.",
    prompttogenerateatc: "Generate an ATC from the participant data below.",
    approvedProcedures: [],
  });
  await defaultDb.collection("classify").doc("rubrics_prompt").set({ systemprompt: "Score the ATC." });
  await defaultDb.collection("queue generation").doc(QUEUE_ID).set({
    atcrequiredstages: [{ stage: "stage1", generateatc: true }],
  });
  await formsDb.collection("formsByClient").doc("fc1").set({
    profileid: PROFILE,
    formid: FORM_ID,
    queueref: formsDb.doc(QUEUE_PATH),
    date: new Date(),
    formname: "LifeAspirationForm",
    formarray: [
      { type: "text", fieldname: "Goal", value: "launch my legacy" },
      { type: "textarea", fieldname: "Why now", value: "I finally have the time and clarity" },
    ],
  });
}

const stage0QueueData = () => ({
  atcrequiredstages: [{ stage: "stage1", type: "form", generateatc: true, pairingstages: [] }],
  stageproperty: { stage1: { actionresource: defaultDb.doc(`forms/${FORM_ID}`) } },
});

// Run Stage 0 + Stage 1 → returns the gen doc id, now status:pending.
async function seedThroughStage1() {
  await seedConfigsAndInputs();
  await processStage({
    queueData: stage0QueueData(),
    queueRef: defaultDb.doc(QUEUE_PATH),
    tokenData: { profile_id: PROFILE },
    queueTokenId: TOKEN,
    currentStage: "stage1",
  });
  const snap = await atcDb.collection(COLL).where("type", "==", "form").get();
  const genId = snap.docs[0].id;
  await processAtcGenerationDoc(genId, snap.docs[0].data());
  return genId;
}

const getById = (id) => atcDb.collection(COLL).doc(id).get();
const countByType = async (type) =>
  (await atcDb.collection(COLL).where("type", "==", type).get()).size;

beforeEach(async () => {
  await clearAll();
  alerts.alertAtc.mockClear();
});

describe("E2E failure paths", () => {
  test("A. transient infer failure → requeue → re-claim → success → checkpoint proceeds", async () => {
    const genId = await seedThroughStage1();
    expect((await getById(genId)).data().status).toBe("pending");

    // Pod claims, infer throws → worker requeues (attempt 1, back to pending).
    const claim1 = await claimNextJob({ collectionName: COLL, podId: POD });
    expect(claim1.jobId).toBe(genId);
    const rq = await requeueJob({ collectionName: COLL, path: claim1.path, reason: "infer timeout", podId: POD });
    expect(rq).toMatchObject({ ok: true, requeued: true, attempts: 1 });
    let gen = await getById(genId);
    expect(gen.data().status).toBe("pending");
    expect(gen.data().attempts).toBe(1);
    expect(gen.data().claimedBy).toBeUndefined(); // ownership released for re-claim

    // Pod re-claims the SAME job and this time succeeds.
    const claim2 = await claimNextJob({ collectionName: COLL, podId: POD });
    expect(claim2.jobId).toBe(genId);
    expect(claim2.attempts).toBe(1); // carried forward
    await writeJobResult({
      result: { path: claim2.path, output: "RETRIED ATC BODY", finishReason: "stop", tokensGenerated: 12 },
      podId: POD, modelName: "m1",
    });
    gen = await getById(genId);
    expect(gen.data().status).toBe("completed");
    expect(gen.data().output).toBe("RETRIED ATC BODY");
    expect(gen.data().failureCategory).toBeNull(); // success after retry, not flagged

    // Pipeline resumes: checkpoint report is produced from the retried output.
    await processCheckpointVerificationDoc(genId, gen.data());
    expect(await countByType("checkpoint report")).toBe(1);
  });

  test("B. terminal failure at attempts cap → status:error → no checkpoint produced", async () => {
    const genId = await seedThroughStage1();
    // Bump attempts to one below the cap so the next requeue is terminal.
    await atcDb.collection(COLL).doc(genId).update({ attempts: 2 }); // maxAttempts default 3

    const claim = await claimNextJob({ collectionName: COLL, podId: POD });
    const rq = await requeueJob({ collectionName: COLL, path: claim.path, reason: "infer error", podId: POD });
    expect(rq).toMatchObject({ ok: true, errored: true, attempts: 3 });

    const gen = await getById(genId);
    expect(gen.data().status).toBe("error");
    expect(gen.data().failureCategory).toBeTruthy(); // chartable terminal reason stamped
    expect(gen.data().finalizedAt).toBeTruthy();

    // Branch A never fires for an errored doc → no checkpoint, nothing left pending.
    expect(await countByType("checkpoint report")).toBe(0);
    const pending = await atcDb.collection(COLL).where("status", "==", "pending").get();
    expect(pending.size).toBe(0);
  });

  test("C. empty AI output → flagged failure → checkpoint warns, no checkpoint doc", async () => {
    const genId = await seedThroughStage1();

    const claim = await claimNextJob({ collectionName: COLL, podId: POD });
    const res = await writeJobResult({
      result: { path: claim.path, output: "", finishReason: "stop" }, // empty body
      podId: POD, modelName: "m1",
    });
    expect(res.written).toBe(true);
    expect(res.failure).toBeTruthy();

    const gen = await getById(genId);
    expect(gen.data().failureCategory).toBe("empty_output"); // classified

    // Stage 2 sees empty source output → warns and creates no checkpoint doc.
    await processCheckpointVerificationDoc(genId, gen.data());
    expect(alerts.alertAtc).toHaveBeenCalled();
    expect(alerts.alertAtc.mock.calls[0][0]).toBe("warn");
    expect(await countByType("checkpoint report")).toBe(0);
  });

  test("D. pod dies mid-flight → markUnhealthy requeues the in-flight job (never lost)", async () => {
    const genId = await seedThroughStage1();
    // Pod claimed the job and is mid-inference when it goes unhealthy.
    const claim = await claimNextJob({ collectionName: COLL, podId: POD });
    await defaultDb.collection("classify").doc(WORKER_DOC).set({
      state: STATES.READY, podid: POD, workerRunning: true, currentJobPath: claim.path,
    });

    const out = await markUnhealthy({ podid: POD, reason: "health probe failed", collectionName: COLL });
    expect(out.action).toBe("terminate");

    // Worker halted, will NOT auto-relaunch until a human clears it.
    const worker = (await defaultDb.collection("classify").doc(WORKER_DOC).get()).data();
    expect(worker.state).toBe(STATES.HALTED);
    expect(worker.halted).toBe(true);
    expect(worker.workerRunning).toBe(false);

    // The in-flight job is back in the pending pool, re-claimable, attempts++.
    const gen = await getById(genId);
    expect(gen.data().status).toBe("pending");
    expect(gen.data().attempts).toBe(1);
    expect(gen.data().claimedBy).toBeUndefined();
  });

  test("E. mixed drain batch (good + empty) → loop drains both and classifies each", async () => {
    // Two pending jobs of increasing age (FIFO order j0 then j1).
    for (let i = 0; i < 2; i++) {
      await atcDb.collection(COLL).doc(`j${i}`).set({
        status: "pending", prompt: `p${i}`, systemprompt: "s",
        profileid: PROFILE, createdAt: new Date(Date.now() - (2 - i) * 1000),
      });
    }
    await defaultDb.collection("classify").doc(WORKER_DOC).set({ state: STATES.LOADING, podid: POD });
    const decision = await markReady({ podid: POD, apiUrl: "http://pod", bearerToken: "t" });
    expect(decision.action).toBe("start-worker");

    // Drain loop: first job succeeds, second returns an empty body.
    const outputs = { j0: "GOOD ATC", j1: "" };
    let claims = 0;
    for (;;) {
      const job = await claimNextJob({ collectionName: COLL, podId: POD });
      if (!job) break;
      claims++;
      await writeJobResult({
        result: { path: job.path, output: outputs[job.jobId], finishReason: "stop" },
        podId: POD, modelName: "m1",
      });
    }
    expect(claims).toBe(2);

    const pending = await atcDb.collection(COLL).where("status", "==", "pending").get();
    expect(pending.size).toBe(0); // loop terminates — fully drained

    const j0 = (await getById("j0")).data();
    const j1 = (await getById("j1")).data();
    expect(j0.status).toBe("completed");
    expect(j0.failureCategory).toBeNull();        // good job not flagged
    expect(j1.failureCategory).toBe("empty_output"); // empty job flagged for the rollup
  });
});
