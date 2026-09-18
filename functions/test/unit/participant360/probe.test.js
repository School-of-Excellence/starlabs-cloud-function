/* global describe, test, expect, jest, beforeEach, afterEach, __dirname */
/**
 * Unit tests for scripts/participant360/probe-lib.js — the core shared by probe-purchase.js and
 * probe-all.js. No Firebase package is loaded: the service-account layer is exercised with an in-memory
 * fake fs, and the runner layer with the fake Firestore from ./helpers (same as the tool tests).
 */
const path = require("path");
const { makeFirestore, installFirebaseMocks, requireFresh, ts } = require("./helpers/fake-firestore");

const LIB = path.join(__dirname, "../../../scripts/participant360/probe-lib.js");
const lib = require(LIB);

const TEST_SA = { type: "service_account", project_id: "starlabs-test", client_email: "sa@starlabs-test.iam", private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n" };
const PROD_SA = { ...TEST_SA, project_id: "fir-sample-aae4a" };
const CICD_SA = { ...TEST_SA, project_id: "starlabs-cicd" };

/** Tiny in-memory fs for loadServiceAccount(). */
function fakeFs(files) {
  return { existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p), readFileSync: (p) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]; } };
}

describe("probe-lib: parseArgs", () => {
  test("defaults", () => {
    expect(lib.parseArgs([])).toMatchObject({ key: null, sa: null, project: "starlabs-test", tool: "purchase", tools: null, limit: 20, since: null, outFile: null, raw: false, help: false, continueOnError: true });
  });
  test("positional key + every flag", () => {
    const a = lib.parseArgs(["P1", "--sa", "k.json", "--project", "starlabs-cicd", "--tool", "queue", "--limit", "5", "--since", "2026-01-01", "--out", "o.json", "--raw"]);
    expect(a).toMatchObject({ key: "P1", sa: "k.json", project: "starlabs-cicd", tool: "queue", limit: 5, since: "2026-01-01", outFile: "o.json", raw: true });
  });
  test("email / phone keys and --help", () => {
    expect(lib.parseArgs(["a@b.com"]).key).toBe("a@b.com");
    expect(lib.parseArgs(["+919876543210"]).key).toBe("+919876543210");
    expect(lib.parseArgs(["-h"]).help).toBe(true);
    expect(lib.parseArgs(["--help"]).help).toBe(true);
  });
  test("multiTool mode: --tools list and --fail-fast; rejected in single-tool mode", () => {
    const a = lib.parseArgs(["P1", "--tools", "purchase, queue ,,events", "--fail-fast"], { multiTool: true });
    expect(a.tools).toEqual(["purchase", "queue", "events"]);
    expect(a.continueOnError).toBe(false);
    expect(() => lib.parseArgs(["P1", "--tools", "purchase"])).toThrow(/unknown argument: --tools/);
    expect(() => lib.parseArgs(["P1", "--fail-fast"])).toThrow(/unknown argument/);
  });
  test("errors: unknown flag, second positional, flag without value — all exit code 2", () => {
    for (const argv of [["P1", "--bogus"], ["P1", "P2"], ["P1", "--limit"], ["--sa"]]) {
      let err; try { lib.parseArgs(argv); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(lib.ProbeError);
      expect(err.exitCode).toBe(2);
    }
  });
  test("non-numeric limit becomes NaN (tools fall back to their default)", () => {
    expect(Number.isNaN(lib.parseArgs(["P1", "--limit", "abc"]).limit)).toBe(true);
  });
});

describe("probe-lib: service account & project safety", () => {
  const env = (o = {}) => ({ ...o });
  test("loads a valid starlabs-test key from --sa", () => {
    const { sa, saPath } = lib.loadServiceAccount({ sa: "/k/test.json", project: "starlabs-test" }, env(), fakeFs({ "/k/test.json": JSON.stringify(TEST_SA) }));
    expect(saPath).toBe("/k/test.json");
    expect(sa.project_id).toBe("starlabs-test");
  });
  test("falls back to STARLABS_TEST_SA, then GOOGLE_APPLICATION_CREDENTIALS; expands ~", () => {
    const files = { "/k/env.json": JSON.stringify(TEST_SA), "/k/adc.json": JSON.stringify(TEST_SA) };
    expect(lib.loadServiceAccount({ project: "starlabs-test" }, env({ STARLABS_TEST_SA: "/k/env.json", GOOGLE_APPLICATION_CREDENTIALS: "/k/adc.json" }), fakeFs(files)).saPath).toBe("/k/env.json");
    expect(lib.loadServiceAccount({ project: "starlabs-test" }, env({ GOOGLE_APPLICATION_CREDENTIALS: "/k/adc.json" }), fakeFs(files)).saPath).toBe("/k/adc.json");
    expect(lib.expandHome("~/x.json")).toMatch(/[\\/]x\.json$/);
    expect(lib.expandHome("~/x.json")).not.toMatch(/^~/);
    expect(lib.expandHome("/abs/x.json")).toBe("/abs/x.json");
    expect(lib.expandHome(null)).toBeNull();
  });
  test("missing file / no path -> exit 2", () => {
    expect(() => lib.loadServiceAccount({ project: "starlabs-test" }, env(), fakeFs({}))).toThrow(/service-account file not found/);
    expect(() => lib.loadServiceAccount({ sa: "/nope.json", project: "starlabs-test" }, env(), fakeFs({}))).toThrow(expect.objectContaining({ exitCode: 2 }));
  });
  test("invalid JSON / not a service account (web config) -> exit 2", () => {
    expect(() => lib.loadServiceAccount({ sa: "/k/bad.json", project: "starlabs-test" }, env(), fakeFs({ "/k/bad.json": "{nope" }))).toThrow(/not valid JSON/);
    expect(() => lib.loadServiceAccount({ sa: "/k/web.json", project: "starlabs-test" }, env(), fakeFs({ "/k/web.json": JSON.stringify({ projectId: "starlabs-test", apiKey: "x" }) }))).toThrow(/not a Firebase service-account key/);
    expect(() => lib.loadServiceAccount({ sa: "/k/nokey.json", project: "starlabs-test" }, env(), fakeFs({ "/k/nokey.json": JSON.stringify({ ...TEST_SA, private_key: "" }) }))).toThrow(expect.objectContaining({ exitCode: 2 }));
  });
  test("production key is HARD-ABORTED (exit 3) even when --project names production", () => {
    const fsx = fakeFs({ "/k/prod.json": JSON.stringify(PROD_SA) });
    expect(() => lib.loadServiceAccount({ sa: "/k/prod.json", project: "starlabs-test" }, env(), fsx)).toThrow(expect.objectContaining({ exitCode: 3, message: expect.stringMatching(/HARD ABORT/) }));
    expect(() => lib.loadServiceAccount({ sa: "/k/prod.json", project: "fir-sample-aae4a" }, env(), fsx)).toThrow(/HARD ABORT/);
    for (const id of lib.DENYLIST) expect(() => lib.checkProject(id, id)).toThrow(/HARD ABORT/);
    expect(() => lib.checkProject("starlabs-test", "watsonproduction-becde")).toThrow(/HARD ABORT/);
  });
  test("project must be allow-listed and must equal the key's project_id (exit 3)", () => {
    expect(() => lib.checkProject("starlabs-cicd", "some-other")).toThrow(/not an allowed probe target/);
    expect(() => lib.checkProject("starlabs-cicd", "starlabs-test")).toThrow(/service account is for 'starlabs-cicd' but --project is 'starlabs-test'/);
    expect(() => lib.checkProject("starlabs-cicd", "starlabs-cicd")).not.toThrow();
    expect(() => lib.checkProject("starlabs-test-19", "starlabs-test-19")).not.toThrow();
    const fsx = fakeFs({ "/k/cicd.json": JSON.stringify(CICD_SA) });
    expect(() => lib.loadServiceAccount({ sa: "/k/cicd.json", project: "starlabs-test" }, env(), fsx)).toThrow(expect.objectContaining({ exitCode: 3 }));
    expect(lib.loadServiceAccount({ sa: "/k/cicd.json", project: "starlabs-cicd" }, env(), fsx).sa.project_id).toBe("starlabs-cicd");
  });
  test("ALLOWLIST and DENYLIST never overlap; defaults are consistent", () => {
    expect(lib.ALLOWLIST.filter((p) => lib.DENYLIST.includes(p))).toEqual([]);
    expect(lib.ALLOWLIST).toContain(lib.DEFAULT_PROJECT);
    expect(Object.isFrozen(lib.ALLOWLIST) && Object.isFrozen(lib.DENYLIST)).toBe(true);
  });
  test("hardenEnv: refuses emulator env, scrubs every ADC variable, leaves others", () => {
    const e = { FIRESTORE_EMULATOR_HOST: "localhost:8080" };
    expect(() => lib.hardenEnv(e)).toThrow(expect.objectContaining({ exitCode: 3 }));
    const e2 = { GOOGLE_APPLICATION_CREDENTIALS: "/prod.json", FIREBASE_CONFIG: "{}", GCLOUD_PROJECT: "fir-sample-aae4a", GOOGLE_CLOUD_PROJECT: "x", PATH: "/bin" };
    lib.hardenEnv(e2);
    expect(e2).toEqual({ PATH: "/bin" });
  });
});

describe("probe-lib: tool discovery & selection", () => {
  test("listTools reads the real tools folder and finds all 16", () => {
    const tools = lib.listTools();
    expect(tools).toHaveLength(16);
    expect(tools).toEqual([...tools].sort());
    expect(tools).toEqual(expect.arrayContaining(["purchase", "finance", "profileAuthentication"]));
    expect(lib.ALL_ORDER).toHaveLength(16);
    expect([...lib.ALL_ORDER].sort()).toEqual(tools);
  });
  test("listTools ignores non-js files (injected fs)", () => {
    const fsx = { readdirSync: () => ["b.js", "a.js", "README.md", "c.js.map"] };
    expect(lib.listTools("/x", fsx)).toEqual(["a", "b"]);
  });
  test("selectTools: single tool, list, unknown -> exit 2 naming the culprit", () => {
    const avail = ["purchase", "queue"];
    expect(lib.selectTools({ tool: "queue", tools: null }, avail)).toEqual(["queue"]);
    expect(lib.selectTools({ tool: "purchase", tools: ["queue", "purchase"] }, avail)).toEqual(["queue", "purchase"]);
    expect(lib.selectTools({ tool: "purchase", tools: [] }, avail)).toEqual(["purchase"]);
    let err; try { lib.selectTools({ tool: "purchse", tools: null }, avail); } catch (e) { err = e; }
    expect(err.exitCode).toBe(2);
    expect(err.message).toMatch(/unknown tool\(s\) 'purchse'/);
    expect(() => lib.selectTools({ tool: null, tools: ["queue", "nope", "zzz"] }, avail)).toThrow(/'nope, zzz'/);
  });
});

describe("probe-lib: toPlain", () => {
  test("Timestamps -> ISO, refs -> <ref path>, nested, arrays, null/undefined", () => {
    const doc = { a: ts("2026-01-02T03:04:05.000Z"), r: { path: "products/p1", id: "p1", extra: 1 }, list: [{ path: "x/y", id: "y" }, 2, null], n: null, s: "keep", nested: { t: ts("2026-02-02T00:00:00.000Z") }, arrOfPathLike: [{ path: "not", id: 1 }] };
    expect(lib.toPlain(doc)).toEqual({ a: "2026-01-02T03:04:05.000Z", r: "<ref products/p1>", list: ["<ref x/y>", 2, null], n: null, s: "keep", nested: { t: "2026-02-02T00:00:00.000Z" }, arrOfPathLike: [{ path: "not", id: 1 }] });
    expect(lib.toPlain(undefined)).toBeNull();
    expect(lib.toPlain([])).toEqual([]);
  });
});

describe("probe-lib: runOne / runMany against the real registry with fake Firestore", () => {
  const PID = "P1";
  let p360, participant, logs;
  beforeEach(() => {
    const db = makeFirestore({
      profile_data: { [PID]: { profileid: PID, email: "asha@example.com", name: "Asha" } },
      appointments: { ap1: { bookedby: PID, starttime: ts("2026-09-22T09:00:00Z"), endtime: ts("2026-09-22T09:45:00Z"), attended: false, cancelled: false, hosts: [] } },
      queue_token: { qt1: { profile_id: PID, tokenstatus: "active", currentstage: "Requested" } },
    });
    installFirebaseMocks({ dbs: { default: db } });
    jest.spyOn(console, "error").mockImplementation(() => {});
    p360 = requireFresh("index");
    participant = { profileid: PID, email: "asha@example.com", name: "Asha", phone: null, uid: null };
    logs = [];
  });
  afterEach(() => jest.restoreAllMocks());

  test("runOne: ok result carries the locked envelope, ms, and emits the audit line", async () => {
    const r = await lib.runOne(p360, "appointment", participant, { limit: 20, since: null }, (l) => logs.push(l));
    expect(r).toMatchObject({ tool: "appointment", ok: true, ms: expect.any(Number) });
    expect(Object.keys(r.response)).toEqual(["ok", "version", "generatedAt", "data"]);
    expect(r.response.data.counts).toMatchObject({ total: 1, returned: 1, upcoming: 1 });
    expect(logs.some((l) => l.startsWith("▶ audit") && l.includes('"tool":"appointment"'))).toBe(true);
  });
  test("runOne: unknown tool -> ok:false with the registry's error, never throws", async () => {
    const r = await lib.runOne(p360, "purchse", participant, { limit: 20, since: null });
    expect(r).toMatchObject({ tool: "purchse", ok: false, error: { ok: false, error: "unknown_tool" } });
  });
  test("runMany: runs in order, continues past a failure, summary + report + exit code", async () => {
    const results = await lib.runMany(p360, ["appointment", "purchse", "queue"], participant, { limit: 20, since: null }, (l) => logs.push(l));
    expect(results.map((r) => [r.tool, r.ok])).toEqual([["appointment", true], ["purchse", false], ["queue", true]]);
    expect(logs.filter((l) => l.startsWith("✓")).length).toBe(2);
    expect(logs.filter((l) => l.startsWith("✗")).length).toBe(1);
    const table = lib.summaryTable(results);
    expect(table).toMatch(/^OK {2}\s+appointment/m);
    expect(table).toMatch(/^FAIL\s+purchse .*unknown_tool/m);
    expect(table).toMatch(/2\/3 tools ok$/);
    const report = lib.buildReport({ project: "starlabs-test", participant, key: PID, results });
    expect(report).toMatchObject({ ok: false, project: "starlabs-test", key: PID, participant });
    expect(report.tools.map((t) => t.tool)).toEqual(["appointment", "purchse", "queue"]);
    expect(report.results.appointment.data.counts.total).toBe(1);
    expect(report.results.purchse).toMatchObject({ ok: false, error: "unknown_tool" });
    expect(report.raw).toBeUndefined();
    expect(lib.exitCodeFor(results)).toBe(1);
  });
  test("runMany: --fail-fast stops after the first failure", async () => {
    const results = await lib.runMany(p360, ["purchse", "appointment"], participant, { limit: 20, since: null, continueOnError: false });
    expect(results.map((r) => r.tool)).toEqual(["purchse"]);
  });
  test("runMany: a tool that throws is captured as internal and the run continues", async () => {
    const broken = { runTool: jest.fn(async (name) => { if (name === "boom") throw new Error("kaboom"); return { ok: true, result: { ok: true, version: 1, generatedAt: "x", data: { summary: { headline: "h" }, counts: { total: 0, returned: 0 }, items: [] } } }; }) };
    const results = await lib.runMany(broken, ["boom", "fine"], participant, { limit: 1 });
    expect(results[0]).toMatchObject({ tool: "boom", ok: false, error: { error: "internal", message: "kaboom" } });
    expect(results[1].ok).toBe(true);
    expect(lib.exitCodeFor(results)).toBe(1);
    expect(lib.exitCodeFor([results[1]])).toBe(0);
    expect(lib.exitCodeFor([])).toBe(1);
  });
  test("runMany over ALL 16 tools: every tool answers for a participant with no data (headline, zero counts)", async () => {
    const results = await lib.runMany(p360, lib.ALL_ORDER, participant, { limit: 20, since: null });
    expect(results).toHaveLength(16);
    for (const r of results) {
      expect(r.ok).toBe(true);
      expect(typeof r.response.data.summary.headline).toBe("string");
      expect(r.response.data.counts.returned).toBe(r.response.data.items.length);
    }
    expect(results.find((r) => r.tool === "finance").response.data.summary.headline).toMatch(/Watson service account not configured/);
    expect(lib.exitCodeFor(results)).toBe(0);
    expect(lib.summaryTable(results)).toMatch(/16\/16 tools ok$/);
  });
  test("buildReport attaches raw when given", () => {
    const report = lib.buildReport({ project: "p", participant, key: "k", results: [], raw: { x: 1 } });
    expect(report.raw).toEqual({ x: 1 });
    expect(report.ok).toBe(true); // vacuous — CLI exit code covers the empty case
  });
});

describe("probe CLIs: static checks (never executed)", () => {
  const fs = require("fs");
  const read = (f) => fs.readFileSync(path.join(__dirname, "../../../scripts/participant360", f), "utf8");
  test("both CLIs use probe-lib and initialise the admin app only after loadServiceAccount + hardenEnv", () => {
    for (const f of ["probe-purchase.js", "probe-all.js"]) {
      const src = read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""); // code only — the headers mention names in prose
      expect(src).toMatch(/require\("\.\/probe-lib"\)/);
      const iLoad = src.indexOf("lib.loadServiceAccount("), iHarden = src.indexOf("lib.hardenEnv("), iAdmin = src.indexOf('require("firebase-admin")'), iModule = src.indexOf('require("../../components/participant360")');
      expect(iLoad).toBeGreaterThan(0);
      expect(iHarden).toBeGreaterThan(iLoad);
      expect(iAdmin).toBeGreaterThan(iHarden);
      expect(iModule).toBeGreaterThan(iAdmin);
      expect(src).not.toMatch(/process\.exit\(/); // exitCode + app.delete() instead
      expect(src).not.toMatch(/firestore-atc/);
    }
  });
  test("package.json exposes both npm shortcuts", () => {
    const pkg = require("../../../package.json");
    expect(pkg.scripts["p360:probe"]).toBe("node scripts/participant360/probe-purchase.js");
    expect(pkg.scripts["p360:probe:all"]).toBe("node scripts/participant360/probe-all.js");
  });
});
