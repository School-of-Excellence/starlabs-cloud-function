/* global describe, test, expect, jest, beforeEach */
/**
 * index.js runtime behaviour: requireRole (token -> profile -> users_roles), the onRequest handler's
 * status-code mapping, runTool's error containment / shape enforcement / audit, toToolResult.
 * The registry-shape tests live in index.test.js.
 */
const { makeFirestore, installFirebaseMocks, requireFresh, fakeReq, fakeRes, ts } = require("./helpers/fake-firestore");

const ADMIN_UID = "uidAdmin";
function baseSeed() {
  return {
    user_data: { [ADMIN_UID]: { email: "admin@x.com" }, uidPart: { email: "asha@example.com" } },
    users_roles: { urAdmin: { admin: true, participant: true }, urPart: { participant: true }, urAh: { ah: true } },
    profile_data: {
      PA: { profileid: "PA", email: "admin@x.com", name: "Admin", user_ref: { path: `user_data/${ADMIN_UID}`, id: ADMIN_UID }, role_ref: { path: "users_roles/urAdmin", id: "urAdmin" } },
      P1: { profileid: "P1", email: "asha@example.com", name: "Asha", user_ref: { path: "user_data/uidPart", id: "uidPart" }, role_ref: { path: "users_roles/urPart", id: "urPart" } },
      PAH: { profileid: "PAH", email: "ah@x.com", name: "AH", role_ref: { path: "users_roles/urAh", id: "urAh" } }, // no user_ref -> email fallback
      PNR: { profileid: "PNR", email: "noroles@x.com", name: "NoRoles" },
    },
    appointments: { ap1: { bookedby: "P1", starttime: ts("2026-09-22T09:00:00Z"), endtime: ts("2026-09-22T09:45:00Z"), attended: false, cancelled: false, hosts: [] } },
  };
}

function setup({ seed = baseSeed(), tokens = {} } = {}) {
  const db = makeFirestore(seed);
  const verifyIdToken = jest.fn(async (token) => { if (!tokens[token]) throw new Error("bad token"); return tokens[token]; });
  const m = installFirebaseMocks({ dbs: { default: db }, verifyIdToken });
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
  return { m, db, idx: requireFresh("index"), verifyIdToken };
}
const TOKENS = { tAdmin: { uid: ADMIN_UID, email: "admin@x.com" }, tPart: { uid: "uidPart", email: "asha@example.com" }, tAh: { uid: "uidNoUserData", email: "ah@x.com" }, tNoRoles: { uid: "u0", email: "noroles@x.com" }, tGhost: { uid: "uGhost", email: "ghost@x.com" } };

describe("requireRole", () => {
  test("401 when header missing / not Bearer / token rejected", async () => {
    const { idx } = setup({ tokens: TOKENS });
    expect(await idx.requireRole(fakeReq({}))).toMatchObject({ status: 401, body: { ok: false, error: "unauthenticated" } });
    expect(await idx.requireRole(fakeReq({ headers: { Authorization: "Basic abc" } }))).toMatchObject({ status: 401 });
    expect(await idx.requireRole(fakeReq({ headers: { Authorization: "Bearer nope" } }))).toMatchObject({ status: 401, body: { message: "invalid or expired token" } });
  });
  test("403 when no profile for caller, or profile without an allowed role", async () => {
    const { idx } = setup({ tokens: TOKENS });
    expect(await idx.requireRole(fakeReq({ headers: { Authorization: "Bearer tGhost" } }))).toMatchObject({ status: 403, body: { message: "no profile for caller" } });
    expect(await idx.requireRole(fakeReq({ headers: { Authorization: "Bearer tPart" } }))).toMatchObject({ status: 403, body: { error: "forbidden", requiredRoles: ["admin", "ah", "developer"] } });
    expect(await idx.requireRole(fakeReq({ headers: { Authorization: "Bearer tNoRoles" } }))).toMatchObject({ status: 403 }); // no role_ref at all
  });
  test("ok via user_ref match, and via email fallback when user_ref is absent", async () => {
    const { idx } = setup({ tokens: TOKENS });
    expect(await idx.requireRole(fakeReq({ headers: { authorization: "Bearer tAdmin" } }))).toEqual({ caller: { uid: ADMIN_UID, email: "admin@x.com", profileid: "PA", roles: ["admin"] } });
    expect(await idx.requireRole(fakeReq({ headers: { Authorization: "Bearer tAh" } }))).toEqual({ caller: { uid: "uidNoUserData", email: "ah@x.com", profileid: "PAH", roles: ["ah"] } });
  });
});

describe("participant360 HTTP handler", () => {
  const call = async (idx, req) => { const res = fakeRes(); await idx.participant360(req, res); return res; };
  const auth = { Authorization: "Bearer tAdmin" };

  test("is registered with cors, the Watson secret and a 60s timeout", () => {
    const { idx } = setup();
    expect(idx.participant360.__opts).toMatchObject({ cors: true, timeoutSeconds: 60, secrets: [expect.objectContaining({ name: "WATSON_SERVICE_ACCOUNT" })] });
  });
  test("405 for non GET/POST; catalogue without auth on bare path", async () => {
    const { idx } = setup();
    expect((await call(idx, fakeReq({ method: "DELETE", path: "/purchase/P1" }))).statusCode).toBe(405);
    const res = await call(idx, fakeReq({ path: "/" }));
    expect(res.statusCode).toBe(200);
    expect(res.body.tools.map((t) => t.name)).toHaveLength(16);
    expect(res.body.tools.find((t) => t.name === "forms").filters).toEqual(["status"]);
  });
  test("401 / 403 come from the guard before any tool runs", async () => {
    const { idx } = setup({ tokens: TOKENS });
    expect((await call(idx, fakeReq({ path: "/purchase/P1" }))).statusCode).toBe(401);
    expect((await call(idx, fakeReq({ path: "/purchase/P1", headers: { Authorization: "Bearer tPart" } }))).statusCode).toBe(403);
  });
  test("resolve route: 200 by email, 404 unknown, key from query on POST", async () => {
    const { idx } = setup({ tokens: TOKENS });
    let res = await call(idx, fakeReq({ path: "/resolve/asha%40example.com", headers: auth }));
    expect(res.body).toEqual({ ok: true, profileid: "P1", email: "asha@example.com", name: "Asha" });
    res = await call(idx, fakeReq({ path: "/resolve/nobody@x.com", headers: auth }));
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ error: "participant_not_found", key: "nobody@x.com" });
    res = await call(idx, fakeReq({ method: "POST", path: "/resolve", body: { key: "P1" }, headers: auth }));
    expect(res.body.profileid).toBe("P1");
  });
  test("404 unknown tool (lists tools), 400 missing id, 404 unknown participant", async () => {
    const { idx } = setup({ tokens: TOKENS });
    let res = await call(idx, fakeReq({ path: "/purchse/P1", headers: auth }));
    expect(res.statusCode).toBe(404);
    expect(res.body.tools).toContain("purchase");
    res = await call(idx, fakeReq({ path: "/purchase", headers: auth }));
    expect(res.statusCode).toBe(400);
    res = await call(idx, fakeReq({ path: "/purchase/NOPE", headers: auth }));
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ ok: false, error: "participant_not_found", participantid: "NOPE" });
  });
  test("200 success: locked envelope, no-store, limit/since/filter forwarded, audit logged with X-Request-Id", async () => {
    const { idx } = setup({ tokens: TOKENS });
    const res = await call(idx, fakeReq({ path: "/appointment/P1", query: { limit: "5", status: "upcoming" }, headers: { ...auth, "X-Request-Id": "req-42" } }));
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.body)).toEqual(["ok", "version", "generatedAt", "data"]);
    expect(res.body.data.counts).toMatchObject({ total: 1, returned: 1, upcoming: 1 });
    expect(res.headers["Cache-Control"]).toBe("no-store");
    const audit = console.log.mock.calls.map((c) => c.join(" ")).find((s) => s.includes("[participant360]"));
    expect(audit).toMatch(/"tool":"appointment"/);
    expect(audit).toMatch(/"requestId":"req-42"/);
    expect(audit).toMatch(/"caller":"PA"/);
  });
  test("POST with JSON body supplies profileid and options", async () => {
    const { idx } = setup({ tokens: TOKENS });
    const res = await call(idx, fakeReq({ method: "POST", path: "/appointment", body: { profileid: "P1", limit: 1 }, headers: auth }));
    expect(res.statusCode).toBe(200);
    expect(res.body.data.counts.returned).toBe(1);
  });
  test("500 internal when a tool throws — response is JSON, never a crash", async () => {
    const { idx, db } = setup({ tokens: TOKENS });
    db._throwOn.set("appointments", "boom");
    const res = await call(idx, fakeReq({ path: "/appointment/P1", headers: auth }));
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ ok: false, error: "internal", message: "boom" });
  });
});

describe("runTool", () => {
  test("ctx.participant skips resolution; unknown tool / missing profileid / whitespace profileid", async () => {
    const { idx } = setup();
    const out = await idx.runTool("appointment", { profileid: "P1" }, { participant: { profileid: "P1", email: null, name: "Asha" } });
    expect(out.ok).toBe(true);
    expect(out.result.data.counts.total).toBe(1);
    expect(await idx.runTool("nope", { profileid: "P1" })).toMatchObject({ ok: false, error: "unknown_tool" });
    expect(await idx.runTool("appointment", { profileid: "   " })).toMatchObject({ ok: false, error: "bad_request" });
    expect(await idx.runTool("appointment", { profileid: 42 })).toMatchObject({ ok: false, error: "bad_request" });
    expect(await idx.runTool("appointment")).toMatchObject({ ok: false, error: "bad_request" });
  });
  test("participant_not_found when resolve misses; resolve tool passthrough", async () => {
    const { idx } = setup();
    expect(await idx.runTool("appointment", { profileid: "GHOST" })).toEqual({ ok: false, error: "participant_not_found", participantid: "GHOST" });
    expect(await idx.runTool("resolve", { key: "P1" })).toMatchObject({ ok: true, result: { ok: true, profileid: "P1" } });
  });
  test("a handler returning a malformed envelope is rejected as internal (assertShape)", async () => {
    const { idx } = setup();
    // tool objects are frozen, so swap the module itself for this one test (fresh registry first)
    installFirebaseMocks({ dbs: { default: makeFirestore(baseSeed()) } });
    jest.doMock("../../../components/participant360/tools/purchase", () => Object.freeze({ name: "purchase", description: "bad", input_schema: { properties: {}, required: ["profileid"] }, sources: ["x"], handler: async () => ({ ok: true, data: { summary: {}, counts: { total: 0 }, items: [] } }), project: () => ({}) }));
    const idx2 = requireFresh("index");
    const out = await idx2.runTool("purchase", { profileid: "P1" }, { participant: { profileid: "P1" } });
    expect(out).toMatchObject({ ok: false, error: "internal", message: expect.stringMatching(/invalid envelope/) });
    jest.dontMock("../../../components/participant360/tools/purchase");
  });
  test("audit receives ok/ms/error; an audit failure is logged, not propagated", async () => {
    const { idx } = setup();
    const audit = jest.fn();
    await idx.runTool("appointment", { profileid: "P1" }, { participant: { profileid: "P1" }, audit });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ tool: "appointment", profileid: "P1", ok: true, ms: expect.any(Number) }));
    const failing = jest.fn(async () => { throw new Error("audit down"); });
    const out = await idx.runTool("nope2", { profileid: "P1" }, { audit: failing }); // unknown tool: audit not reached
    expect(out.ok).toBe(false);
    const out2 = await idx.runTool("appointment", { profileid: "P1" }, { participant: { profileid: "P1" }, audit: failing });
    expect(out2.ok).toBe(true);
    expect(console.error).toHaveBeenCalledWith("[participant360] audit failed", "audit down");
  });
  test("toToolResult", () => {
    const { idx } = setup();
    expect(idx.toToolResult("tu", { ok: false, error: "unknown_tool", tools: ["a"] })).toEqual({ type: "tool_result", tool_use_id: "tu", content: JSON.stringify({ error: "unknown_tool", ok: false, tools: ["a"] }), is_error: true });
    expect(idx.toToolResult("tu", { ok: true, result: { x: 1 } })).toEqual({ type: "tool_result", tool_use_id: "tu", content: '{"x":1}' });
  });
});
