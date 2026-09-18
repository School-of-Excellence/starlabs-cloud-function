/* global describe, test, expect, jest, beforeEach */
/**
 * load() of every tool against an in-memory Firestore seeded with one "golden" participant.
 * This exercises the real query code (field names, string-vs-ref matching, named DB, subcollection,
 * getAll path strings, .catch fallbacks) with no Firebase package loaded.
 */
const { makeFirestore, installFirebaseMocks, requireFresh, ts } = require("./helpers/fake-firestore");

const PID = "P1", UID = "uid1", NOW = new Date("2026-09-17T10:00:00.000Z");
const ref = (p) => ({ path: p, id: p.split("/").pop() });
const WATSON_SA = JSON.stringify({ project_id: "starlabs-cicd", client_email: "x@y", private_key: "k" });

function goldenSeed() {
  return {
    default: {
      profile_data: { [PID]: { profileid: PID, email: "asha@example.com", name: "Asha", phonenumber: "+919876543210", created: ts("2025-01-15T09:02:30Z"), user_ref: ref(`user_data/${UID}`), role_ref: ref("users_roles/ur1"), participantmode: "up_mode_2", currentjourney: "DEAD" }, EIS1: { profileid: "EIS1", name: "Ravi" } },
      user_data: { [UID]: { email: "asha@example.com" } },
      users_roles: { ur1: { participant: true, big_participant: true, admin: false } },
      new_user_data: { n1: { profileid: PID, uid: UID, status: "completed", subscriber: true } },
      "participant metadata": { [PID]: { profileid: PID, customerstatus: "active", participantmode: "up_mode_2", productmode: [{ productref: ref("products/tatc"), mode: "up_mode_2" }], addons: ["eiflix"], unconsumedproducts: ["live"], currentael: 2, completedael: [1, 2], updatedAt: ts("2026-09-15T21:11:04Z"), atcsummary: "NO", productevent: { eventid: "evBig", activityname: "approved", activitydate: ts("2026-08-01T06:00:00Z") } } },
      participantjourneyproduct: { pjp1: { profileid: PID, journeyref: ref("journey/uP"), journeystatus: "ongoing", onboarded: true, subscriptionstart: ts("2026-03-02T00:00:00Z"), subscriptionend: ts("2027-03-01T23:59:59Z"), participantproducts: [{ participantproductid: "pp1", productref: ref("products/kick") }, { participantproductid: "pp2", productref: ref("products/tatc") }] } },
      participantsproduct: {
        pp1: { profileid: PID, productref: ref("products/kick"), packageref: ref("package/gold"), status: "completed", sequenceorder: 1, deliverymode: "appointment" },
        pp2: { profileid: PID, productref: ref("products/tatc"), packageref: ref("package/gold"), status: "ongoing", sequenceorder: 2, deliverymode: "queue" },
        ppOther: { profileid: "SOMEONE_ELSE", productref: ref("products/kick"), status: "ongoing" },
      },
      journey: { uP: { journey: "uP! Journey 2026" } }, products: { kick: { name: "Kick-off" }, tatc: { name: "Triple ATC" }, live: { name: "Live Event" }, eiflix: { name: "EiFlix" } }, package: { gold: { name: "uP! Gold" } },
      participantdeliverysequence: { [PID]: { profileid: PID, products: [{ participantproductid: "pp2", sequenceref: ref("productToDeliverySequence/seq"), sequence: [{ status: "completed" }, {}] }] } },
      deliverables: { dl1: { profileid: PID, participantproductid: "pp2", type: "form", status: "submitted", deliveryref: ref("delivery forms/df") } },
      appointments: {
        apStr: { bookedby: PID, appointment: ref("appointmenttype/at1"), productid: ref("products/kick"), hosts: [ref("profile_data/EIS1")], starttime: ts("2026-03-08T10:00:00Z"), endtime: ts("2026-03-08T11:00:00Z"), attended: true, cancelled: false },
        apRef: { bookedby: ref(`profile_data/${PID}`), appointment: ref("appointmenttype/at1"), hosts: ["EIS1"], starttime: ts("2026-09-22T09:00:00Z"), endtime: ts("2026-09-22T09:45:00Z"), attended: false, cancelled: false },
        apOther: { bookedby: "SOMEONE_ELSE", starttime: ts("2026-09-22T09:00:00Z") },
      },
      appointmenttype: { at1: { name: "Kick-off Session" } },
      queue_token: { qt1: { profile_id: PID, queueref: ref("queue generation/qg"), variationid: "qv1", tokenstatus: "active", currentstage: "Session 2", liveassignmentid: "la1" } },
      "queue stage log": { sl1: { profile_id: PID, logdocid: "qt1", createdon: ts("2026-04-02T05:00:00Z"), currentstage: "Requested" }, sl2: { profile_id: PID, logdocid: "qt1", createdon: ts("2026-06-20T08:45:00Z"), previousstage: "Requested", currentstage: "Session 2", manuallymoved: true } },
      "queue activity log": { al1: { participantid: PID, queueid: "qg", activitydate: ts("2026-04-15T09:10:00Z"), activity: "Session 1 attended", atcmodel: "triple" } },
      "queue generation": { qg: { queuename: "uP! Queue" } }, "queue variation": { qv1: { variationname: "uP! × C3" } },
      "live assignment": { la1: { status: "waiting", stagename: "Session 2", stagetype: "activity", pairing: [PID, "P2"], atcdata: { secret: "NO" } } },
      "cohorts queue planner": { cp1: { profileid: PID, queueid: "qg", selectedslots: ["2026-09-28T09:00"] } },
      "event participation request": { er1: { profileid: PID, eventref: ref("event collection/evBig"), productref: ref("products/live"), status: "approved", doccreateddate: ts("2026-08-01T06:00:00Z") }, er2: { profileid: PID, eventref: ref("event collection/evLive"), status: "requested" } },
      "event collection": { evBig: { name: "uP! Live Dec", venue: "Chennai", start_date: ts("2026-12-12T03:30:00Z"), end_date: ts("2026-12-14T12:30:00Z") }, evLive: { name: "Readiness", venue: "Zoom", start_date: ts("2026-09-20T13:30:00Z"), end_date: ts("2026-09-20T15:00:00Z") } },
      "e-ticket eligibility": { et1: { profileid: PID, eventref: ref("event collection/evBig"), eligible: true } },
      biginvitation: { bi1: { profileid: PID, eventref: ref("event collection/evBig"), status: "accepted", expirydate: ts("2026-09-30T00:00:00Z") } },
      "arena participant": { ar1: { profileid: PID, queueid: "qg", pairingmode: "manual", stagerole: ["participant"], status: "active" }, ar2: { profileid: PID, eventref: ref("event collection/evLive"), pairingmode: "auto", stagerole: [], status: "active" } },
      "event zones": { z1: { eventref: ref("event collection/evBig"), zonename: "Zone B", cohorts: ["c17"] } },
      "wati logs": { w1: { waId: "919876543210", templateName: "reminder", created: ts("2026-09-15T04:00:00Z"), status: "read" }, w2: { number: "919876543210", templateName: "emi", created: ts("2026-09-03T04:00:00Z") } },
      "email archive": { ea1: { profileid: PID, subject: "Welcome", broadcastname: "Welcome to uP!", date: ts("2026-03-02T10:35:00Z"), postmark_msgid: "pm1" }, ea2: { profileid: PID, subject: "Invite", date: ts("2026-08-01T06:05:00Z") } },
      "email logs": { e1: { profileid: PID, email: "asha@example.com", emailarchiveid: "ea1", RecordType: "Open", msgstatus: "open", time: ts("2026-03-02T11:01:00Z") }, e2: { profileid: PID, email: "asha@example.com", emailarchiveid: "ea2", RecordType: "Delivery", msgstatus: "delivery", time: ts("2026-08-01T06:06:00Z") }, eOther: { profileid: "P9", email: "x@y", emailarchiveid: "zz" } },
      notificationrecord: { nr1: { profileid: [PID, "P9"], title: "Session 2 tomorrow", message: "m", date: ts("2026-09-15T04:00:00Z"), success: true }, nrOther: { profileid: ["P9"], title: "not mine", date: ts("2026-09-16T04:00:00Z") } },
      [`notifications/${UID}/logs`]: { n1: { title: "Draft waiting", date: ts("2026-09-14T18:30:00Z"), seen: false, sticky: true } },
      FCM_token: { f1: { profile_ref: ref(`profile_data/${PID}`), FCM_id: "fcm_aaaaaaaa1", device_os: "android", active: true, last_modified: ts("2026-09-15T20:11:00Z") }, f2: { uid: UID, FCM_id: "fcm_bbbbbbbb2", device_os: "ios", active: false, last_modified: ts("2026-05-02T09:00:00Z") } },
      "recommended mix playlist": { rmp1: { profileid: PID, title: "Your Mix", type: "mix", personalised: true, date: ts("2026-09-08T00:00:00Z"), list: [{ id: "ep1", title: "Owning" }, "ep2"] } },
      "content analytics": { ca1: { profileid: PID, videoid: "ep1", videoname: "Owning", type: "eiflixcontent", totaltimespend: 612, logdate: ts("2026-09-14T17:02:00Z") }, ca2: { profileid: PID, videoid: "sv1", videoname: "Walk", type: "solarvoice", totaltimespend: 480, logdate: ts("2026-09-13T06:30:00Z") } },
      episodes: { ep1: { title: "Owning the Outcome", duration: 640 }, ep2: { title: "Second", duration: 100 } },
      procedure_recommend: { pr1: { profileid: PID, procedureref: ref("procedures/proc1"), date: ts("2026-06-20T09:00:00Z") } }, procedures: { proc1: { name: "Reflect" } },
      "participant workshop": { pw1: { profileid: PID, name: "EI Masterclass", status: "enrolled", created: ts("2026-07-14T00:00:00Z") } },
      modes: { m1: { mode: "up_mode_2", label: "In Sessions" } }, eiflixhomewidgets: { w_next: { name: "Next Session", modes: ["up_mode_2"] }, w_book: { name: "Book", modes: ["up_mode_1"] } },
      "participantmetadata exception": {},
      dashboard: { big: { route: "big-dashboard", roles: ["big_participant"], label: "BIG" }, ops: { children: [{ route: "/dynamicqueuemanager", roles: ["operator"], label: "Queue" }] } },
      eisroles: {},
      arenavideoask: { av1: { profileid: PID, videoaskid: "va1", title: "Day 3", eventref: ref("event collection/evBig"), submittedon: ts("2025-03-23T11:40:00Z") } },
      participantvideoask: { pv1: { profileid: PID, videoaskid: "va2", videoask: "Intro", productref: ref("products/kick"), date: ts("2026-03-04T09:20:00Z"), videourl: "https://v/1" } },
      liveevolutionmapping: { lem1: { profileid: PID, title: "Map", live: true, created: ts("2026-04-20T00:00:00Z"), videolist: ["emv1"] } },
      evolutionmappingvideo: { emv1: { profileid: PID, title: "Start", videourl: "u", created: ts("2026-04-20T00:00:00Z"), deleted: false } },
      "accelerated evolution level": { l1: { level: 1, name: "Aware" }, l2: { level: 2, name: "Aligned" } },
      "participant AEL": { a1: { profileid: PID, level: 1, date: ts("2026-04-16T00:00:00Z") } }, evolutionwishlistlog: { wl1: { profileid: PID, question: "Q", answer: "A", date: ts("2026-04-20T00:00:00Z") } },
      quizbyclients: { qz1: { profileid: PID, title: "EI Basics", score: 8, maxscore: 10, date: ts("2026-04-11T09:30:00Z") } },
      emailOTPs: { o1: { email: "asha@example.com", created: ts("2026-09-15T20:09:50Z"), verified: true } },
      "timeline log": { t1: { profileid: PID, date: ts("2026-06-21T00:00:10Z"), activityname: "participantmode", before: "up_mode_1", after: "up_mode_2" } },
      firestore_audit_log: {},
    },
    forms: { formsByClient: { fb1: { profileid: PID, formname: "Intake", status: "submitted", submittedon: ts("2026-03-20T07:44:10Z"), answers: { a: 1 } }, fb2: { profileid: PID, formName: "Reflection", status: "draft", updated: ts("2026-09-14T18:20:05Z") }, fbOther: { profileid: "X", formname: "not mine" } } },
    watson: {
      Participants: { WPT1: { email: "asha@example.com", profileid: PID, customerstatus: "active", pp_status: "ongoing", pp_frequency: "monthly", pp_installmentamount: 12500, pp_installmentspaid: 6, pp_installmentsdue: 6, pp_totalpurchasevalue: 150000, pp_totalpaid: 75000, pp_balance: 75000, paymentcommitment: "NACH" } },
      ParticipantPurchases: { WP1: { participantid: "WPT1", purchasedate: ts("2026-03-02T00:00:00Z"), purchaselabel: "uP! Gold", totalPurchaseValue: 150000 } },
      ParticipantPayments: { PAY1: { participantid: "WPT1", paymentdate: ts("2026-09-05T00:00:00Z"), amount: 12500, mode: "NACH", status: "success" } },
      "Payment Schedule": { S1: { participantid: "WPT1", date: ts("2026-10-05T00:00:00Z"), amount: 12500, status: "pending" } },
    },
  };
}

let dbs, getUser;
function boot({ secrets = { WATSON_SERVICE_ACCOUNT: WATSON_SA }, seed = goldenSeed() } = {}) {
  dbs = { default: makeFirestore(seed.default), forms: makeFirestore(seed.forms), watson: makeFirestore(seed.watson) };
  getUser = jest.fn(async (uid) => ({ uid, email: "asha@example.com", emailVerified: true, providerData: [{ providerId: "password" }], disabled: false, metadata: { creationTime: "Wed, 15 Jan 2025 09:02:11 GMT", lastSignInTime: "Tue, 15 Sep 2026 20:10:48 GMT" } }));
  installFirebaseMocks({ dbs, secrets, getUser });
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
}
const tool = (n) => requireFresh(`tools/${n}`);
const participant = { profileid: PID, email: "asha@example.com", name: "Asha", phone: "+919876543210", uid: UID };
const opts = { now: NOW };
const okData = (r) => { expect(r.ok).toBe(true); expect(r.data.counts.returned).toBe(r.data.items.length); return r.data; };

describe("tool.load() against the golden seed", () => {
  beforeEach(() => boot());

  test("purchase: pjp by profileid, enrollments linked via participantproducts[], names via getAll, other participant's docs ignored", async () => {
    const d = okData(await tool("purchase").load(PID, opts));
    expect(d.items).toHaveLength(1);
    expect(d.items[0]).toMatchObject({ journeyname: "uP! Journey 2026", isActive: true, package: { packagename: "uP! Gold" } });
    expect(d.items[0].products.map((p) => [p.participantproductid, p.productname, p.status, p.kind])).toEqual([["pp1", "Kick-off", "completed", "core"], ["pp2", "Triple ATC", "ongoing", "core"]]);
    expect(d.counts.unlinkedProducts).toBe(0); // ppOther belongs to someone else, not counted
    expect(d.summary.customerstatus).toBe("active");
    expect(JSON.stringify(d)).not.toMatch(/DEAD|atcsummary/);
  });
  test("purchase: empty participant", async () => {
    expect((await tool("purchase").load("NOBODY", opts)).data.summary.headline).toMatch(/No journey purchase/);
  });

  test("finance: Watson participant found by email, sub-collections by Watson id", async () => {
    const d = okData(await tool("finance").load(PID, opts, { participant }));
    expect(d.summary).toMatchObject({ watsonparticipantid: "WPT1", totalPaid: 75000, balance: 75000, emiStatus: "ongoing", nextDueDate: "2026-10-05T00:00:00.000Z" });
    expect(d.items[0]).toMatchObject({ id: "WP1", counts: { payments: 1, scheduleUpcoming: 1 } });
  });
  test("finance: falls back to profileid when email is unknown; empty when neither matches", async () => {
    expect((await tool("finance").load(PID, opts, { participant: { profileid: PID, email: "other@x.com" } })).data.summary.watsonparticipantid).toBe("WPT1");
    expect((await tool("finance").load("ZZ", opts, { participant: { profileid: "ZZ", email: "no@x.com" } })).data.summary.headline).toMatch(/No Watson finance record/);
  });
  test("finance + systemBilling: Watson secret absent -> empty envelope, no throw", async () => {
    boot({ secrets: {} });
    expect((await tool("finance").load(PID, opts, { participant })).data.summary.headline).toMatch(/Watson service account not configured/);
    const b = await tool("systemBilling").load(PID, opts, { participant });
    expect(b.data.summary).toMatchObject({ headline: expect.stringMatching(/not configured/), variant: "a:participant-ledger" });
  });
  test("systemBilling: ledger from the same Watson raw", async () => {
    const d = okData(await tool("systemBilling").load(PID, opts, { participant }));
    expect(d.items.map((i) => i.status)).toEqual(["upcoming", "paid"]);
    expect(d.summary.nextDueAmount).toBe(12500);
  });

  test("activeProduct: sequence doc keyed by profileid, deliverables by participantproductid", async () => {
    const d = okData(await tool("activeProduct").load(PID, opts));
    expect(d.summary).toMatchObject({ currentParticipantproductid: "pp2", currentProductName: "Triple ATC", currentStep: 1, totalSteps: 2, nextAction: "in queue" });
    expect(d.items[0].deliverables).toHaveLength(1);
    expect(d.counts.total).toBe(2);
  });

  test("forms: reads the named firestore-forms DB and the default-DB quizzes; other participant excluded", async () => {
    const d = okData(await tool("forms").load(PID, opts));
    expect(d.items.map((i) => [i.kind, i.formname, i.status])).toEqual([["form", "Reflection", "draft"], ["quiz", "EI Basics", "submitted"], ["form", "Intake", "submitted"]]);
    expect(d.counts).toMatchObject({ submitted: 2, drafts: 1, quizzes: 1 });
  });

  test("appointment: bookedby matched as string AND as DocumentReference, deduped; hosts as ref or id; type names resolved", async () => {
    const d = okData(await tool("appointment").load(PID, opts));
    expect(d.items.map((i) => [i.appointmentid, i.status, i.hosts[0]?.name])).toEqual([["apRef", "upcoming", "Ravi"], ["apStr", "attended", "Ravi"]]);
    expect(d.items[0].appointmenttype).toBe("Kick-off Session");
    expect(d.counts.total).toBe(2);
  });
  test("appointment: openviduroom query failure is tolerated (catch -> no video)", async () => {
    dbs.default._throwOn.set("openviduroom", "no index");
    const d = okData(await tool("appointment").load(PID, opts));
    expect(d.items.every((i) => i.video === null)).toBe(true);
  });

  test("queue: token, stage log by logdocid, activity log, names via getAll on space-containing paths, live assignment projected without ATC", async () => {
    const d = okData(await tool("queue").load(PID, opts));
    expect(d.items[0]).toMatchObject({ tokenid: "qt1", queuename: "uP! Queue", variationname: "uP! × C3", status: "going", studio: { status: "waiting", pairing: [PID, "P2"] } });
    expect(d.items[0].stageHistory.map((h) => h.currentstage)).toEqual(["Requested", "Session 2"]);
    expect(d.items[0].activityLog).toHaveLength(1);
    expect(d.items[0].plannerSlots).toHaveLength(1);
    expect(JSON.stringify(d)).not.toMatch(/atcdata|secret/);
  });

  test("events: requests by profileid, event names via refs, eticket/invitation/arena/zone joined by event", async () => {
    const d = okData(await tool("events").load(PID, opts));
    const big = d.items.find((i) => i.requestid === "er1");
    expect(big).toMatchObject({ eventname: "uP! Live Dec", eventKind: "big", status_norm: "approved", eticket: { eligible: true }, invitation: { status: "accepted" }, zone: { zonename: "Zone B" } });
    expect(big.arena).toBeNull(); // ar1 carries only queueid "qg" — no eventref match (arena↔event join is inferred, see spec §7)
    expect(d.items.find((i) => i.requestid === "er2").arena).toMatchObject({ pairingmode: "auto" }); // ar2 matches by eventref
    expect(d.summary.latestProductEvent).toMatchObject({ eventid: "evBig", activityname: "approved" });
    expect(d.counts).toMatchObject({ total: 2, big: 1, live: 1, invitations: 1 });
  });
  test("events: eventref pointing at a queue generation doc + arenaeventid -> name/dates from arena events; raw status 'unattended' -> attendance", async () => {
    dbs.default._store.set("queue generation", new Map([["qg", { queuename: "MIG - Clone", venue: "Mumbai", queuestartdate: ts("2026-05-16T00:00:00Z"), queueenddate: ts("2026-05-18T00:00:00Z") }]]));
    dbs.default._store.set("arena events", new Map([["ae1", { eventname: "MIG Mumbai May", venue: "Mumbai", startdate: ts("2026-05-16T04:00:00Z"), enddate: ts("2026-05-18T12:00:00Z"), type: "big" }]]));
    dbs.default._store.get("event participation request").set("erQ", { profileid: PID, eventref: ref("queue generation/qg"), arenaeventid: "ae1", status: "unattended", initiatedfrom: "queue" });
    dbs.default._store.get("event participation request").set("erQ2", { profileid: PID, eventref: ref("queue generation/qg"), status: "approved" });
    const d = okData(await tool("events").load(PID, opts));
    expect(d.items.find((i) => i.requestid === "erQ")).toMatchObject({ eventname: "MIG Mumbai May", eventSource: "arena events", venue: "Mumbai", start_date: "2026-05-16T04:00:00.000Z", status: "unattended", status_norm: "approved", attendance: "unattended", isGoing: false, initiatedfrom: "queue" });
    // erQ2: approved, event already over (end 2026-05-18 < now), no attendance flag -> past-event rule says unattended
    expect(d.items.find((i) => i.requestid === "erQ2")).toMatchObject({ eventname: "MIG - Clone", eventSource: "queue generation", start_date: "2026-05-16T00:00:00.000Z", status_norm: "approved", attendance: "unattended" });
    expect(d.counts).toMatchObject({ total: 4, approved: 3, unattended: 2, pending: 2 });
  });
  test("events: optional collections failing are tolerated", async () => {
    dbs.default._throwOn.set("e-ticket eligibility", "x"); dbs.default._throwOn.set("event zones", "y");
    const d = okData(await tool("events").load(PID, opts));
    expect(d.items.find((i) => i.requestid === "er1")).toMatchObject({ eticket: { eligible: false }, zone: null });
  });

  test("communication: wati by phone digits (waId or number), email by emailid/email, push by array-contains, in-app by uid subcollection, devices by ref or uid", async () => {
    const d = okData(await tool("communication").load(PID, opts, { participant }));
    expect(d.items.map((i) => [i.kind, i.id])).toEqual([["whatsapp", "w1"], ["push", "nr1"], ["inApp", "n1"], ["whatsapp", "w2"], ["email", "ea2"], ["email", "ea1"]]);
    expect(d.items.find((i) => i.id === "nr1")).toMatchObject({ status: "sent" });
    expect(d.items.find((i) => i.id === "ea1")).toMatchObject({ title: "Welcome", status: "opened", statusAt: "2026-03-02T11:01:00.000Z", events: 1 });
    expect(d.items.find((i) => i.id === "ea2")).toMatchObject({ status: "delivered", events: 1 });
    expect(d.summary.devices.map((x) => x.device_os)).toEqual(["android", "ios"]);
    expect(d.counts).toMatchObject({ whatsapp: 2, email: 2, push: 1, inApp: 1, opened: 1, delivered: 1 });
  });
  test("communication: participant without phone/email/uid -> push + emails (by profileid) + ref-matched devices", async () => {
    const d = okData(await tool("communication").load(PID, opts, { participant: { profileid: PID } }));
    expect(d.items.map((i) => i.kind)).toEqual(["push", "email", "email"]);
    expect(d.summary.devices).toHaveLength(1);
  });

  test("recommendation: playlist + progress from content analytics + episode titles + procedures", async () => {
    const d = okData(await tool("recommendation").load(PID, opts));
    const pl = d.items.find((i) => i.kind === "personal");
    expect(pl.videos.map((v) => [v.videoid, v.title, v.status])).toEqual([["ep1", "Owning", "completed"], ["ep2", "Second", "notStarted"]]);
    expect(d.items.find((i) => i.kind === "procedure")).toMatchObject({ title: "Reflect" });
  });
  test("recommendation/content: orderBy query failure falls back to the plain query", async () => {
    const original = dbs.default.collection;
    dbs.default.collection = (name) => { const q = original(name); if (name !== "content analytics") return q; const wrap = (qq) => ({ ...qq, orderBy: () => ({ ...qq, limit: () => ({ get: async () => { throw new Error("needs index"); } }) }), limit: (n) => wrap(qq.limit(n)), where: (...a) => wrap(qq.where(...a)) }); return wrap(q); };
    expect(okData(await tool("content").load(PID, opts)).summary.totalPlays).toBe(2);
    expect(okData(await tool("recommendation").load(PID, opts)).counts.videosCompleted).toBe(1);
  });

  test("content: analytics + workshops", async () => {
    const d = okData(await tool("content").load(PID, opts));
    expect(d.summary).toMatchObject({ currentVideoid: "ep1", totalPlays: 2 });
    expect(d.items.map((i) => i.kind)).toEqual(["activity", "activity", "workshop"]);
  });

  test("mode: modes config keyed by id and by mode field; widgets evaluated", async () => {
    const d = okData(await tool("mode").load(PID, opts));
    expect(d.summary).toMatchObject({ participantmode: "up_mode_2", participantmodeLabel: "In Sessions", projectionHealthy: true });
    expect(d.items[0].widgets.map((w) => [w.widgetid, w.status])).toEqual([["w_next", "visible"], ["w_book", "hidden"]]);
  });
  test("mode: neither pmd nor profile -> empty", async () => {
    expect((await tool("mode").load("NOBODY", opts)).data.summary.headline).toMatch(/No mode on record/);
  });

  test("roles: role_ref resolved, dashboard ACL evaluated", async () => {
    const d = okData(await tool("roles").load(PID, opts));
    expect(d.summary).toMatchObject({ uid: UID, primaryRole: "big_participant", screensAllowed: 1, screensTotal: 2 });
    expect(d.items).toEqual([expect.objectContaining({ path: "/big-dashboard", allowed: true })]);
  });
  test("roles: unknown profile -> empty", async () => {
    expect((await tool("roles").load("NOBODY", opts)).data.summary.headline).toMatch(/No profile on record/);
  });

  test("videoAsk / evolutionMapping", async () => {
    const v = okData(await tool("videoAsk").load(PID, opts));
    expect(v.items.map((i) => [i.kind, i.eventname || i.productname])).toEqual([["nonEvent", "Kick-off"], ["event", "uP! Live Dec"]]);
    const e = okData(await tool("evolutionMapping").load(PID, opts));
    expect(e.summary).toMatchObject({ currentael: 2, currentLevelName: "Aligned", liveMappingTitle: "Map" });
    expect(e.items[0].videos[0].title).toBe("Start");
    expect(e.counts).toMatchObject({ mappings: 1, videos: 1, aelLevels: 2, wishlist: 1 });
  });

  test("profileAuthentication: auth record via getUser(uid from user_ref), otps by email, timeline by profileid, devices by ref + uid", async () => {
    const d = okData(await tool("profileAuthentication").load(PID, opts));
    expect(getUser).toHaveBeenCalledWith(UID);
    expect(d.summary).toMatchObject({ uid: UID, emailVerified: true, providers: ["password"], registrationStatus: "completed", subscriber: true });
    expect(d.items.map((i) => i.kind)).toEqual(["device", "otp", "history", "device", "history"]);
    expect(JSON.stringify(d)).not.toMatch(/DEAD/);
  });
  test("profileAuthentication: profile without user_ref / new_user_data -> uid via getUserByEmail", async () => {
    dbs.default._store.get("profile_data").set("PNOUID", { profileid: "PNOUID", email: "nouid@example.com", name: "No Uid", created: ts("2026-02-16T06:29:58Z"), user_ref: null });
    const byEmail = jest.fn(async (email) => ({ uid: "uidFromEmail", email, emailVerified: false, providerData: [{ providerId: "password" }], disabled: false, metadata: { creationTime: "Mon, 16 Feb 2026 06:29:58 GMT" } }));
    installFirebaseMocks({ dbs, getUser, getUserByEmail: byEmail });
    const d = okData(await tool("profileAuthentication").load("PNOUID", opts));
    expect(byEmail).toHaveBeenCalledWith("nouid@example.com");
    expect(d.summary).toMatchObject({ uid: "uidFromEmail", providers: ["password"], emailVerified: false });
  });
  test("profileAuthentication: getUser rejects -> auth block null, rest still returned; unknown profile -> empty", async () => {
    getUser.mockRejectedValueOnce(new Error("no user"));
    const d = okData(await tool("profileAuthentication").load(PID, opts));
    expect(d.summary.providers).toEqual([]);
    expect(d.summary.uid).toBe(UID); // falls back to user_ref id
    expect((await tool("profileAuthentication").load("NOBODY", opts)).data.summary.headline).toMatch(/No profile on record/);
  });

  test("every tool: empty participant returns a headline and zero counts, never throws", async () => {
    const names = ["purchase", "activeProduct", "forms", "appointment", "queue", "events", "communication", "recommendation", "content", "videoAsk", "evolutionMapping"];
    for (const n of names) {
      const r = await tool(n).load("NOBODY", opts, { participant: { profileid: "NOBODY" } });
      expect(r.ok).toBe(true);
      expect(r.data.counts).toMatchObject({ total: 0, returned: 0 });
      expect(r.data.summary.headline).toMatch(/No .* on record/);
    }
  });
});
