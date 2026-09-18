/* global describe, test, expect */
/**
 * Invalid / missing / malformed inputs for the pure layer: envelope helpers and every tool's project().
 * A tool must never throw on partial data — it must return the locked envelope with sensible nulls.
 */
const { installFirebaseMocks, requireFresh, ts } = require("./helpers/fake-firestore");

installFirebaseMocks();
const env = requireFresh("envelope");
const T = (n) => requireFresh(`tools/${n}`);
const NOW = new Date("2026-09-17T10:00:00.000Z");
const ref = (p) => ({ path: p, id: p.split("/").pop() });
const NAMES = ["purchase", "finance", "activeProduct", "forms", "appointment", "queue", "events", "communication", "recommendation", "content", "mode", "roles", "videoAsk", "evolutionMapping", "systemBilling", "profileAuthentication"];

const locked = (r) => {
  expect(Object.keys(r)).toEqual(["ok", "version", "generatedAt", "data"]);
  expect(typeof r.data.summary.headline).toBe("string");
  expect(r.data.counts.returned).toBe(r.data.items.length);
  return r.data;
};

describe("envelope helpers — remaining surface", () => {
  test("withFilter adds one property and keeps required/additionalProperties", () => {
    const s = env.withFilter("kind", { type: "string", enum: ["a"] });
    expect(Object.keys(s.properties)).toEqual(["profileid", "limit", "since", "kind"]);
    expect(s.required).toEqual(["profileid"]);
    expect(s.additionalProperties).toBe(false);
    expect(Object.isFrozen(s)).toBe(true);
  });
  test("emptyEnvelope carries extra summary/counts and zero items", () => {
    const r = env.emptyEnvelope("Nothing", NOW, { database: "x" }, { extra: 0 });
    expect(r.data).toEqual({ summary: { headline: "Nothing", database: "x" }, counts: { total: 0, extra: 0, returned: 0 }, items: [] });
    expect(r.generatedAt).toBe(NOW.toISOString());
  });
  test("envelope tolerates missing/invalid pieces", () => {
    const r = env.envelope({ summary: undefined, counts: undefined, items: "not an array", now: NOW });
    expect(r.data).toEqual({ summary: { headline: "" }, counts: { total: 0, returned: 0 }, items: [] });
  });
  test("toMs / toDay / daysUntil on garbage", () => {
    expect(env.toMs(undefined)).toBeNull();
    expect(env.toMs({ seconds: "x" })).toBeNull();
    expect(env.toDay(123)).toBeNull();
    expect(env.daysUntil(null, NOW)).toBeNull();
    expect(env.daysUntil("nope", NOW)).toBeNull();
  });
  test("parseOptions: negative / NaN / string limits, bad since, injected now", () => {
    expect(env.parseOptions({ limit: -3 }).limit).toBe(20);
    expect(env.parseOptions({ limit: "abc" }).limit).toBe(20);
    expect(env.parseOptions({ limit: "7" }, { limit: 50 }).limit).toBe(7);
    expect(env.parseOptions({}, { limit: 5 }).limit).toBe(5);
    expect(env.parseOptions({ since: "not a date" }).since).toBeNull();
    expect(env.parseOptions({ now: NOW }).now).toBe(NOW);
    expect(env.parseOptions({ now: "2026-01-01" }).now).toBeInstanceOf(Date); // non-Date now is replaced
  });
  test("plural / tally with null values / refId on odd inputs", () => {
    expect(env.plural(1, "item")).toBe("1 item");
    expect(env.plural(0, "item")).toBe("0 items");
    expect(env.tally([{ k: null }, { k: undefined }, { k: 0 }], "k")).toEqual({ null: 2, 0: 1 });
    expect(env.refId(null)).toBeNull();
    expect(env.refId({})).toBeNull();
    expect(env.refPath(42)).toBeNull();
  });
});

describe("project(): completely empty / undefined raw for every tool", () => {
  for (const n of NAMES) {
    test(`${n} tolerates {} and undefined pieces`, () => {
      const d = locked(T(n).project({}, { now: NOW }));
      expect(d.counts.total).toBe(0);
      expect(d.items).toEqual([]);
      expect(d.summary.headline.length).toBeGreaterThan(0);
      locked(T(n).project({ pmd: null, profile: null, names: undefined, items: null }, { now: NOW }));
    });
  }
  test("project() with no opts at all uses defaults (now = real clock)", () => {
    for (const n of NAMES) expect(T(n).project({}).ok).toBe(true);
  });
});

describe("purchase edge cases", () => {
  test("null pmd, journey without refs, unknown journeystatus, future subscription", () => {
    const d = locked(T("purchase").project({ pmd: null, pjps: [{ id: "j", journeystatus: "WeIrD", subscriptionstart: ts("2027-01-01T00:00:00Z"), subscriptionend: ts("2027-12-31T00:00:00Z") }], psps: [] }, { now: NOW }));
    expect(d.items[0]).toMatchObject({ journeyname: null, journeystatus: "weird", isActive: false, subscriptionStatus: "future", package: { packageref: null, packagename: null } });
    expect(d.summary.customerstatus).toBeNull();
    expect(d.summary.headline).toMatch(/No active journey/);
  });
  test("since filter and limit=0 fallback", () => {
    const raw = { pjps: [{ id: "a", journeystatus: "completed", subscriptionstart: ts("2024-01-01T00:00:00Z") }, { id: "b", journeystatus: "completed", subscriptionstart: ts("2026-01-01T00:00:00Z") }], psps: [] };
    expect(T("purchase").project(raw, { now: NOW, since: "2025-06-01" }).data.items.map((i) => i.participantjourneyproductid)).toEqual(["b"]);
    expect(T("purchase").project(raw, { now: NOW, limit: 0 }).data.counts.returned).toBe(2); // 0 -> default 20
  });
  test("statusdate as plain string and as garbage", () => {
    const d = locked(T("purchase").project({ pjps: [{ id: "j", journeystatus: "ongoing", participantproducts: [{ participantproductid: "p1" }, { participantproductid: "p2" }] }], psps: [{ id: "p1", status: "ready", statusdate: "2026-01-01" }, { id: "p2", status: "ready", statusdate: 42 }] }, { now: NOW }));
    expect(d.items[0].products.map((p) => p.statusdate)).toEqual([null, null]); // only Timestamp / Date / {seconds} / map forms are converted
  });
});

describe("finance edge cases", () => {
  test("no Watson participant -> headline says so; payments without purchaseid attach to every purchase; failed payment counted", () => {
    const d = locked(T("finance").project({ participant: null, purchases: [{ id: "A" }, { id: "B" }], payments: [{ id: "p", amount: "100", status: "FAILED" }], schedule: [] }, { now: NOW }));
    expect(d.summary.headline).toMatch(/No Watson finance record/);
    expect(d.items.map((i) => i.payments.length)).toEqual([1, 1]);
    expect(d.counts.paymentsFailed).toBe(1);
    expect(d.summary.totalPaid).toBe(0);
  });
  test("string amounts, unknown schedule status kept verbatim, cancelled purchase", () => {
    const d = locked(T("finance").project({ participant: { id: "W" }, purchases: [{ id: "A", cancelled: true, totalPurchaseValue: "1000" }], payments: [{ id: "p", amount: "250", status: "success", purchaseid: "A" }], schedule: [{ purchaseid: "A", date: ts("2026-01-01T00:00:00Z"), amount: "50", status: "waived" }] }, { now: NOW }));
    expect(d.items[0]).toMatchObject({ status: "cancelled", purchaseValue: 1000, paid: 250, balance: 750 });
    expect(d.items[0].schedule[0].status).toBe("waived");
    expect(d.counts.purchasesCancelled).toBe(1);
  });
});

describe("appointment / queue / events derived-status tables", () => {
  test("appointment.deriveStatus", () => {
    const f = T("appointment").deriveStatus;
    expect(f({ cancelled: true, attended: true }, NOW)).toBe("cancelled");
    expect(f({ attended: true }, NOW)).toBe("attended");
    expect(f({ starttime: ts("2030-01-01T00:00:00Z") }, NOW)).toBe("upcoming");
    expect(f({ starttime: ts("2020-01-01T00:00:00Z") }, NOW)).toBe("missed");
    expect(f({}, NOW)).toBe("missed"); // no starttime -> not upcoming
  });
  test("appointment: unknown status filter yields empty items but keeps counts of everything", () => {
    const d = locked(T("appointment").project({ appointments: [{ id: "a", attended: true }] }, { now: NOW, status: "bogus" }));
    expect(d.items).toEqual([]);
    expect(d.counts).toMatchObject({ total: 0, attended: 1 });
  });
  test("queue.deriveStatus", () => {
    const f = T("queue").deriveStatus;
    expect(f({ tokenstatus: "Cancelled" })).toBe("cancelled");
    expect(f({ tokenstatus: "TRANSFER" })).toBe("transferred");
    expect(f({ tokenstatus: "delivered" })).toBe("attended"); // completed/delivered token = attended (operator vocabulary)
    expect(f({ tokenstatus: "Active", currentstage: "AEL" })).toBe("going");      // starlabs-test: Active token mid-queue
    expect(f({ tokenstatus: "active", currentstage: "yet to start" })).toBe("requested");
    expect(f({ tokenstatus: "active", currentstage: "Requested" })).toBe("requested");
    expect(f({ tokenstatus: "active", currentstage: "S1", liveassignmentid: "x" })).toBe("going");
    expect(f({ tokenstatus: "active", currentstage: "S1" }, { status: "waiting" })).toBe("going");
    expect(f({ tokenstatus: "active", currentstage: "S1" }, { status: "completed" })).toBe("going");
    expect(f({})).toBe("going"); // no status at all = not started yet
  });
  test("queue: token with no history/logs/names", () => {
    const d = locked(T("queue").project({ tokens: [{ id: "t", tokenstatus: "active", currentstage: "X" }] }, { now: NOW }));
    expect(d.items[0]).toMatchObject({ queuename: null, variationname: null, stageHistory: [], activityLog: [], studio: null, enteredAt: null, daysInCurrentStage: null });
  });
  test("events.eventKind heuristics", () => {
    const k = T("events").eventKind;
    expect(k(null)).toBe("live");
    expect(k({ venue: "Zoom" })).toBe("live");
    expect(k({ venue: "Chennai Trade Centre" })).toBe("big");
    expect(k({ eventtype: "BIG" })).toBe("big");
    expect(k({ type: "readiness" })).toBe("live");
  });
  test("events: past event with no attendance info -> attended/unattended decided by end_date; unknown status kept", () => {
    const names = new Map([["event collection/e", { name: "E", end_date: ts("2020-01-02T00:00:00Z") }]]);
    const d = locked(T("events").project({ requests: [{ id: "r", eventref: ref("event collection/e"), status: "waitlisted" }], names }, { now: NOW }));
    expect(d.items[0]).toMatchObject({ status: "waitlisted", status_norm: "waitlisted", attendance: "unattended", isGoing: false, daysUntil: null });
  });
});

describe("communication edge cases", () => {
  test("push FCM arrays as objects, statuses from variants, unknown channel filter", () => {
    const raw = { profileid: "P", push: [{ id: "n", date: ts("2026-01-01T00:00:00Z"), FCMsuccess: [{ profileid: "P" }], FCMfailed: [{ profile_ref: ref("profile_data/P") }] }], wati: [{ id: "w", eventtype: "DELIVERED" }, { id: "w2", failed: true }], email: [{ id: "e", recordtype: "Bounce" }, { id: "e2", status: "Delivery" }] };
    const d = locked(T("communication").project(raw, { now: NOW }));
    expect(d.items.find((i) => i.id === "n")).toMatchObject({ status: "failed", fcmSuccess: 1, fcmFailed: 1 });
    expect(Object.fromEntries(d.items.map((i) => [i.id, i.status]))).toMatchObject({ w: "delivered", w2: "failed", e: "failed", e2: "delivered" });
    expect(T("communication").project(raw, { now: NOW, channel: "fax" }).data.counts.total).toBe(0);
  });
  test("devices masked; empty attachments; no messages at all", () => {
    const d = locked(T("communication").project({ devices: [{ FCM_id: "ab", active: true }, {}] }, { now: NOW }));
    expect(d.summary.devices).toEqual([{ FCM_id: "ab…", device_os: null, active: true, last_modified: null }, { FCM_id: null, device_os: null, active: false, last_modified: null }]);
    expect(d.summary.headline).toMatch(/No communication/);
  });
});

describe("recommendation / content edge cases", () => {
  test("progressMap dedupes by videoid and keeps latest date; list entries as refs/strings/objects", () => {
    const pm = T("recommendation").progressMap([{ videoid: "v", totaltimespend: 10, logdate: ts("2026-01-01T00:00:00Z") }, { videoid: ref("episodes/v"), totaltimespend: "5", logdate: ts("2026-02-01T00:00:00Z") }, { videoname: "noid" }, { totaltimespend: 1 }]);
    expect(pm.get("v")).toEqual({ totaltimespend: 15, lastWatched: "2026-02-01T00:00:00.000Z" });
    expect(pm.get("noid")).toEqual({ totaltimespend: 0, lastWatched: null });
    const d = locked(T("recommendation").project({ playlists: [{ id: "p", list: ["a", { id: "b" }, { ref: ref("episodes/c") }, null] }] }, { now: NOW }));
    expect(d.items[0].videos.map((v) => v.videoid)).toEqual(["a", "b", "c", null]);
    expect(d.items[0].kind).toBe("modeBased"); // personalised undefined -> not personal
  });
  test("content: missing durations -> completionPct null, type filter unknown, since filter", () => {
    const raw = { analytics: [{ videoid: "a", logdate: ts("2026-09-10T00:00:00Z"), totaltimespend: "x" }, { videoid: "b", logdate: ts("2025-01-01T00:00:00Z"), totaltimespend: 5 }] };
    const d = locked(T("content").project(raw, { now: NOW }));
    expect(d.items[0]).toMatchObject({ completionPct: null, totaltimespend: 0, series: null });
    expect(d.summary.last30dPlays).toBe(1);
    expect(T("content").project(raw, { now: NOW, type: "podcast" }).data.counts.total).toBe(0);
    expect(T("content").project(raw, { now: NOW, since: "2026-01-01" }).data.counts.returned).toBe(1);
  });
});

describe("mode / roles edge cases", () => {
  test("mode: productmode as strings, no pmd -> falls back to profile.participantmode, widget forms", () => {
    const d = locked(T("mode").project({ pmd: { productmode: ["m1", { mode: "m2" }, {}] }, profile: { participantmode: "m1" }, widgets: [{ id: "w", mode: "m1", locked: true }, { id: "off", enabled: false }] }, { now: NOW }));
    expect(d.items.map((i) => [i.mode, i.isPrimary])).toEqual([["m1", true], ["m2", false]]);
    expect(d.items[0].widgets.map((w) => w.status)).toEqual(["locked", "hidden"]);
    const e = locked(T("mode").project({ profile: { participantmode: "solo" } }, { now: NOW }));
    expect(e.items).toHaveLength(1);
    expect(e.summary.participantmode).toBe("solo");
  });
  test("mode: exceptions mark projection unhealthy", () => {
    const d = locked(T("mode").project({ pmd: { participantmode: "m", failed: true }, exceptions: [{ id: "x", err: "boom" }] }, { now: NOW }));
    expect(d.summary.projectionHealthy).toBe(false);
    expect(d.counts.exceptions).toBe(1);
  });
  test("roles: no role_ref / roles doc, dashboard with profileid refs and no children", () => {
    const d = locked(T("roles").project({ profile: { id: "P" }, roles: null, dashboard: [{ id: "d", route: "x", profileid: [ref("profile_data/P")] }, { id: "e", route: "y", roles: ["admin"] }, { id: "noroute" }] }, { now: NOW }));
    expect(d.summary).toMatchObject({ primaryRole: null, roles: {}, uid: null, role_ref: null });
    expect(d.items.map((i) => [i.path, i.grantedBy])).toEqual([["/x", "profileid[]"]]);
    expect(d.counts.denied).toBe(1);
    expect(T("roles").flattenDashboard(null)).toEqual([]);
  });
});

describe("forms / videoAsk / evolutionMapping / systemBilling / profileAuthentication edge cases", () => {
  test("forms: draft detection variants and answers shapes", () => {
    const d = locked(T("forms").project({ forms: [{ id: "1", submitted: false, answers: [1, 2] }, { id: "2", isdraft: true }, { id: "3", formstatus: "In Progress" }, { id: "4", answers: "string" }, { id: "5", status: "SUBMITTED", formdata: { a: 1, b: 2, c: 3 } }] }, { now: NOW }));
    expect(Object.fromEntries(d.items.map((i) => [i.docid, i.status]))).toEqual({ 1: "draft", 2: "draft", 3: "draft", 4: "submitted", 5: "submitted" });
    expect(Object.fromEntries(d.items.map((i) => [i.docid, i.answersCount]))).toEqual({ 1: 2, 2: 0, 3: 0, 4: 0, 5: 3 });
  });
  test("videoAsk: kind filter and missing names", () => {
    const d = locked(T("videoAsk").project({ arena: [{ id: "a", eventref: ref("event collection/e") }], participant: [{ id: "p" }] }, { now: NOW, kind: "event" }));
    expect(d.items).toEqual([expect.objectContaining({ id: "a", eventname: null, videoask: null, videourl: null })]);
    expect(d.counts).toMatchObject({ total: 1, events: 1, nonEvents: 1 });
  });
  test("evolutionMapping: level from AEL docs when pmd lacks it; mapping referencing an unknown video", () => {
    const d = locked(T("evolutionMapping").project({ pmd: {}, mappings: [{ id: "m", videolist: [ref("evolutionmappingvideo/ghost")] }], levels: [{ id: "1", name: "Aware" }, { level: "2" }, { name: "no level" }], ael: [{ ael: 2 }] }, { now: NOW }));
    expect(d.summary).toMatchObject({ currentael: 2, currentLevelName: null, completedael: [2] });
    expect(d.items[0].videos[0]).toMatchObject({ id: "ghost", title: null, order: 1 });
    expect(d.items.filter((i) => i.kind === "ael").map((l) => [l.level, l.achieved])).toEqual([[1, true], [2, true]]);
  });
  test("systemBilling: no rows -> headline, zero counts", () => {
    const d = locked(T("systemBilling").project({ participant: { id: "W" }, purchases: [], payments: [], schedule: [] }, { now: NOW }));
    expect(d.summary.headline).toMatch(/No billing ledger/);
    expect(d.counts).toEqual({ total: 0, returned: 0, paid: 0, upcoming: 0, overdue: 0, failed: 0 });
  });
  test("profileAuthentication: no auth record, no registration, garbage metadata", () => {
    const d = locked(T("profileAuthentication").project({ profile: { id: "P", email: "e" }, auth: { uid: "u", providerData: null, metadata: null } }, { now: NOW }));
    expect(d.summary).toMatchObject({ uid: "u", providers: [], createdAt: null, registrationStatus: null, activeDevices: 0 });
    const e = locked(T("profileAuthentication").project({ profile: null }, { now: NOW }));
    expect(e.summary.headline).toMatch(/No profile on record/);
  });
});
