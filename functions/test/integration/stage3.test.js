/**
 * Stage 3 — rubrics scoring (ATC.js processAtcAlphaDoc) + the vice-versa trigger
 * (queue_atc_generation.js maybeTriggerRubricsFromGeneration).
 * Covers TC3.1 (happy), TC3.2 (dedup), TC3.3 (AI not ready), TC3.7 (vice-versa),
 * TC3.8 (vice-versa dedup).
 */
"use strict";

jest.mock("../../components/atc_alerts", () => ({
  alertAtc: jest.fn(async () => {}),
  notifySlack: jest.fn(async () => {}),
  DEFAULT_WEBHOOK: "mock-webhook",
}));

const { defaultDb, atcDb, clearAll } = require("./helpers");
const alerts = require("../../components/atc_alerts");
const { processAtcAlphaDoc } = require("../../components/ATC");
const { maybeTriggerRubricsFromGeneration } = require("../../components/queue_atc_generation");

const PROFILE = "p1";
const TOKEN = "tok1";
const QUEUE_ID = "q1";
const QUEUE_PATH = `queue generation/${QUEUE_ID}`;
const GEN_ID = "gen1";

const atcRef = () => atcDb.doc("atc_alpha/a1");
const atcData = (overrides = {}) => ({
  queueid: QUEUE_ID,
  stagename: "stage1",
  profileid: PROFILE,
  status: "validated",
  product: "uP!",
  isdelete: false,
  ...overrides,
});

async function seedQueueAndConfig() {
  await defaultDb.collection("queue generation").doc(QUEUE_ID).set({
    atcrequiredstages: [{ stage: "stage1", generateatc: true }],
  });
  await defaultDb.collection("classify").doc("rubrics_prompt").set({ systemprompt: "SYS_RUBRICS" });
}

async function seedAtcAlpha() {
  await atcDb.collection("atc_alpha").doc("a1").set(atcData());
}

async function seedGenWithOutput() {
  await atcDb.collection("queue_atc_generation").doc(GEN_ID).set({
    profileid: PROFILE,
    queueref: atcDb.doc(QUEUE_PATH),
    stage: "stage1",
    type: "form",
    output: "AI ATC content",
    queue_token_id: TOKEN,
    pairingstages: [],
    data: "report",
  });
}

async function seedCheckpoint() {
  await atcDb.collection("queue_atc_generation").doc("cp1").set({
    type: "checkpoint report",
    sourceref: atcDb.doc(`queue_atc_generation/${GEN_ID}`),
    output: "checkpoint verified",
  });
}

async function rubricsDocs() {
  return atcDb
    .collection("queue_atc_generation")
    .where("type", "==", "rubrics scoring")
    .get();
}

beforeEach(async () => {
  await clearAll();
  alerts.alertAtc.mockClear();
});

describe("Stage 3 — processAtcAlphaDoc", () => {
  test("TC3.1 — happy path creates one rubrics scoring doc", async () => {
    await seedQueueAndConfig();
    await seedAtcAlpha();
    await seedGenWithOutput();
    await seedCheckpoint();

    await processAtcAlphaDoc(atcRef(), atcData());

    const snap = await rubricsDocs();
    expect(snap.size).toBe(1);
    const d = snap.docs[0].data();
    expect(d.type).toBe("rubrics scoring");
    expect(d.stage).toBe("rubrics_scoring_stage1");
    expect(d.sourceref.path).toBe("atc_alpha/a1");
    expect(d.queue_token_id).toBe(TOKEN);
    expect(d.queueref.path).toBe(QUEUE_PATH);
    expect(d.status).toBe("pending");
    expect(alerts.alertAtc).not.toHaveBeenCalled();
  });

  test("TC3.2 — existing rubrics doc: skip + info alert", async () => {
    await seedQueueAndConfig();
    await seedAtcAlpha();
    await seedGenWithOutput();
    await seedCheckpoint();
    await atcDb.collection("queue_atc_generation").doc("existing-rub").set({
      type: "rubrics scoring",
      stage: "rubrics_scoring_stage1",
      queueref: atcDb.doc(QUEUE_PATH),
      profileid: PROFILE,
      queue_token_id: TOKEN,
    });

    await processAtcAlphaDoc(atcRef(), atcData());

    const snap = await rubricsDocs();
    expect(snap.size).toBe(1); // no new doc
    expect(alerts.alertAtc).toHaveBeenCalledTimes(1);
    expect(alerts.alertAtc.mock.calls[0][0]).toBe("info");
  });

  test("TC3.3 — AI output not ready: warn alert, no rubrics doc", async () => {
    await seedQueueAndConfig();
    await seedAtcAlpha();
    // no gen doc with output

    await processAtcAlphaDoc(atcRef(), atcData());

    const snap = await rubricsDocs();
    expect(snap.size).toBe(0);
    expect(alerts.alertAtc).toHaveBeenCalledTimes(1);
    expect(alerts.alertAtc.mock.calls[0][0]).toBe("warn");
  });
});

describe("Stage 3 — vice-versa (maybeTriggerRubricsFromGeneration)", () => {
  test("TC3.7 — atc_alpha waits, then AI completion drives rubrics", async () => {
    await seedQueueAndConfig();
    await seedAtcAlpha();

    // 1) atc_alpha lands BEFORE any AI output -> onAtcAlphaCreate path no-ops.
    await processAtcAlphaDoc(atcRef(), atcData());
    expect((await rubricsDocs()).size).toBe(0);
    expect(alerts.alertAtc.mock.calls[0][0]).toBe("warn"); // "AI not ready"
    alerts.alertAtc.mockClear();

    // 2) AI pipeline finishes: gen output + checkpoint complete -> vice-versa.
    await seedGenWithOutput();
    await seedCheckpoint();
    await maybeTriggerRubricsFromGeneration({
      docid: "cp1",
      sourceref: atcDb.doc(`queue_atc_generation/${GEN_ID}`),
    });

    const snap = await rubricsDocs();
    expect(snap.size).toBe(1);
    expect(snap.docs[0].data().stage).toBe("rubrics_scoring_stage1");
  });

  test("TC3.8 — both triggers fire: exactly one rubrics doc (dedup)", async () => {
    await seedQueueAndConfig();
    await seedAtcAlpha();
    await seedGenWithOutput();
    await seedCheckpoint();

    // atc_alpha side AND generation side both fire.
    await processAtcAlphaDoc(atcRef(), atcData());
    await maybeTriggerRubricsFromGeneration({
      docid: "cp1",
      sourceref: atcDb.doc(`queue_atc_generation/${GEN_ID}`),
    });

    const snap = await rubricsDocs();
    expect(snap.size).toBe(1);
  });
});
