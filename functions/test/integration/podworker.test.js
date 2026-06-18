/**
 * Pod worker state machine — markReady / markUnhealthy (pod_worker.js)
 *
 * TCW.1 ready + pending jobs        → start-worker, state=READY, workerRunning
 * TCW.2 ready + no pending          → terminate, state=TERMINATING
 * TCW.3 ready but worker running     → skip (only one worker), state=READY
 * TCW.4 ready with stale podid       → ignore
 * TCW.5 ready in wrong state (IDLE)  → ignore
 * TCW.6 unhealthy                    → HALTED + in-flight job requeued
 */
"use strict";

jest.mock("../../components/atc_alerts", () => ({
  alertAtc: jest.fn(async () => {}),
  notifySlack: jest.fn(async () => {}),
  DEFAULT_WEBHOOK: "mock-webhook",
}));

const { defaultDb, atcDb, clearAll } = require("./helpers");
const { markReady, markUnhealthy, WORKER_DOC, STATES } = require("../../components/pod_worker");

const COLL = "queue_atc_generation";

async function setWorker(data) {
  await defaultDb.collection("classify").doc(WORKER_DOC).set(data);
}
async function readWorker() {
  return (await defaultDb.collection("classify").doc(WORKER_DOC).get()).data();
}
async function seedPending(id) {
  await atcDb.collection(COLL).doc(id).set({ status: "pending", createdAt: new Date() });
}

beforeEach(async () => {
  await clearAll();
});

describe("markReady", () => {
  test("TCW.1 — ready + pending jobs → start-worker", async () => {
    await setWorker({ state: STATES.LOADING, podid: "podA" });
    await seedPending("j1");

    const d = await markReady({ podid: "podA", apiUrl: "http://pod/api", bearerToken: "tok" });

    expect(d.action).toBe("start-worker");
    const w = await readWorker();
    expect(w.state).toBe(STATES.READY);
    expect(w.workerRunning).toBe(true);
    expect(w.apiUrl).toBe("http://pod/api");
    expect(w.bearerToken).toBe("tok");
  });

  test("TCW.2 — ready + no pending → terminate", async () => {
    await setWorker({ state: STATES.LOADING, podid: "podA" });

    const d = await markReady({ podid: "podA" });

    expect(d.action).toBe("terminate");
    const w = await readWorker();
    expect(w.state).toBe(STATES.TERMINATING);
  });

  test("TCW.3 — worker already running → skip, stays READY", async () => {
    await setWorker({ state: STATES.LOADING, podid: "podA", workerRunning: true });
    await seedPending("j1");

    const d = await markReady({ podid: "podA" });

    expect(d.action).toBe("skip");
    const w = await readWorker();
    expect(w.state).toBe(STATES.READY);
  });

  test("TCW.4 — stale podid → ignore", async () => {
    await setWorker({ state: STATES.LOADING, podid: "podA" });
    await seedPending("j1");

    const d = await markReady({ podid: "podB" });

    expect(d.action).toBe("ignore");
    const w = await readWorker();
    expect(w.state).toBe(STATES.LOADING); // unchanged
  });

  test("TCW.5 — wrong state (IDLE) → ignore", async () => {
    await setWorker({ state: STATES.IDLE, podid: "podA" });
    await seedPending("j1");

    const d = await markReady({ podid: "podA" });

    expect(d.action).toBe("ignore");
  });
});

describe("markUnhealthy", () => {
  test("TCW.6 — halts and requeues the in-flight job", async () => {
    await atcDb.collection(COLL).doc("inflight").set({
      status: "processing", claimedBy: "podA", startedAt: new Date(), attempts: 0,
    });
    await setWorker({
      state: STATES.READY, podid: "podA", workerRunning: true,
      currentJobPath: `${COLL}/inflight`,
    });

    const d = await markUnhealthy({ podid: "podA", reason: "gpu fell over" });

    expect(d.action).toBe("terminate");
    const w = await readWorker();
    expect(w.state).toBe(STATES.HALTED);
    expect(w.halted).toBe(true);
    expect(w.workerRunning).toBe(false);

    const job = (await atcDb.collection(COLL).doc("inflight").get()).data();
    expect(job.status).toBe("pending"); // requeued
    expect(job.attempts).toBe(1);
  });
});
