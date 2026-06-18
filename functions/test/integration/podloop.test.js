/**
 * Pod loop — claimNextJob + writeJobResult (runpod_ai.js)
 *
 * Single-job model: getJobRequest hands out exactly one job per call (FIFO,
 * transactional), and submitJobResult persists results only if the pod still
 * owns the doc. These drive the two exported inner functions against the
 * emulator (firestore-atc).
 *
 * TCP.10a claim oldest pending (FIFO) → processing + claimedBy + startedAt
 * TCP.10b empty queue → null
 * TCP.10c two concurrent claims → two DISTINCT jobs, no double-claim
 * TCP.10d one job, two concurrent claims → exactly one winner, other gets null
 * TCP.11a ownership write: still processing & same pod → completed
 * TCP.11b foreign pod → skipped, doc untouched
 * TCP.11c doc not processing (already completed) → skipped
 * TCP.11d empty output → written but flagged as failure
 */
"use strict";

jest.mock("../../components/atc_alerts", () => ({
  alertAtc: jest.fn(async () => {}),
  notifySlack: jest.fn(async () => {}),
  DEFAULT_WEBHOOK: "mock-webhook",
}));

const { atcDb, clearAll } = require("./helpers");
const { claimNextJob, writeJobResult, requeueJob } = require("../../components/pod_jobs");

const COLL = "queue_atc_generation";

// Seed a pending job. `ageSec` makes createdAt deterministic for FIFO ordering
// (larger = older).
async function seedPending(id, ageSec, overrides = {}) {
  await atcDb.collection(COLL).doc(id).set({
    status: "pending",
    profileid: `prof-${id}`,
    prompt: `prompt-${id}`,
    systemprompt: `sys-${id}`,
    createdAt: new Date(Date.now() - ageSec * 1000),
    ...overrides,
  });
}

async function read(id) {
  return (await atcDb.collection(COLL).doc(id).get()).data();
}

beforeEach(async () => {
  await clearAll();
});

describe("claimNextJob — single-job FIFO transactional claim", () => {
  test("TCP.10a — claims the oldest pending, marks processing + ownership", async () => {
    await seedPending("newer", 10);
    await seedPending("older", 100);

    const job = await claimNextJob({ collectionName: COLL, podId: "podA" });

    expect(job).not.toBeNull();
    expect(job.jobId).toBe("older"); // FIFO: oldest createdAt first
    expect(job.prompt).toBe("prompt-older");
    expect(job.systemPrompt).toBe("sys-older");

    const older = await read("older");
    expect(older.status).toBe("processing");
    expect(older.claimedBy).toBe("podA");
    expect(older.startedAt).toBeDefined();

    const newer = await read("newer");
    expect(newer.status).toBe("pending"); // untouched
  });

  test("TCP.10b — empty queue returns null", async () => {
    const job = await claimNextJob({ collectionName: COLL, podId: "podA" });
    expect(job).toBeNull();
  });

  test("TCP.10c — two concurrent claims get two distinct jobs (no double-claim)", async () => {
    await seedPending("j1", 200);
    await seedPending("j2", 100);

    const [a, b] = await Promise.all([
      claimNextJob({ collectionName: COLL, podId: "podA" }),
      claimNextJob({ collectionName: COLL, podId: "podB" }),
    ]);

    const claimedIds = [a, b].filter(Boolean).map((j) => j.jobId).sort();
    expect(claimedIds).toEqual(["j1", "j2"]); // both claimed, no overlap

    const d1 = await read("j1");
    const d2 = await read("j2");
    expect(d1.status).toBe("processing");
    expect(d2.status).toBe("processing");
    // Distinct owners — the same doc was never handed to both pods.
    expect(d1.claimedBy).not.toBe(d2.claimedBy);
  });

  test("TCP.10d — one job, two concurrent claims: exactly one winner", async () => {
    await seedPending("only", 50);

    const results = await Promise.all([
      claimNextJob({ collectionName: COLL, podId: "podA" }),
      claimNextJob({ collectionName: COLL, podId: "podB" }),
    ]);

    const winners = results.filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0].jobId).toBe("only");

    const d = await read("only");
    expect(d.status).toBe("processing");
    expect(["podA", "podB"]).toContain(d.claimedBy);
  });
});

describe("writeJobResult — ownership-guarded result write", () => {
  async function seedProcessing(id, podId, overrides = {}) {
    await atcDb.collection(COLL).doc(id).set({
      status: "processing",
      claimedBy: podId,
      startedAt: new Date(),
      ...overrides,
    });
  }

  test("TCP.11a — still processing & same pod → completed", async () => {
    await seedProcessing("p1", "podA");

    const out = await writeJobResult({
      result: { path: `${COLL}/p1`, output: "the answer", finishReason: "stop", tokensGenerated: 42 },
      podId: "podA",
      modelName: "m1",
    });

    expect(out.written).toBe(true);
    expect(out.failure).toBeNull();
    const d = await read("p1");
    expect(d.status).toBe("completed");
    expect(d.output).toBe("the answer");
    expect(d.model).toBe("m1");
  });

  test("TCP.11b — foreign pod → skipped, doc untouched", async () => {
    await seedProcessing("p2", "podA");

    const out = await writeJobResult({
      result: { path: `${COLL}/p2`, output: "intruder", finishReason: "stop" },
      podId: "podB", // not the owner
      modelName: "m1",
    });

    expect(out.written).toBe(false);
    expect(out.skipped).toBe(true);
    expect(out.reason).toMatch(/owned by podA/);
    const d = await read("p2");
    expect(d.status).toBe("processing"); // unchanged
    expect(d.output).toBeUndefined();
  });

  test("TCP.11c — doc already completed → skipped (no clobber)", async () => {
    await atcDb.collection(COLL).doc("p3").set({
      status: "completed",
      claimedBy: "podA",
      output: "first run",
    });

    const out = await writeJobResult({
      result: { path: `${COLL}/p3`, output: "second run", finishReason: "stop" },
      podId: "podA",
      modelName: "m1",
    });

    expect(out.written).toBe(false);
    expect(out.reason).toMatch(/status=completed/);
    const d = await read("p3");
    expect(d.output).toBe("first run"); // original preserved
  });

  test("TCP.11d — empty output → written but flagged as failure", async () => {
    await seedProcessing("p4", "podA");

    const out = await writeJobResult({
      result: { path: `${COLL}/p4`, output: "", finishReason: "stop" },
      podId: "podA",
      modelName: "m1",
    });

    expect(out.written).toBe(true);
    expect(out.failure).not.toBeNull();
    expect(out.failure.emptyOutput).toBe(true);
  });
});

describe("requeueJob — attempts-capped requeue (no infinite reprocessing)", () => {
  async function seedProcessing(id, podId, attempts) {
    await atcDb.collection(COLL).doc(id).set({
      status: "processing",
      claimedBy: podId,
      startedAt: new Date(),
      attempts: attempts || 0,
    });
  }

  test("TCP.12a — under cap → back to pending, attempts++", async () => {
    await seedProcessing("r1", "podA", 0);
    const out = await requeueJob({ collectionName: COLL, path: `${COLL}/r1`, reason: "x", podId: "podA", maxAttempts: 3 });
    expect(out.requeued).toBe(true);
    expect(out.attempts).toBe(1);
    const d = await read("r1");
    expect(d.status).toBe("pending");
    expect(d.claimedBy).toBeUndefined();
  });

  test("TCP.12b — at cap → errored out, leaves pending pool", async () => {
    await seedProcessing("r2", "podA", 2); // next attempt = 3 == cap
    const out = await requeueJob({ collectionName: COLL, path: `${COLL}/r2`, reason: "boom", podId: "podA", maxAttempts: 3 });
    expect(out.errored).toBe(true);
    expect(out.attempts).toBe(3);
    const d = await read("r2");
    expect(d.status).toBe("error");
    expect(d.error).toMatch(/boom/);
  });

  test("TCP.12c — loop of requeue+claim terminates (never reprocesses forever)", async () => {
    await atcDb.collection(COLL).doc("r3").set({
      status: "pending", createdAt: new Date(), attempts: 0,
    });
    let claims = 0;
    // Simulate a poison job that always fails: claim → requeue, repeat.
    for (let i = 0; i < 10; i++) {
      const job = await claimNextJob({ collectionName: COLL, podId: "podA" });
      if (!job) break; // drained — proves the loop ends
      claims++;
      await requeueJob({ collectionName: COLL, path: job.path, reason: "always fails", podId: "podA", maxAttempts: 3 });
    }
    expect(claims).toBe(3); // claimed exactly cap times, then errored out
    const d = await read("r3");
    expect(d.status).toBe("error");
  });

  test("TCP.12d — foreign pod cannot requeue (ownership)", async () => {
    await seedProcessing("r4", "podA", 0);
    const out = await requeueJob({ collectionName: COLL, path: `${COLL}/r4`, reason: "x", podId: "podB", maxAttempts: 3 });
    expect(out.ok).toBe(false);
    const d = await read("r4");
    expect(d.status).toBe("processing"); // untouched
  });
});
