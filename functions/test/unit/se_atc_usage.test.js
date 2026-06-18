/**
 * Unit tests — scope-enhancement-atc-pipeline pure helpers (no emulator).
 *   SE.1 aggregateUsage   — grouping + counts + turnaround + byFailure
 *   SE.2 istDayWindow      — previous IST calendar-day window
 *   SE.3 classifyFailure   — normalized failure categories
 */
"use strict";

const { aggregateUsage, istDayWindow } = require("../../scope-enhancement-atc-pipeline/se_atc_usage_aggregate");
const { classifyFailure } = require("../../scope-enhancement-atc-pipeline/se_atc_failure_classifier");

describe("SE.1 aggregateUsage", () => {
  const rows = [
    { profileid: "p1", type: "generation",        status: "completed", attempts: 0, createdAt: 1000, finalizedAt: 41000 },
    { profileid: "p1", type: "generation",        status: "error",     attempts: 3, failureCategory: "infer_timeout" },
    { profileid: "p1", type: "checkpoint report", status: "completed", attempts: 0, createdAt: 2000, finalizedAt: 32000 },
    { profileid: "p2", type: "rubrics scoring",   status: "completed", attempts: 1, createdAt: 0,    finalizedAt: 50000 },
    { profileid: "p2", type: "rubrics scoring",   status: "error",     attempts: 0, failureCategory: "empty_output" },
  ];

  const { byProfile, all } = aggregateUsage(rows);

  test("(a) per-profile totals", () => {
    expect(byProfile.p1).toMatchObject({ total: 3, completed: 2, failed: 1, retried: 1 });
    expect(byProfile.p2).toMatchObject({ total: 2, completed: 1, failed: 1, retried: 1 });
  });

  test("(b) byType buckets", () => {
    expect(byProfile.p1.byType.generation).toMatchObject({ total: 2, completed: 1, failed: 1, retried: 1 });
    expect(byProfile.p1.byType["checkpoint report"]).toMatchObject({ total: 1, completed: 1 });
    expect(byProfile.p2.byType["rubrics scoring"]).toMatchObject({ total: 2, completed: 1, failed: 1, retried: 1 });
  });

  test("(c) turnaround counted for completed only (sum/count)", () => {
    // p1: generation 40000 + checkpoint 30000 = 70000 over 2 completed
    expect(byProfile.p1.turnaroundMsSum).toBe(70000);
    expect(byProfile.p1.turnaroundCount).toBe(2);
    expect(byProfile.p1.byType.generation.turnaroundMsSum).toBe(40000);
    // error row contributes nothing to turnaround
    expect(byProfile.p2.turnaroundCount).toBe(1);
  });

  test("(d) byFailure tallies by category", () => {
    expect(byProfile.p1.byFailure).toEqual({ infer_timeout: 1 });
    expect(byProfile.p2.byFailure).toEqual({ empty_output: 1 });
  });

  test("(e) ALL aggregate sums across profiles", () => {
    expect(all).toMatchObject({ total: 5, completed: 3, failed: 2, retried: 2 });
    expect(all.byFailure).toEqual({ infer_timeout: 1, empty_output: 1 });
    expect(all.turnaroundMsSum).toBe(120000);
    expect(all.turnaroundCount).toBe(3);
  });

  test("(f) empty input -> empty aggregate", () => {
    const { byProfile: bp, all: a } = aggregateUsage([]);
    expect(bp).toEqual({});
    expect(a).toMatchObject({ total: 0, completed: 0, failed: 0 });
  });
});

describe("SE.2 istDayWindow", () => {
  test("(a) 01:00 IST -> previous IST calendar day", () => {
    const now = new Date("2026-06-18T01:00:00+05:30");
    const { start, end, dateStr } = istDayWindow(now);
    expect(dateStr).toBe("2026-06-17");
    expect(start.toISOString()).toBe("2026-06-16T18:30:00.000Z"); // 2026-06-17 00:00 IST
    expect(end.toISOString()).toBe("2026-06-17T18:30:00.000Z");   // 2026-06-18 00:00 IST
  });

  test("(b) window is exactly 24h", () => {
    const { start, end } = istDayWindow(new Date("2026-06-18T01:00:00+05:30"));
    expect(end.getTime() - start.getTime()).toBe(86400000);
  });
});

describe("SE.3 classifyFailure", () => {
  const cases = [
    [{ reason: "infer error: timeout (attempts=3)" }, "infer_timeout"],
    [{ error: "ETIMEDOUT calling pod" }, "infer_timeout"],
    [{ reason: "no pod available" }, "pod_unavailable"],
    [{ error: "Unexpected token in JSON parse" }, "bad_json"],
    [{ emptyOutput: true }, "empty_output"],
    [{ reason: "infer error: 502 bad gateway" }, "infer_error"],
    [{ finishReason: "error" }, "infer_error"],
    [{ reason: "stuck processing (attempts=3)" }, "max_attempts"],
    [{ reason: "requeue" }, "max_attempts"],
    [{}, "unknown"],
    [{ finishReason: "stop" }, "unknown"],
  ];

  test.each(cases)("classify %j -> %s", (sig, expected) => {
    expect(classifyFailure(sig)).toBe(expected);
  });
});
