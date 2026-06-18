/**
 * Integration — scope-enhancement-atc-pipeline usage rollup (emulator-backed).
 *
 * Seeds terminal queue_atc_generation docs (firestore-atc) with finalizedAt across
 * a target IST day, runs runUsageRollup, and asserts the daily + lifetime docs in
 * the default DB — including idempotency on re-run.
 *
 * SE.10a daily docs reflect per-coach × type counts + byFailure
 * SE.10b lifetime docs equal the sum; ALL aggregates across coaches
 * SE.10c docs outside the window / without finalizedAt are excluded
 * SE.10d re-run is idempotent (daily unchanged, lifetime NOT double-counted)
 */
"use strict";

jest.mock("../../components/atc_alerts", () => ({
  alertAtc: jest.fn(async () => {}),
  notifySlack: jest.fn(async () => {}),
  DEFAULT_WEBHOOK: "mock-webhook",
}));

const { atcDb, defaultDb, clearAll } = require("./helpers");
const { runUsageRollup, constants } = require("../../scope-enhancement-atc-pipeline/se_atc_usage");

const SRC = constants.SOURCE_COLLECTION;
const NOW = new Date("2026-06-18T01:00:00+05:30"); // → rolls up 2026-06-17 (IST)
const DATE = "2026-06-17";

// helpers to build in-window timestamps
const ist = (hhmm) => new Date(`2026-06-17T${hhmm}:00+05:30`);

async function seed(id, doc) {
  await atcDb.collection(SRC).doc(id).set(doc);
}
async function daily(id) {
  return (await defaultDb.collection(constants.DAILY_COLLECTION).doc(id).get()).data();
}
async function lifetime(id) {
  return (await defaultDb.collection(constants.LIFETIME_COLLECTION).doc(id).get()).data();
}

beforeEach(async () => {
  await clearAll();

  // p1: 1 completed generation (40s turnaround), 1 errored generation (timeout, retried)
  await seed("p1-gen-ok", {
    profileid: "p1", type: "generation", status: "completed", attempts: 0,
    createdAt: new Date("2026-06-17T10:00:00+05:30"), finalizedAt: new Date("2026-06-17T10:00:40+05:30"),
  });
  await seed("p1-gen-err", {
    profileid: "p1", type: "generation", status: "error", attempts: 3,
    failureCategory: "infer_timeout", finalizedAt: ist("11:00"),
  });
  // p2: 1 completed rubrics (retried once)
  await seed("p2-rub-ok", {
    profileid: "p2", type: "rubrics scoring", status: "completed", attempts: 1,
    createdAt: new Date("2026-06-17T12:00:00+05:30"), finalizedAt: new Date("2026-06-17T12:00:50+05:30"),
  });
  // excluded: finalized the previous day
  await seed("old", {
    profileid: "p1", type: "generation", status: "completed", attempts: 0,
    finalizedAt: new Date("2026-06-16T10:00:00+05:30"),
  });
  // excluded: still pending, no finalizedAt
  await seed("pending", { profileid: "p1", type: "generation", status: "pending", attempts: 0 });
});

describe("runUsageRollup", () => {
  test("SE.10a — daily docs reflect per-coach × type counts + byFailure", async () => {
    const res = await runUsageRollup(NOW);
    expect(res.dateStr).toBe(DATE);
    expect(res.docsScanned).toBe(3); // old + pending excluded

    const p1 = await daily(`${DATE}_p1`);
    expect(p1).toMatchObject({ date: DATE, profileid: "p1", total: 2, completed: 1, failed: 1, retried: 1 });
    expect(p1.byType.generation).toMatchObject({ total: 2, completed: 1, failed: 1 });
    expect(p1.byFailure).toEqual({ infer_timeout: 1 });
    expect(p1.byType.generation.turnaroundMsSum).toBe(40000);

    const p2 = await daily(`${DATE}_p2`);
    expect(p2).toMatchObject({ total: 1, completed: 1, retried: 1 });
  });

  test("SE.10b — lifetime + ALL aggregates", async () => {
    await runUsageRollup(NOW);

    const lifeP1 = await lifetime("p1");
    expect(lifeP1).toMatchObject({ total: 2, completed: 1, failed: 1, firstSeen: DATE });

    const all = await lifetime("__ALL");
    expect(all).toMatchObject({ total: 3, completed: 2, failed: 1 });

    const dailyAll = await daily(`${DATE}___ALL`);
    expect(dailyAll).toMatchObject({ total: 3, completed: 2, failed: 1 });
  });

  test("SE.10d — re-run is idempotent (lifetime not double-counted)", async () => {
    const first = await runUsageRollup(NOW);
    expect(first.lifetimeApplied).toBe(true);

    const second = await runUsageRollup(NOW);
    expect(second.lifetimeApplied).toBe(false); // marker guard

    const all = await lifetime("__ALL");
    expect(all.total).toBe(3); // NOT 6
    const p1 = await lifetime("p1");
    expect(p1.total).toBe(2); // NOT 4

    // daily still correct (idempotent overwrite)
    const dailyP1 = await daily(`${DATE}_p1`);
    expect(dailyP1.total).toBe(2);
  });
});
