/**
 * Stage 0 — processStage / resolvePreviousStage (queuesystem.js)
 * Covers TC0.1 (form), TC0.3 (dedup), TC0.4 (no config), TC0.5 (form missing),
 * TC0.7 (first stage). Driven via the exported inner functions.
 */
"use strict";

// Mock Slack so failures are captured, not POSTed. (Hoisted above requires.)
jest.mock("../../components/atc_alerts", () => ({
  alertAtc: jest.fn(async () => {}),
  notifySlack: jest.fn(async () => {}),
  DEFAULT_WEBHOOK: "mock-webhook",
}));

const { defaultDb, atcDb, formsDb, clearAll } = require("./helpers");
const alerts = require("../../components/atc_alerts");
const { processStage, resolvePreviousStage } = require("../../components/queuesystem");

const PROFILE = "p1";
const TOKEN = "tok1";
const QUEUE_PATH = "queue generation/q1";
const FORM_ID = "form123";

// queueRef passed to processStage is the default-DB queue generation ref
// (onQueueStageChange passes queueDocSnap.ref).
const queueRef = () => defaultDb.doc(QUEUE_PATH);

function baseQueueData() {
  return {
    atcrequiredstages: [
      { stage: "stage1", type: "form", generateatc: true, pairingstages: [] },
    ],
    stageproperty: {
      stage1: { actionresource: defaultDb.doc(`forms/${FORM_ID}`) },
    },
  };
}

async function seedForm() {
  await formsDb.collection("formsByClient").doc("fc1").set({
    profileid: PROFILE,
    formid: FORM_ID,
    queueref: formsDb.doc(QUEUE_PATH), // stored as a firestore-forms ref (match key)
    date: new Date(),
    formname: "LifeAspirationForm",
    formarray: [
      { type: "text", fieldname: "Goal", value: "be happy" },
      { type: "label", fieldname: "ignore me", value: "x" }, // skipped
    ],
  });
}

async function genDocsForToken() {
  return atcDb
    .collection("queue_atc_generation")
    .where("queue_token_id", "==", TOKEN)
    .get();
}

beforeEach(async () => {
  await clearAll();
  alerts.alertAtc.mockClear();
});

describe("Stage 0 — processStage", () => {
  test("TC0.1 — form stage writes one queue_atc_generation doc with correct shape/DB", async () => {
    await seedForm();
    await processStage({
      queueData: baseQueueData(),
      queueRef: queueRef(),
      tokenData: { profile_id: PROFILE },
      queueTokenId: TOKEN,
      currentStage: "stage1",
    });

    const snap = await genDocsForToken();
    expect(snap.size).toBe(1);
    const d = snap.docs[0].data();
    expect(d.type).toBe("form");
    expect(d.queueref.path).toBe(QUEUE_PATH); // firestore-atc ref, same path
    expect(d.profileid).toBe(PROFILE);
    expect(d.stage).toBe("stage1");
    expect(d.sourceref.path).toBe("formsByClient/fc1");
    expect(typeof d.data).toBe("string");
    expect(d.data).toContain("be happy");
    expect(d.data).toContain("LifeAspirationForm");
    expect(alerts.alertAtc).not.toHaveBeenCalled();
  });

  test("TC0.3 — second identical call does not duplicate the gen doc", async () => {
    await seedForm();
    const args = {
      queueData: baseQueueData(),
      queueRef: queueRef(),
      tokenData: { profile_id: PROFILE },
      queueTokenId: TOKEN,
      currentStage: "stage1",
    };
    await processStage(args);
    await processStage(args); // duplicate fire — dedup guard on sourceref.path
    const snap = await genDocsForToken();
    expect(snap.size).toBe(1);
  });

  test("TC0.4 — stage not in atcrequiredstages: no doc, no alert (by design)", async () => {
    await seedForm();
    await processStage({
      queueData: { atcrequiredstages: [{ stage: "OTHER", type: "form" }] },
      queueRef: queueRef(),
      tokenData: { profile_id: PROFILE },
      queueTokenId: TOKEN,
      currentStage: "stage1",
    });
    const snap = await genDocsForToken();
    expect(snap.size).toBe(0);
    expect(alerts.alertAtc).not.toHaveBeenCalled();
  });

  test("TC0.5 — no matching formsByClient doc: warn alert, no doc", async () => {
    // no seedForm()
    await processStage({
      queueData: baseQueueData(),
      queueRef: queueRef(),
      tokenData: { profile_id: PROFILE },
      queueTokenId: TOKEN,
      currentStage: "stage1",
    });
    const snap = await genDocsForToken();
    expect(snap.size).toBe(0);
    expect(alerts.alertAtc).toHaveBeenCalledTimes(1);
    expect(alerts.alertAtc.mock.calls[0][0]).toBe("warn");
  });

  test("TC0.9 — cross-DB routing: form is read from firestore-forms, NOT firestore-atc", async () => {
    // The emulator isolates named databases. Seed formsByClient in the WRONG
    // database (firestore-atc). processStage reads formsByClient from
    // firestore-forms, so it must find nothing — proving the read is genuinely
    // scoped to firestore-forms. (If someone reverted the DB-routing fix to read
    // from adminATC, THIS is the test that would catch it: it'd start passing
    // here and break the real pipeline.)
    await atcDb.collection("formsByClient").doc("fc1").set({
      profileid: PROFILE,
      formid: FORM_ID,
      queueref: atcDb.doc(QUEUE_PATH),
      date: new Date(),
      formname: "LifeAspirationForm",
      formarray: [{ type: "text", fieldname: "Goal", value: "be happy" }],
    });

    await processStage({
      queueData: baseQueueData(),
      queueRef: queueRef(),
      tokenData: { profile_id: PROFILE },
      queueTokenId: TOKEN,
      currentStage: "stage1",
    });

    expect((await genDocsForToken()).size).toBe(0); // not found in firestore-forms
    expect(alerts.alertAtc.mock.calls[0][0]).toBe("warn");

    // And the positive path writes the gen doc to firestore-atc, not default.
    await formsDb.collection("formsByClient").doc("fc2").set({
      profileid: PROFILE,
      formid: FORM_ID,
      queueref: formsDb.doc(QUEUE_PATH),
      date: new Date(),
      formname: "LifeAspirationForm",
      formarray: [{ type: "text", fieldname: "Goal", value: "be happy" }],
    });
    await processStage({
      queueData: baseQueueData(),
      queueRef: queueRef(),
      tokenData: { profile_id: PROFILE },
      queueTokenId: TOKEN,
      currentStage: "stage1",
    });
    expect((await genDocsForToken()).size).toBe(1); // written to firestore-atc
    const inDefault = await defaultDb
      .collection("queue_atc_generation")
      .where("queue_token_id", "==", TOKEN)
      .get();
    expect(inDefault.size).toBe(0); // NOT in the default database
  });
});

describe("Stage 0 — resolvePreviousStage", () => {
  test("TC0.2-pre — returns the stage before the current one", async () => {
    const prev = await resolvePreviousStage({
      queueData: { stages: ["stage1", "stage2", "stage3"] },
      tokenData: {},
      currentStage: "stage2",
    });
    expect(prev).toBe("stage1");
  });

  test("TC0.7 — first stage resolves to null (no previous)", async () => {
    const prev = await resolvePreviousStage({
      queueData: { stages: ["stage1", "stage2"] },
      tokenData: {},
      currentStage: "stage1",
    });
    expect(prev).toBeNull();
  });
});
