/* global describe, test, expect, jest */
// All Firebase packages are replaced by in-memory mocks — nothing here touches a real project.
const { installFirebaseMocks } = require("./helpers/fake-firestore");
installFirebaseMocks();
const env = require("../../../components/participant360/envelope");

const NOW = new Date("2026-09-17T10:00:00.000Z");
const ts = (iso) => ({ toDate: () => new Date(iso) });

describe("participant360/envelope helpers", () => {
  test("toIso accepts Timestamp, Date, {seconds}, ISO string, null", () => {
    expect(env.toIso(ts("2026-01-02T03:04:05.000Z"))).toBe("2026-01-02T03:04:05.000Z");
    expect(env.toIso(new Date("2026-01-02T03:04:05.000Z"))).toBe("2026-01-02T03:04:05.000Z");
    expect(env.toIso({ seconds: Math.floor(new Date("2026-01-02T03:04:05.000Z").getTime() / 1000) })).toBe("2026-01-02T03:04:05.000Z");
    expect(env.toIso("2026-01-02")).toBe("2026-01-02T00:00:00.000Z");
    expect(env.toIso(null)).toBeNull();
    expect(env.toIso("garbage")).toBeNull();
  });

  test("daysUntil / refId / refPath / normalizeStatus", () => {
    expect(env.daysUntil("2026-09-20T00:00:00.000Z", NOW)).toBe(3);
    expect(env.daysUntil("2026-09-10T00:00:00.000Z", NOW)).toBe(-7);
    expect(env.refId({ id: "abc", path: "products/abc" })).toBe("abc");
    expect(env.refId("products/abc")).toBe("abc");
    expect(env.refPath({ path: "products/abc" })).toBe("products/abc");
    expect(env.normalizeStatus(null)).toBe("not_started");
    expect(env.normalizeStatus(" In Progress ")).toBe("in_progress");
  });

  test("tally + tallyText", () => {
    const t = env.tally([{ s: "a" }, { s: "b" }, { s: "a" }], "s");
    expect(t).toEqual({ a: 2, b: 1 });
    expect(env.tallyText(t)).toBe("2 a, 1 b");
    expect(env.tallyText({})).toBe("none");
  });

  test("envelope has the locked shape and counts.returned == items.length", () => {
    const r = env.envelope({ summary: { headline: "hi", x: 1 }, counts: { total: 5, y: 2 }, items: [{ a: 1 }, { a: 2 }], now: NOW });
    expect(Object.keys(r)).toEqual(["ok", "version", "generatedAt", "data"]);
    expect(Object.keys(r.data)).toEqual(["summary", "counts", "items"]);
    expect(r.data.summary.headline).toBe("hi");
    expect(r.data.counts).toEqual({ total: 5, y: 2, returned: 2 });
    expect(r.generatedAt).toBe(NOW.toISOString());
    expect(r).not.toHaveProperty("tool");
    expect(r).not.toHaveProperty("participant");
    expect(r).not.toHaveProperty("sources");
    expect(r).not.toHaveProperty("warnings");
  });

  test("parseOptions caps limit at 100 and defaults to 20", () => {
    expect(env.parseOptions({}).limit).toBe(20);
    expect(env.parseOptions({ limit: "500" }).limit).toBe(100);
    expect(env.parseOptions({ limit: 0 }).limit).toBe(20);
    expect(env.parseOptions({ since: "2026-01-01" }).since).toBe("2026-01-01T00:00:00.000Z");
  });

  test("sinceFilter and newestFirst", () => {
    const rows = [{ d: "2026-01-01T00:00:00.000Z" }, { d: "2026-03-01T00:00:00.000Z" }, { d: null }];
    expect(env.sinceFilter(rows, "d", "2026-02-01").length).toBe(1);
    expect(env.newestFirst(rows, "d", 1)[0].d).toBe("2026-03-01T00:00:00.000Z");
  });
});
