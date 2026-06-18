/**
 * Stage 1 — processAtcGenerationDoc (queue_atc_generation.js)
 * Covers TC1.1 (prompt build), TC1.2 (type skip), TC1.3 (config missing),
 * TC1.4 (pairings missing).
 */
"use strict";

jest.mock("../../components/atc_alerts", () => ({
  alertAtc: jest.fn(async () => {}),
  notifySlack: jest.fn(async () => {}),
  DEFAULT_WEBHOOK: "mock-webhook",
}));

const { defaultDb, atcDb, clearAll } = require("./helpers");
const alerts = require("../../components/atc_alerts");
const { processAtcGenerationDoc } = require("../../components/queue_atc_generation");

const PROFILE = "p1";
const TOKEN = "tok1";
const QUEUE_PATH = "queue generation/q1";

async function seedConfig() {
  await defaultDb.collection("classify").doc("atcprompts").set({
    systemprompt: "SYS_PROMPT",
    prompttogenerateatc: "gen",
    approvedProcedures: [],
  });
}

function genData(overrides = {}) {
  return {
    generateatc: true,
    type: "form",
    profileid: PROFILE,
    queue_token_id: TOKEN,
    queueref: atcDb.doc(QUEUE_PATH),
    pairingstages: [],
    stage: "stage1",
    data: "the report body",
    ...overrides,
  };
}

async function seedGenDoc(id, data) {
  await atcDb.collection("queue_atc_generation").doc(id).set(data);
}

async function readGen(id) {
  return (await atcDb.collection("queue_atc_generation").doc(id).get()).data();
}

beforeEach(async () => {
  await clearAll();
  alerts.alertAtc.mockClear();
});

describe("Stage 1 — processAtcGenerationDoc", () => {
  test("TC1.1 — builds prompt + systemprompt, status:pending, checkpoint:true", async () => {
    await seedConfig();
    const data = genData();
    await seedGenDoc("g1", data);
    await processAtcGenerationDoc("g1", data);

    const d = await readGen("g1");
    expect(d.status).toBe("pending");
    expect(d.checkpoint).toBe(true);
    expect(d.systemprompt).toBe("SYS_PROMPT");
    expect(typeof d.prompt).toBe("string");
    expect(d.prompt).toContain("the report body");
    expect(alerts.alertAtc).not.toHaveBeenCalled();
  });

  test("TC1.2 — non form/zoom type is skipped (no prompt written)", async () => {
    await seedConfig();
    const data = genData({ type: "rubrics scoring" });
    await seedGenDoc("g2", data);
    await processAtcGenerationDoc("g2", data);

    const d = await readGen("g2");
    expect(d.status).toBeUndefined();
    expect(d.prompt).toBeUndefined();
  });

  test("TC1.3 — classify/atcprompts missing: critical alert, no prompt", async () => {
    const data = genData();
    await seedGenDoc("g3", data);
    await processAtcGenerationDoc("g3", data);

    const d = await readGen("g3");
    expect(d.status).toBeUndefined();
    expect(alerts.alertAtc).toHaveBeenCalledTimes(1);
    expect(alerts.alertAtc.mock.calls[0][0]).toBe("critical");
  });

  test("TC1.4 — all pairing stages missing: warn alert, still builds prompt", async () => {
    await seedConfig();
    const data = genData({ pairingstages: ["stageMissing"] });
    await seedGenDoc("g4", data);
    await processAtcGenerationDoc("g4", data);

    const d = await readGen("g4");
    expect(d.status).toBe("pending");
    expect(alerts.alertAtc).toHaveBeenCalledTimes(1);
    expect(alerts.alertAtc.mock.calls[0][0]).toBe("warn");
  });
});
