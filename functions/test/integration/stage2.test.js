/**
 * Stage 2 — processCheckpointVerificationDoc (queue_atc_generation.js)
 * Covers TC2.1 (happy path), TC2.2 (dedup), TC2.3 (no output), TC2.4 (config missing).
 */
"use strict";

jest.mock("../../components/atc_alerts", () => ({
  alertAtc: jest.fn(async () => {}),
  notifySlack: jest.fn(async () => {}),
  DEFAULT_WEBHOOK: "mock-webhook",
}));

const { defaultDb, atcDb, clearAll } = require("./helpers");
const alerts = require("../../components/atc_alerts");
const { processCheckpointVerificationDoc } = require("../../components/queue_atc_generation");

const PROFILE = "p1";
const TOKEN = "tok1";
const QUEUE_PATH = "queue generation/q1";
const SOURCE_ID = "g1";

async function seedConfig() {
  await defaultDb.collection("classify").doc("atcprompts").set({ systemprompt: "SYS_PROMPT" });
}

function sourceData(overrides = {}) {
  return {
    output: "ATC text to verify",
    profileid: PROFILE,
    queue_token_id: TOKEN,
    queueref: atcDb.doc(QUEUE_PATH),
    pairingstages: [],
    stage: "stage1",
    type: "form",
    ...overrides,
  };
}

async function checkpointReports() {
  return atcDb
    .collection("queue_atc_generation")
    .where("type", "==", "checkpoint report")
    .get();
}

beforeEach(async () => {
  await clearAll();
  alerts.alertAtc.mockClear();
});

describe("Stage 2 — processCheckpointVerificationDoc", () => {
  test("TC2.1 — happy path writes a checkpoint report doc", async () => {
    await seedConfig();
    const data = sourceData();
    await atcDb.collection("queue_atc_generation").doc(SOURCE_ID).set(data);
    await processCheckpointVerificationDoc(SOURCE_ID, data);

    const snap = await checkpointReports();
    expect(snap.size).toBe(1);
    const d = snap.docs[0].data();
    expect(d.type).toBe("checkpoint report");
    expect(d.sourceref.path).toBe(`queue_atc_generation/${SOURCE_ID}`);
    expect(d.checkpoint).toBe(false);
    expect(d.status).toBe("pending");
    expect(d.stage).toBe("stage1 checkpoint report");
    expect(d.data).toBe("ATC text to verify");
    expect(alerts.alertAtc).not.toHaveBeenCalled();
  });

  test("TC2.2 — existing checkpoint report for source: skip + info alert", async () => {
    await seedConfig();
    const data = sourceData();
    await atcDb.collection("queue_atc_generation").doc(SOURCE_ID).set(data);
    // Pre-existing checkpoint report keyed on sourceref + type.
    await atcDb.collection("queue_atc_generation").doc("existing-cp").set({
      type: "checkpoint report",
      sourceref: atcDb.doc(`queue_atc_generation/${SOURCE_ID}`),
    });

    await processCheckpointVerificationDoc(SOURCE_ID, data);

    const snap = await checkpointReports();
    expect(snap.size).toBe(1); // no new doc
    expect(alerts.alertAtc).toHaveBeenCalledTimes(1);
    expect(alerts.alertAtc.mock.calls[0][0]).toBe("info");
  });

  test("TC2.3 — source has no output: warn alert, no doc", async () => {
    await seedConfig();
    const data = sourceData({ output: "" });
    await processCheckpointVerificationDoc(SOURCE_ID, data);

    const snap = await checkpointReports();
    expect(snap.size).toBe(0);
    expect(alerts.alertAtc).toHaveBeenCalledTimes(1);
    expect(alerts.alertAtc.mock.calls[0][0]).toBe("warn");
  });

  test("TC2.4 — classify/atcprompts missing: critical alert, no doc", async () => {
    const data = sourceData();
    await processCheckpointVerificationDoc(SOURCE_ID, data);

    const snap = await checkpointReports();
    expect(snap.size).toBe(0);
    expect(alerts.alertAtc).toHaveBeenCalledTimes(1);
    expect(alerts.alertAtc.mock.calls[0][0]).toBe("critical");
  });
});
