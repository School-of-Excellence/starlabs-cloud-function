/* global describe, test, expect, jest, beforeEach, afterEach */
const { makeFirestore, installFirebaseMocks, requireFresh } = require("./helpers/fake-firestore");

describe("participant360/collection.js", () => {
  let warn, error;
  beforeEach(() => { warn = jest.spyOn(console, "warn").mockImplementation(() => {}); error = jest.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => jest.restoreAllMocks());

  test("initializes the default admin app exactly once and only when none exists", () => {
    const m = installFirebaseMocks();
    requireFresh("collection");
    expect(m.admin.initializeApp).toHaveBeenCalledTimes(1);
    expect(m.admin.apps.map((a) => a.name)).toEqual(["[DEFAULT]"]);
  });

  test("dbFor routes default / forms / watson and caches the handles", () => {
    const m = installFirebaseMocks({ secrets: { WATSON_SERVICE_ACCOUNT: JSON.stringify({ project_id: "starlabs-cicd", client_email: "x@y", private_key: "k" }) } });
    const { C, dbFor } = requireFresh("collection");
    expect(dbFor(C.PROFILE)).toBe(m.dbs.default);
    expect(dbFor(C.FORMS_BY_CLIENT)).toBe(m.dbs.forms);
    expect(dbFor(C.W_PARTICIPANTS)).toBe(m.dbs.watson);
    dbFor(C.PROFILE); dbFor(C.FORMS_BY_CLIENT); dbFor(C.W_PARTICIPANTS);
    expect(m.getFirestore).toHaveBeenCalledTimes(3);
    expect(m.admin.initializeApp).toHaveBeenLastCalledWith({ credential: { __cert: expect.objectContaining({ project_id: "starlabs-cicd" }) } }, "watson");
  });

  test("watson: missing secret -> null handle, one warning, every Watson read returns []", async () => {
    installFirebaseMocks();
    const { C, dbFor, col, docsOf, docById } = requireFresh("collection");
    expect(dbFor(C.W_PARTICIPANTS)).toBeNull();
    expect(dbFor(C.W_PURCHASES)).toBeNull();
    expect(col(C.W_PAYMENTS)).toBeNull();
    expect(await docsOf(C.W_SCHEDULE)).toEqual([]);
    expect(await docById(C.W_PARTICIPANTS, "x")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/WATSON_SERVICE_ACCOUNT secret not set/);
  });

  test("watson: invalid secret JSON -> null handle and an error log, no throw", () => {
    installFirebaseMocks({ secrets: { WATSON_SERVICE_ACCOUNT: "{not json" } });
    const { C, dbFor } = requireFresh("collection");
    expect(dbFor(C.W_PARTICIPANTS)).toBeNull();
    expect(error).toHaveBeenCalled();
    expect(error.mock.calls[0][0]).toMatch(/WATSON_SERVICE_ACCOUNT invalid/);
  });

  test("watson: cert() rejecting the JSON is contained the same way", () => {
    installFirebaseMocks({ secrets: { WATSON_SERVICE_ACCOUNT: JSON.stringify({ nope: true }) } });
    const { C, dbFor } = requireFresh("collection");
    expect(dbFor(C.W_PARTICIPANTS)).toBeNull();
    expect(error.mock.calls[0][0]).toMatch(/invalid service account/);
  });

  test("watson: reuses an already-initialised 'watson' app instead of creating a second", () => {
    const m = installFirebaseMocks({ secrets: { WATSON_SERVICE_ACCOUNT: JSON.stringify({ project_id: "p" }) } });
    m.admin.apps.push({ name: "watson", options: {} });
    const { C, dbFor } = requireFresh("collection");
    expect(dbFor(C.W_PARTICIPANTS)).toBe(m.dbs.watson);
    expect(m.admin.initializeApp).not.toHaveBeenCalledWith(expect.anything(), "watson"); // existing app reused
    expect(m.admin.apps.filter((a) => a.name === "watson")).toHaveLength(1);
  });

  test("docsOf applies the builder and returns {id, _path, ...data}; docById returns null when missing", async () => {
    const db = makeFirestore({ profile_data: { p1: { email: "a@x.com", name: "A" }, p2: { email: "b@x.com" } } });
    installFirebaseMocks({ dbs: { default: db } });
    const { C, docsOf, docById } = requireFresh("collection");
    expect(await docsOf(C.PROFILE, (c) => c.where("email", "==", "b@x.com"))).toEqual([{ id: "p2", _path: "profile_data/p2", email: "b@x.com" }]);
    expect((await docsOf(C.PROFILE)).length).toBe(2);
    expect(await docById(C.PROFILE, "p1")).toMatchObject({ id: "p1", name: "A" });
    expect(await docById(C.PROFILE, "nope")).toBeNull();
    expect(await docById(C.PROFILE, undefined)).toBeNull();
    expect(await docById(C.PROFILE, 123)).toBeNull(); // String(123) doc does not exist
  });

  test("docsOf propagates a query error (callers decide whether to .catch)", async () => {
    const db = makeFirestore({});
    db._throwOn.set("appointments", "index missing");
    installFirebaseMocks({ dbs: { default: db } });
    const { C, docsOf } = requireFresh("collection");
    await expect(docsOf(C.APPOINTMENTS)).rejects.toThrow("index missing");
  });

  test("getAllByRef: dedupes, accepts refs and 'collection/id' strings, returns null for missing docs, [] -> empty Map", async () => {
    const db = makeFirestore({ journey: { j1: { journey: "uP!" } }, products: { pr1: { name: "Kick-off" } } });
    installFirebaseMocks({ dbs: { default: db } });
    const { getAllByRef } = requireFresh("collection");
    const r = await getAllByRef([db._ref("journey/j1"), "journey/j1", "products/pr1", "products/missing", null, undefined, { path: null }]);
    expect([...r.keys()]).toEqual(["journey/j1", "products/pr1", "products/missing"]);
    expect(r.get("journey/j1")).toMatchObject({ id: "j1", journey: "uP!" });
    expect(r.get("products/missing")).toBeNull();
    expect((await getAllByRef([])).size).toBe(0);
  });

  test("stripHidden removes Tier-C fields and every atc* key, leaves the rest, tolerates non-objects", () => {
    installFirebaseMocks();
    const { stripHidden, HIDDEN_KEYS } = requireFresh("collection");
    const out = stripHidden({ name: "A", currentjourney: "x", currentjourneystatus: "y", currentproductstatus: "z", atcsummary: 1, ATCmodel: 2, atc: 3, mapatcmodeltobiglevel: 4, participantmode: "m" });
    expect(out).toEqual({ name: "A", participantmode: "m" });
    expect(stripHidden(null)).toBeNull();
    expect(stripHidden("str")).toBe("str");
    expect(HIDDEN_KEYS).toContain("currentjourney");
  });

  test("registry: every entry has a db in {default, forms, watson} and there is no atc entry", () => {
    installFirebaseMocks();
    const { C } = requireFresh("collection");
    for (const [k, e] of Object.entries(C)) {
      expect(["default", "forms", "watson"]).toContain(e.db);
      expect(typeof e.name).toBe("string");
      expect(e.name).not.toMatch(/^atc|firestore-atc/i);
      expect(k).not.toMatch(/atc/i);
    }
    expect(Object.isFrozen(C)).toBe(true);
  });
});
