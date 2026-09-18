/* global describe, test, expect */
const { makeFirestore, installFirebaseMocks, requireFresh } = require("./helpers/fake-firestore");

function setup() {
  const db = makeFirestore({
    profile_data: {
      P1: { profileid: "P1", email: "asha@example.com", name: "Asha", phonenumber: "+919876543210", user_ref: { path: "user_data/uid1", id: "uid1" } },
      P2: { profileid: "P2", email: "Mixed.Case@Example.com", name: "Mixed", number: "9123456789" },
      P3: { name: "No email, no profileid field" },
    },
  });
  installFirebaseMocks({ dbs: { default: db } });
  return requireFresh("resolve");
}

describe("participant360/resolve.js", () => {
  test("project(): normalises email, derives uid from user_ref, falls back to doc id for profileid", () => {
    const r = setup();
    expect(r.project({ id: "P9", email: " X@Y.COM ", user_ref: { id: "u9", path: "user_data/u9" } })).toEqual({ profileid: "P9", email: "x@y.com", name: null, phone: null, uid: "u9" });
    expect(r.project(null)).toBeNull();
  });

  test("byProfileId: found / missing / undefined", async () => {
    const r = setup();
    expect(await r.byProfileId("P1")).toMatchObject({ profileid: "P1", email: "asha@example.com", uid: "uid1", phone: "+919876543210" });
    expect(await r.byProfileId("P3")).toMatchObject({ profileid: "P3", email: null, uid: null });
    expect(await r.byProfileId("nope")).toBeNull();
    expect(await r.byProfileId(undefined)).toBeNull();
  });

  test("byEmail: lower-cased match first, then raw-case fallback, then null", async () => {
    const r = setup();
    expect((await r.byEmail("ASHA@example.com")).profileid).toBe("P1");
    expect((await r.byEmail("Mixed.Case@Example.com")).profileid).toBe("P2"); // stored mixed-case
    expect(await r.byEmail("mixed.case@example.com")).toBeNull();               // lower-cased lookup misses, raw is also lower -> miss
    expect(await r.byEmail("nobody@example.com")).toBeNull();
  });

  test("byPhone: matches phonenumber or number, with/without +, digits-only", async () => {
    const r = setup();
    expect((await r.byPhone("+919876543210")).profileid).toBe("P1");
    expect((await r.byPhone("919876543210")).profileid).toBe("P1");   // '+' + digits variant
    expect((await r.byPhone("9123456789")).profileid).toBe("P2");     // `number` field
    expect(await r.byPhone("0000000000")).toBeNull();
  });

  test("resolveParticipant: routes by shape — email > profileid > phone; garbage -> null", async () => {
    const r = setup();
    expect((await r.resolveParticipant("asha@example.com")).profileid).toBe("P1");
    expect((await r.resolveParticipant(" P1 ")).profileid).toBe("P1");
    expect((await r.resolveParticipant("9123456789")).profileid).toBe("P2");
    expect(await r.resolveParticipant("short")).toBeNull();      // not an id, < 8 digits
    expect(await r.resolveParticipant("")).toBeNull();
    expect(await r.resolveParticipant(null)).toBeNull();
    expect(await r.resolveParticipant(undefined)).toBeNull();
  });

  test("resolveTool: Messages-API shaped, handler returns ok / participant_not_found", async () => {
    const r = setup();
    expect(r.resolveTool.name).toBe("resolve");
    expect(r.resolveTool.input_schema.required).toEqual(["key"]);
    expect(await r.resolveTool.handler({ key: "asha@example.com" })).toEqual({ ok: true, profileid: "P1", email: "asha@example.com", name: "Asha" });
    expect(await r.resolveTool.handler({ key: "zzz" })).toEqual({ ok: false, error: "participant_not_found", key: "zzz" });
    expect(await r.resolveTool.handler({})).toMatchObject({ ok: false, error: "participant_not_found" });
  });
});
