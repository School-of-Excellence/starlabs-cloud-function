/* global describe, test, expect, jest */
/**
 * Pure-projection tests: every tool's project() is fed synthetic Firestore-shaped docs and must
 * return the locked envelope { ok, version, generatedAt, data: { summary, counts, items } } with
 * summary.headline (string), counts.total/returned (int) and counts.returned == items.length.
 * No Firestore is touched.
 */
// All Firebase packages are replaced by in-memory mocks — nothing here touches a real project.
const { installFirebaseMocks } = require("./helpers/fake-firestore");
installFirebaseMocks();
const path = require("path");
const NOW = new Date("2026-09-17T10:00:00.000Z");
const ts = (iso) => ({ toDate: () => new Date(iso) });
const ref = (p) => ({ path: p, id: p.split("/").pop() });
const PID = "P7Kq2mX9aLd3";
const T = (n) => require(path.join("../../../components/participant360/tools", n));

function expectLocked(r) {
  expect(r.ok).toBe(true);
  expect(Object.keys(r)).toEqual(["ok", "version", "generatedAt", "data"]);
  expect(Object.keys(r.data)).toEqual(["summary", "counts", "items"]);
  expect(typeof r.data.summary.headline).toBe("string");
  expect(r.data.summary.headline.length).toBeGreaterThan(0);
  expect(Number.isInteger(r.data.counts.total)).toBe(true);
  expect(r.data.counts.returned).toBe(r.data.items.length);
  return r.data;
}

describe("purchase.project", () => {
  const names = new Map([
    ["journey/uP_2026", { journey: "uP! Journey 2026" }], ["journey/BT_2025", { journey: "Breakthroughs 2025" }],
    ["products/up_kickoff", { name: "Kick-off Session" }], ["products/up_triple_atc", { name: "Triple ATC" }], ["products/ghost", { name: "Ghost" }],
    ["package/up_gold", { name: "uP! Gold" }],
  ]);
  const raw = {
    pmd: { customerstatus: "active", lastcompletedjourney: "Breakthroughs 2025", addons: ["up_triple_atc"], atcsummary: "MUST NOT LEAK", currentjourney: "dead" },
    pjps: [
      { id: "pjp_1", journeyref: ref("journey/uP_2026"), journeystatus: "ongoing", onboarded: true, subscriptionstart: ts("2026-03-02T00:00:00Z"), subscriptionend: ts("2027-03-01T23:59:59Z"),
        participantproducts: [{ participantproductid: "pp_a1", productref: ref("products/up_kickoff") }, { participantproductid: "pp_a2", productref: ref("products/up_triple_atc") }, { participantproductid: "pp_missing", productref: ref("products/ghost") }] },
      { id: "pjp_0", journeyref: ref("journey/BT_2025"), journeystatus: "completed", subscriptionstart: ts("2025-01-15T00:00:00Z"), subscriptionend: ts("2026-01-14T23:59:59Z"), participantproducts: [] },
    ],
    psps: [
      { id: "pp_a1", productref: ref("products/up_kickoff"), packageref: ref("package/up_gold"), status: "completed", sequenceorder: 1, deliverymode: "appointment", statusdate: ts("2026-03-08T11:00:00Z") },
      { id: "pp_a2", productref: ref("products/up_triple_atc"), packageref: ref("package/up_gold"), status: "ongoing", sequenceorder: 2, deliverymode: "queue", statusdate: { ongoing: ts("2026-06-20T08:45:00Z") } },
      { id: "pp_unlinked", productref: ref("products/up_kickoff"), status: null, sequenceorder: 9 },
    ],
    names,
  };
  test("active journey first, statuses from CF vocabulary, drift surfaced, ATC keys stripped", () => {
    const d = expectLocked(T("purchase").project(raw, { now: NOW }));
    expect(d.items[0].participantjourneyproductid).toBe("pjp_1");
    expect(d.items[0].isActive).toBe(true);
    expect(d.items[0].journeystatus).toBe("ongoing");
    expect(d.items[0].package.packagename).toBe("uP! Gold");
    expect(d.items[0].products.map((p) => p.status)).toEqual(["completed", "ongoing", "missing_enrollment"]);
    expect(d.items[0].products[1].kind).toBe("addon");
    expect(d.items[0].products[1].statusdate).toEqual({ ongoing: "2026-06-20T08:45:00.000Z" });
    expect(d.items[1].subscriptionStatus).toBe("expired");
    expect(d.summary.activeJourneyName).toBe("uP! Journey 2026");
    expect(d.summary.daysRemaining).toBe(166);
    expect(d.counts).toMatchObject({ total: 2, ongoing: 1, completed: 1, expired: 1, unlinkedProducts: 1, missingEnrollments: 1, addons: 1 });
    expect(JSON.stringify(d)).not.toMatch(/MUST NOT LEAK|dead/);
    expect(d.summary.headline).toMatch(/Active journey uP! Journey 2026 \(ongoing/);
  });
  test("limit and empty", () => {
    expect(T("purchase").project(raw, { now: NOW, limit: 1 }).data.counts).toMatchObject({ total: 2, returned: 1 });
    expect(T("purchase").project({ pjps: [], psps: [] }, { now: NOW }).data.summary.headline).toMatch(/No journey purchase/);
  });
});

describe("finance.project", () => {
  const raw = {
    participant: { id: "WPT-1", customerstatus: "active", pp_status: "ongoing", pp_frequency: "monthly", pp_installmentamount: 12500, pp_installmentspaid: 6, pp_installmentsdue: 6, pp_totalpurchasevalue: 150000, pp_totalpaid: 75000, pp_balance: 75000, nachrecieved: true, paymentcommitment: "NACH", billingname: "Asha" },
    purchases: [{ id: "WP-1", purchasedate: ts("2026-03-02T00:00:00Z"), purchaselabel: "uP! Gold 2026", journeytype: "uP", totalPurchaseValue: 150000, installmentstartdate: ts("2026-04-05T00:00:00Z") }],
    payments: [{ id: "PAY-1", paymentdate: ts("2026-09-05T00:00:00Z"), amount: 12500, paymentmode: "NACH", status: "success", purchaseid: "WP-1" }, { id: "PAY-0", paymentdate: ts("2026-03-02T00:00:00Z"), amount: 25000, mode: "UPI" }],
    schedule: [{ date: ts("2026-10-05T00:00:00Z"), amount: 12500, status: "pending", purchaseid: "WP-1" }, { date: ts("2026-08-05T00:00:00Z"), amount: 12500, status: "pending", purchaseid: "WP-1" }, { date: ts("2026-09-05T00:00:00Z"), amount: 12500, status: "paid" }],
  };
  test("EMI plan from pp_* fields, payments and schedule nested inside the purchase", () => {
    const d = expectLocked(T("finance").project(raw, { now: NOW }));
    expect(d.summary).toMatchObject({ watsonparticipantid: "WPT-1", totalPurchaseValue: 150000, totalPaid: 75000, balance: 75000, emiStatus: "ongoing", installmentsPaid: 6, nachReceived: true, nextDueDate: "2026-10-05T00:00:00.000Z", daysUntilNextDue: 18 });
    expect(d.items[0].payments.length).toBe(2);
    expect(d.items[0].schedule.map((s) => s.status)).toEqual(["overdue", "paid", "upcoming"]);
    expect(d.counts).toMatchObject({ total: 1, payments: 2, paymentsSuccess: 2, scheduleUpcoming: 1, scheduleOverdue: 1, schedulePaid: 1 });
    expect(d.summary.headline).toMatch(/EMI ongoing/);
  });
});

describe("activeProduct.project", () => {
  const raw = {
    pmd: { unconsumedproducts: ["up_live_event"] },
    psps: [
      { id: "pp_a1", productref: ref("products/up_kickoff"), status: "completed", sequenceorder: 1, deliverymode: "appointment", statusdate: ts("2026-03-08T11:00:00Z") },
      { id: "pp_a2", productref: ref("products/up_triple_atc"), status: "ongoing", sequenceorder: 2, deliverymode: "queue" },
      { id: "pp_a3", productref: ref("products/up_live_event"), status: null, sequenceorder: 3, deliverymode: "event" },
    ],
    names: new Map([["products/up_triple_atc", { name: "Triple ATC" }]]),
    sequence: { products: [{ participantproductid: "pp_a2", sequenceref: ref("productToDeliverySequence/seq_triple"), sequence: [{ status: "completed" }, { status: "completed" }, { status: "pending" }, {}] }] },
    deliverables: [{ id: "dl_1", participantproductid: "pp_a2", type: "form", status: "submitted", deliveryref: ref("delivery forms/df") }, { id: "dl_0", participantproductid: "pp_a1", type: "appointment", status: "completed" }],
  };
  test("current product first with step position and next action", () => {
    const d = expectLocked(T("activeProduct").project(raw, { now: NOW }));
    expect(d.items[0]).toMatchObject({ participantproductid: "pp_a2", isCurrent: true, status: "ongoing", delivery: { currentStep: 2, totalSteps: 4, progressPct: 50 } });
    expect(d.items[0].deliverables.length).toBe(1);
    expect(d.items.find((p) => p.participantproductid === "pp_a3")).toMatchObject({ status: "not_started", isUnconsumed: true });
    expect(d.summary).toMatchObject({ currentProductName: "Triple ATC", nextAction: "in queue", currentStep: 2, totalSteps: 4 });
    expect(d.counts).toMatchObject({ total: 3, completed: 1, ongoing: 1, not_started: 1, unconsumed: 1, deliverables: 2, deliverablesCompleted: 1 });
  });
});

describe("forms.project", () => {
  const raw = {
    forms: [
      { id: "fb_1", formname: "Intake", status: "submitted", submittedon: ts("2026-03-20T07:44:10Z"), answers: { a: 1, b: 2 }, fileref: [ref("x/y")] },
      { id: "fb_2", formName: "Reflection", status: "draft", updated: ts("2026-09-14T18:20:05Z"), answers: [1, 2, 3] },
    ],
    quizzes: [{ id: "qz_1", title: "EI Basics", score: 8, maxscore: 10, date: ts("2026-04-11T09:30:00Z") }],
  };
  test("submitted vs draft, quizzes as kind", () => {
    const d = expectLocked(T("forms").project(raw, { now: NOW }));
    expect(d.items.map((i) => [i.kind, i.status])).toEqual([["form", "draft"], ["quiz", "submitted"], ["form", "submitted"]]); // newest lastSavedAt first
    expect(d.counts).toMatchObject({ total: 3, submitted: 2, drafts: 1, quizzes: 1, withAttachments: 1 });
    expect(d.summary.lastDraftForm).toBe("Reflection");
    expect(T("forms").project(raw, { now: NOW, status: "draft" }).data.counts).toMatchObject({ total: 1, returned: 1 });
  });
});

describe("appointment.project", () => {
  const names = new Map([["appointmenttype/at_k", { name: "Kick-off" }], ["products/p", { name: "Prod" }], ["profile_data/EIS_1", { name: "Ravi" }]]);
  const raw = {
    appointments: [
      { id: "ap_up", appointment: ref("appointmenttype/at_k"), productid: ref("products/p"), starttime: ts("2026-09-22T09:00:00Z"), endtime: ts("2026-09-22T09:45:00Z"), hosts: [ref("profile_data/EIS_1")], attended: false, cancelled: false, zoomdata: { id: "zm1" } },
      { id: "ap_att", appointment: ref("appointmenttype/at_k"), starttime: ts("2026-03-08T10:00:00Z"), endtime: ts("2026-03-08T11:00:00Z"), hosts: ["EIS_1"], attended: true, cancelled: false },
      { id: "ap_can", starttime: ts("2026-03-06T10:00:00Z"), attended: false, cancelled: true },
      { id: "ap_miss", starttime: ts("2026-05-06T10:00:00Z"), attended: false, cancelled: false },
    ],
    names, rooms: new Map(),
  };
  test("derived status and next/last summary", () => {
    const d = expectLocked(T("appointment").project(raw, { now: NOW }));
    expect(Object.fromEntries(d.items.map((i) => [i.appointmentid, i.status]))).toEqual({ ap_up: "upcoming", ap_att: "attended", ap_can: "cancelled", ap_miss: "missed" });
    expect(d.items[0]).toMatchObject({ appointmenttype: "Kick-off", productname: "Prod", durationMin: 45, hosts: [{ profileid: "EIS_1", name: "Ravi" }], video: { provider: "zoom", roomid: "zm1" } });
    expect(d.summary).toMatchObject({ nextAppointmentId: "ap_up", nextHost: "Ravi", lastAttendedType: "Kick-off", attendanceRatePct: 50 });
    expect(d.counts).toMatchObject({ total: 4, attended: 1, cancelled: 1, upcoming: 1, missed: 1 });
  });
});

describe("queue.project", () => {
  const raw = {
    tokens: [
      { id: "qt_1", queueref: ref("queue generation/qg_up"), variationid: "qv_1", tokenstatus: "active", currentstage: "Session 2", previousstage: "Session 1", liveassignmentid: "la_1", studioid: "st_4" },
      { id: "qt_0", queueref: ref("queue generation/qg_bt"), tokenstatus: "completed", currentstage: "Delivered" },
    ],
    stageLogs: [
      { logdocid: "qt_1", createdon: ts("2026-04-02T05:00:00Z"), currentstage: "Requested" }, { logdocid: "qt_1", createdon: ts("2026-06-20T08:45:00Z"), previousstage: "Session 1", currentstage: "Session 2", manuallymoved: true },
      { logdocid: "qt_0", createdon: ts("2025-06-30T10:00:00Z"), currentstage: "Delivered" },
    ],
    activities: [{ queueid: "qg_up", activitydate: ts("2026-04-15T09:10:00Z"), activity: "Session 1 attended", atcmodel: "triple" }],
    names: new Map([["queue generation/qg_up", { queuename: "uP! Queue" }], ["queue variation/qv_1", { variationname: "uP! × C3" }]]),
    liveAssignments: new Map([["la_1", { status: "waiting", stagename: "Session 2", stagetype: "activity", pairing: ["P1", "P2"], atcdata: "NO" }]]),
    planners: [{ queueid: "qg_up", selectedslots: ["2026-09-28T09:00"] }],
  };
  test("active token first, history ordered, studio projected without ATC", () => {
    const d = expectLocked(T("queue").project(raw, { now: NOW }));
    expect(d.items[0]).toMatchObject({ tokenid: "qt_1", status: "going", queuename: "uP! Queue", variationname: "uP! × C3", isActive: true, daysInCurrentStage: 89, studio: { status: "waiting", pairing: ["P1", "P2"] } });
    expect(d.items[0].stageHistory.map((h) => h.currentstage)).toEqual(["Requested", "Session 2"]);
    expect(d.items[0].plannerSlots).toEqual([{ queueid: "qg_up", slot: "2026-09-28T09:00" }]);
    expect(d.items[1].status).toBe("attended"); // completed token
    expect(JSON.stringify(d)).not.toMatch(/atcdata/);
    expect(d.counts).toMatchObject({ total: 2, going: 1, attended: 1, completed: 0, stageMoves: 3, activities: 1, plannerSlots: 1 });
    expect(d.summary.nextPlannerSlot).toBe("2026-09-28T09:00");
  });
});

describe("events.project", () => {
  const names = new Map([
    ["event collection/ev_big", { name: "uP! Live Dec", venue: "Chennai Trade Centre", start_date: ts("2026-12-12T03:30:00Z"), end_date: ts("2026-12-14T12:30:00Z") }],
    ["event collection/ev_live", { name: "Readiness Call", venue: "Zoom", start_date: ts("2026-09-20T13:30:00Z"), end_date: ts("2026-09-20T15:00:00Z") }],
    ["event collection/ev_past", { name: "BT Live 2025", venue: "Bengaluru", start_date: ts("2025-03-21T03:30:00Z"), end_date: ts("2025-03-23T12:30:00Z") }],
  ]);
  const raw = {
    pmd: { productevent: { eventid: "ev_big", activityname: "approved", activitydate: ts("2026-08-01T06:00:00Z") } },
    requests: [
      { id: "r1", eventref: ref("event collection/ev_big"), status: "approved", doccreateddate: ts("2026-08-01T06:00:00Z") },
      { id: "r2", eventref: ref("event collection/ev_live"), status: "requested" },
      { id: "r3", eventref: ref("event collection/ev_past"), status: "approved", attended: true },
    ],
    names, eticket: [{ eventref: ref("event collection/ev_big"), eligible: true }], invitations: [{ eventref: ref("event collection/ev_big"), status: "accepted", expirydate: ts("2026-09-30T00:00:00Z") }], arenas: [], zones: [{ eventref: ref("event collection/ev_big"), zonename: "Zone B", cohorts: ["c17"] }],
  };
  test("kind, normalised status, attendance, nested eticket/zone/invitation", () => {
    const d = expectLocked(T("events").project(raw, { now: NOW }));
    const big = d.items.find((i) => i.requestid === "r1");
    expect(big).toMatchObject({ eventKind: "big", status_norm: "approved", attendance: "pending", isGoing: true, eticket: { eligible: true, issued: false }, zone: { zonename: "Zone B" }, invitation: { status: "accepted" } });
    expect(d.items.find((i) => i.requestid === "r2")).toMatchObject({ eventKind: "live", status_norm: "requested", daysUntil: 4 });
    expect(d.items.find((i) => i.requestid === "r3")).toMatchObject({ attendance: "attended", daysUntil: null });
    expect(d.summary).toMatchObject({ nextEventName: "Readiness Call", nextBigEventName: "uP! Live Dec", nextBigEticketEligible: true, lastAttendedEventName: "BT Live 2025" });
    expect(d.counts).toMatchObject({ total: 3, live: 1, big: 2, requested: 1, approved: 2, going: 1, attended: 1, pending: 2, invitations: 1 });
    expect(T("events").project(raw, { now: NOW, kind: "big" }).data.counts.total).toBe(2);
  });
});

describe("communication.project", () => {
  const raw = {
    profileid: PID,
    wati: [{ id: "w1", templateName: "reminder", created: ts("2026-09-15T04:00:00Z"), status: "READ" }],
    email: [{ id: "e1", subject: "Welcome", date: ts("2026-03-02T10:35:00Z"), opened: true, attachments: ["a.pdf"] }],
    push: [{ id: "n1", title: "Hi", date: ts("2026-09-10T08:00:00Z"), success: true, FCMfailed: [PID] }, { id: "n2", title: "Yo", date: ts("2026-09-05T08:00:00Z"), success: true }],
    inApp: [{ id: "i1", title: "Draft waiting", date: ts("2026-09-14T18:30:00Z"), seen: false, sticky: true }],
    devices: [{ FCM_id: "fcm_abcdefgh123", device_os: "android", active: true, last_modified: ts("2026-09-15T20:11:00Z") }, { FCM_id: "x", active: false }],
  };
  test("all channels in one list with kind and status", () => {
    const d = expectLocked(T("communication").project(raw, { now: NOW }));
    expect(d.items.map((i) => [i.kind, i.status])).toEqual([["whatsapp", "read"], ["inApp", "unseen"], ["push", "failed"], ["push", "sent"], ["email", "opened"]]);
    expect(d.summary).toMatchObject({ lastChannel: "whatsapp", activeDevices: 1, lastFailedAt: "2026-09-10T08:00:00.000Z" });
    expect(d.summary.devices[0].FCM_id).toBe("fcm_abcd…");
    expect(d.counts).toMatchObject({ total: 5, whatsapp: 1, email: 1, push: 2, inApp: 1, read: 1, opened: 1, failed: 1, unseen: 1, sent: 4 });
    expect(T("communication").project(raw, { now: NOW, channel: "push" }).data.counts.total).toBe(2);
  });
});

describe("recommendation.project", () => {
  const raw = {
    playlists: [
      { id: "rmp_1", title: "Your Mix", type: "mix", personalised: true, date: ts("2026-09-08T00:00:00Z"), list: [{ id: "ep_301", title: "Owning" }, { id: "ep_318" }, "sv_44"] },
      { id: "rmp_m", title: "Mode 2", type: "mode", personalised: false, mode: "up_mode_2", date: ts("2026-06-20T00:00:00Z"), list: [{ id: "ep_210" }] },
    ],
    analytics: [{ videoid: "ep_301", totaltimespend: 612, logdate: ts("2026-09-14T17:02:00Z") }, { videoid: "ep_318", totaltimespend: 140, logdate: ts("2026-09-15T21:10:00Z") }, { videoid: "ep_210", totaltimespend: 900, logdate: ts("2026-06-18T10:00:00Z") }],
    episodes: new Map([["episodes/ep_301", { title: "Owning the Outcome", duration: 640 }], ["episodes/ep_318", { duration: 900 }], ["episodes/ep_210", { duration: 900 }]]),
    procedureRecs: [{ id: "pr1", procedureref: ref("procedures/proc_s2"), date: ts("2026-06-20T09:00:00Z") }],
    procedures: new Map([["procedures/proc_s2", { name: "Session 2 reflection" }]]),
  };
  test("personal vs mode-based with per-video progress", () => {
    const d = expectLocked(T("recommendation").project(raw, { now: NOW }));
    const personal = d.items.find((i) => i.kind === "personal");
    expect(personal.videos.map((v) => v.status)).toEqual(["completed", "inProgress", "notStarted"]);
    expect(personal.progressPct).toBe(33);
    expect(d.items.find((i) => i.kind === "modeBased")).toMatchObject({ mode: "up_mode_2", progressPct: 100 });
    expect(d.items.find((i) => i.kind === "procedure")).toMatchObject({ procedureid: "proc_s2", title: "Session 2 reflection" });
    expect(d.summary).toMatchObject({ latestPlaylistTitle: "Your Mix", overallProgressPct: 50, lastWatchedVideoid: "ep_318" });
    expect(d.counts).toMatchObject({ total: 3, personal: 1, modeBased: 1, procedures: 1, videos: 4, videosCompleted: 2, videosInProgress: 1, videosNotStarted: 1 });
  });
});

describe("content.project", () => {
  const raw = {
    analytics: [
      { videoid: "ep_318", videoname: "Energy Audit", type: "eiflixcontent", playlistid: "rmp_1", totaltimespend: 140, logdate: ts("2026-09-15T21:10:00Z") },
      { videoid: "sv_12", videoname: "Gratitude", type: "solarvoice", totaltimespend: 480, logdate: ts("2026-09-13T06:30:00Z") },
      { videoid: "ep_1", videoname: "Old", type: "eiflixcontent", totaltimespend: 100, logdate: ts("2026-01-01T06:30:00Z") },
    ],
    episodes: new Map([["episodes/ep_318", { duration: 900, series: ["EI"] }]]),
    workshops: [{ id: "ws1", name: "EI Masterclass", status: "enrolled", created: ts("2026-07-14T00:00:00Z") }],
  };
  test("currently consuming, 30-day window, workshops as kind", () => {
    const d = expectLocked(T("content").project(raw, { now: NOW }));
    expect(d.items[0]).toMatchObject({ kind: "activity", videoid: "ep_318", completionPct: 16, series: "EI" });
    expect(d.items.at(-1)).toMatchObject({ kind: "workshop", name: "EI Masterclass" });
    expect(d.summary).toMatchObject({ currentVideoname: "Energy Audit", totalPlays: 3, last30dPlays: 2, last30dSeconds: 620, last30dActiveDays: 2 });
    expect(d.counts).toMatchObject({ total: 4, eiflixcontent: 2, solarvoice: 1, other: 0, workshops: 1 });
    expect(T("content").project(raw, { now: NOW, type: "solarvoice" }).data.counts.total).toBe(1);
  });
});

describe("mode.project", () => {
  const raw = {
    pmd: { participantmode: "up_mode_2", productmode: [{ productref: ref("products/up_triple_atc"), mode: "up_mode_2" }, { productref: ref("products/eiflix"), mode: "content_active" }], updatedAt: ts("2026-09-15T21:11:04Z"), atcsummary: "NO" },
    profile: { participantmode: "up_mode_2" },
    modes: new Map([["up_mode_2", { label: "In Sessions" }]]),
    widgets: [{ id: "w_next", name: "Next Session", modes: ["up_mode_2"] }, { id: "w_book", name: "Book", modes: ["up_mode_1"] }, { id: "w_all", name: "Always" }, { id: "w_off", name: "Off", active: false }],
    exceptions: [],
  };
  test("widgets per mode with reason", () => {
    const d = expectLocked(T("mode").project(raw, { now: NOW }));
    expect(d.items[0]).toMatchObject({ mode: "up_mode_2", modeLabel: "In Sessions", isPrimary: true, counts: { widgets: 4, visible: 2, hidden: 2, locked: 0 } });
    expect(d.items[0].widgets.find((w) => w.widgetid === "w_book")).toMatchObject({ status: "hidden", reason: expect.stringMatching(/not in widget modes/) });
    expect(d.summary).toMatchObject({ participantmode: "up_mode_2", participantmodeLabel: "In Sessions", projectionHealthy: true, lastRebuilt: "2026-09-15T21:11:04.000Z" });
    expect(d.counts).toMatchObject({ total: 2, widgets: 8, widgetsVisible: 3, widgetsHidden: 5 });
    expect(JSON.stringify(d)).not.toMatch(/atcsummary/);
  });
});

describe("roles.project", () => {
  const raw = {
    profile: { id: PID, profileid: PID, role_ref: ref("users_roles/ur_1"), user_ref: ref("user_data/uid1") },
    roles: { participant: true, big_participant: true, admin: false, id: "ur_1" },
    eisrole: null,
    dashboard: [
      { id: "big", route: "big-dashboard", roles: ["big_participant", "admin"], label: "BIG" },
      { id: "ops", children: [{ route: "/dynamicqueuemanager", roles: ["operator", "admin"], label: "Queue" }, { route: "/special", roles: [], profileid: [PID], label: "Special" }, { route: "/open", label: "Open" }] },
    ],
  };
  test("allowed screens from roles[] / profileid[] / unrestricted; denied only when asked", () => {
    const d = expectLocked(T("roles").project(raw, { now: NOW }));
    expect(d.items.map((i) => [i.path, i.grantedBy])).toEqual([["/big-dashboard", "roles[]"], ["/open", "unrestricted"], ["/special", "profileid[]"]]);
    expect(d.summary).toMatchObject({ uid: "uid1", primaryRole: "big_participant", screensAllowed: 3, screensTotal: 4, roles: { participant: true, big_participant: true, admin: false } });
    expect(d.counts).toMatchObject({ total: 3, allowed: 3, denied: 1, rolesGranted: 2, dashboardNodes: 2 });
    const all = T("roles").project(raw, { now: NOW, includeDenied: "true" }).data;
    expect(all.counts.total).toBe(4);
    expect(all.items.at(-1)).toMatchObject({ path: "/dynamicqueuemanager", allowed: false });
  });
});

describe("videoAsk.project", () => {
  const raw = {
    arena: [{ id: "av1", videoaskid: "va_day3", title: "Day 3", eventref: ref("event collection/ev"), submittedon: ts("2025-03-23T11:40:00Z"), transcript: "..." }],
    participant: [{ id: "pv1", videoaskid: "va_s1", videoask: "Session 1 reflection", productref: ref("products/p"), date: ts("2026-04-16T07:00:00Z"), videourl: "https://v/1" }],
    names: new Map([["event collection/ev", { name: "BT Live" }], ["products/p", { name: "Triple ATC" }]]),
  };
  test("event vs nonEvent", () => {
    const d = expectLocked(T("videoAsk").project(raw, { now: NOW }));
    expect(d.items.map((i) => i.kind)).toEqual(["nonEvent", "event"]);
    expect(d.items[0]).toMatchObject({ videoask: "Session 1 reflection", productname: "Triple ATC", videourl: "https://v/1" });
    expect(d.items[1]).toMatchObject({ eventname: "BT Live", transcript: "..." });
    expect(d.counts).toMatchObject({ total: 2, events: 1, nonEvents: 1, withTranscript: 1 });
    expect(d.summary.lastEventName).toBe("BT Live");
  });
});

describe("evolutionMapping.project", () => {
  const raw = {
    pmd: { currentael: 2, completedael: [1, 2], crossovermetric: 0.62, extendedlifeimpact: 3 },
    mappings: [{ id: "lem_4", title: "Map 2026", live: true, created: ts("2026-04-20T00:00:00Z"), videolist: ["emv_101", "emv_102"] }],
    videos: [{ id: "emv_101", title: "Start", videourl: "u1", created: ts("2026-04-20T00:00:00Z"), deleted: false }, { id: "emv_102", title: "Shift", videourl: "u2", created: ts("2026-04-30T00:00:00Z"), deleted: false }, { id: "emv_x", deleted: true }],
    levels: [{ id: "3", level: 3, name: "Accelerated" }, { id: "1", level: 1, name: "Aware" }, { id: "2", level: 2, name: "Aligned" }],
    ael: [{ level: 1, date: ts("2026-04-16T00:00:00Z"), source: "Session 1" }, { level: 2, date: ts("2026-06-21T00:00:00Z") }],
    wishlist: [{ id: "w1", question: "By December?", answer: "Lead", date: ts("2026-04-20T00:00:00Z") }],
  };
  test("mapping with nested videos, AEL ladder, wishlist", () => {
    const d = expectLocked(T("evolutionMapping").project(raw, { now: NOW }));
    expect(d.items[0]).toMatchObject({ kind: "mapping", title: "Map 2026", counts: { videos: 2 } });
    expect(d.items[0].videos.map((v) => v.title)).toEqual(["Start", "Shift"]);
    expect(d.items.filter((i) => i.kind === "ael").map((l) => [l.level, l.achieved, l.isCurrent])).toEqual([[1, true, false], [2, true, true], [3, false, false]]);
    expect(d.summary).toMatchObject({ currentael: 2, currentLevelName: "Aligned", crossovermetric: 0.62, liveMappingTitle: "Map 2026" });
    expect(d.counts).toMatchObject({ total: 5, mappings: 1, videos: 2, videosDeleted: 1, aelLevels: 3, aelAchieved: 2, wishlist: 1 });
  });
});

describe("systemBilling.project", () => {
  const raw = {
    participant: { id: "WPT-1", pp_totalpurchasevalue: 150000, pp_totalpaid: 37500, pp_balance: 112500, paymentcommitment: "NACH" },
    purchases: [{ id: "WP-1", purchasedate: ts("2026-03-02T00:00:00Z"), purchaselabel: "uP! Gold", totalPurchaseValue: 150000 }],
    payments: [{ id: "PAY-1", paymentdate: ts("2026-09-05T00:00:00Z"), amount: 12500, mode: "NACH", status: "success", installmentno: 6 }, { id: "PAY-0", paymentdate: ts("2026-03-02T00:00:00Z"), amount: 25000, mode: "UPI", status: "success" }],
    schedule: [{ date: ts("2026-10-05T00:00:00Z"), amount: 12500, installmentno: 7, status: "pending" }, { date: ts("2026-08-05T00:00:00Z"), amount: 12500, installmentno: 5, status: "pending" }],
  };
  test("one ledger: paid + upcoming + overdue, next due", () => {
    const d = expectLocked(T("systemBilling").project(raw, { now: NOW }));
    expect(d.items.map((i) => i.status)).toEqual(["upcoming", "paid", "overdue", "paid"]);
    expect(d.summary).toMatchObject({ totalPaid: 37500, balance: 112500, nextDueAmount: 12500, daysUntilNextDue: 18, overdueAmount: 12500, paymentMode: "NACH", variant: "a:participant-ledger" });
    expect(d.counts).toMatchObject({ total: 4, paid: 2, upcoming: 1, overdue: 1, failed: 0 });
    expect(d.summary.headline).toMatch(/OVERDUE/);
  });
});

describe("profileAuthentication.project", () => {
  const raw = {
    profile: { id: PID, profileid: PID, name: "Asha Menon", email: "asha@example.com", created: ts("2025-01-15T09:02:30Z"), user_ref: ref("user_data/uid1"), participantmode: "up_mode_2", testuser: false, currentjourney: "dead" },
    auth: { uid: "uid1", email: "asha@example.com", emailVerified: true, providerData: [{ providerId: "password" }, { providerId: "google.com" }], disabled: false, metadata: { creationTime: "Wed, 15 Jan 2025 09:02:11 GMT", lastSignInTime: "Tue, 15 Sep 2026 20:10:48 GMT" } },
    registration: { status: "completed", subscriber: true },
    otps: [{ created: ts("2026-09-15T20:09:50Z"), verified: true }],
    timeline: [{ date: ts("2026-06-21T00:00:10Z"), activityname: "participantmode", before: "up_mode_1", after: "up_mode_2", source: "cf" }],
    audit: [],
    devices: [{ FCM_id: "fcm_abcdefgh", device_os: "android", active: true, last_modified: ts("2026-09-15T20:11:00Z") }],
  };
  test("auth record + profile + mixed history items", () => {
    const d = expectLocked(T("profileAuthentication").project(raw, { now: NOW }));
    expect(d.summary).toMatchObject({ uid: "uid1", emailVerified: true, providers: ["password", "google.com"], lastSignInAt: "2026-09-15T20:10:48.000Z", registrationStatus: "completed", participantmode: "up_mode_2", activeDevices: 1 });
    expect(d.items.map((i) => i.kind)).toEqual(["device", "otp", "history", "history"]); // newest first
    expect(d.items.find((i) => i.field === "participantmode")).toMatchObject({ from: "up_mode_1", to: "up_mode_2" });
    expect(d.counts).toMatchObject({ total: 4, history: 2, otp: 1, otpVerified: 1, devices: 1, devicesActive: 1, providers: 2 });
    expect(JSON.stringify(d)).not.toMatch(/dead/);
  });
});
