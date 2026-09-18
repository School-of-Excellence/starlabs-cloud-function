/**
 * events — every live-event / big-event participation request with approval, attendance, e-ticket,
 * zone, B!G invitation and arena participation.
 *
 * Reads: participant metadata (productevent = latest only) · event participation request (profileid)
 * · event collection / arena events / products (names, one getAll) · e-ticket eligibility · biginvitation
 * · arena participant · event zones (eventref in).
 * eventKind: "big" when the event has a physical venue (live arena), "live" when virtual (readiness gate)
 * — derived from the event doc's venue / type; raw fields kept alongside.
 */
const { C, docsOf, docById, getAllByRef, stripHidden } = require("../collection");
const {
  withFilter, envelope, emptyEnvelope, parseOptions,
  toIso, toMs, daysUntil, refId, refPath, normalizeStatus, plural, newestFirst, sinceFilter, tally, tallyText,
} = require("../envelope");

// raw `status` on starlabs-test also carries the attendance outcome (approved | attended | unattended); those map to
// status_norm "approved" and set attendance directly.
const NORM = { requested: "requested", request: "requested", pending: "requested", approved: "approved", approve: "approved", accepted: "approved", attended: "approved", unattended: "approved", rejected: "rejected", reject: "rejected", declined: "rejected", cancelled: "cancelled", canceled: "cancelled" };

function eventKind(ev) {
  const t = String(ev?.eventtype || ev?.type || "").toLowerCase();
  if (/big|arena|live ?event|in.?person/.test(t)) return "big";
  if (/virtual|online|readiness|zoom/.test(t)) return "live";
  const venue = String(ev?.venue || "").toLowerCase();
  if (!venue || /zoom|online|virtual|meet|webinar/.test(venue)) return "live";
  return "big";
}

function attendanceOf(r, ev, now) {
  const s = normalizeStatus(r.status);
  if (s === "attended") return "attended";
  if (s === "unattended" || s === "noshow" || s === "no_show") return "unattended";
  const a = normalizeStatus(r.attendance ?? r.attendancestatus ?? "");
  if (r.attended === true || /attend/.test(a) && !/un|not/.test(a)) return "attended";
  if (r.attended === false && r.checkedin != null) return "unattended";
  const end = toMs(ev?.end_date ?? ev?.enddate);
  if (end != null && end < now.getTime()) return r.attended === false || /un|no/.test(a) ? "unattended" : (a === "not_started" ? "unattended" : "attended");
  return "pending";
}

function eventFacts(ev, ae, evPath) {
  // ev = the eventref target: an `event collection` doc (name, start_date, end_date, venue) or a `queue generation` doc
  // (queuename, queuestartdate, queueenddate, venue) — queue-based events are real on starlabs-test.
  // ae = the `arena events/{arenaeventid}` doc (eventname, startdate, enddate, venue, type, title).
  const isQueue = String(evPath || "").startsWith("queue generation/");
  return {
    name: ae?.eventname ?? ae?.title ?? ev?.name ?? ev?.eventname ?? ev?.queuename ?? null,
    start: toIso(ae?.startdate ?? ev?.start_date ?? ev?.startdate ?? ev?.queuestartdate),
    end: toIso(ae?.enddate ?? ev?.end_date ?? ev?.enddate ?? ev?.queueenddate),
    venue: ae?.venue ?? ev?.venue ?? null,
    source: ae ? "arena events" : isQueue ? "queue generation" : ev ? "event collection" : null,
    type: ae?.type ?? ev?.eventtype ?? ev?.type ?? null,
  };
}

function projectRequest(r, names, eticket, invitations, arenas, zones, now) {
  const ev = names.get(refPath(r.eventref)) || null, prod = names.get(refPath(r.productref)) || null;
  const ae = r.arenaeventid ? names.get(`arena events/${refId(r.arenaeventid)}`) || null : null;
  const evId = refId(r.eventref);
  const facts = eventFacts(ev, ae, refPath(r.eventref));
  const start = facts.start, end = facts.end;
  const norm = NORM[normalizeStatus(r.status)] || normalizeStatus(r.status);
  const et = eticket.find((e) => refId(e.eventref) === evId) || null;
  const inv = invitations.find((i) => refId(i.eventref) === evId) || null;
  const ar = arenas.find((a) => refId(a.eventref) === evId || refId(a.queueid) === evId) || null;
  const zone = zones.find((z) => refId(z.eventref) === evId) || null;
  const attendance = attendanceOf(r, { end_date: end }, now);
  return {
    requestid: r.id, eventref: refPath(r.eventref), arenaeventid: refId(r.arenaeventid), eventname: facts.name, eventSource: facts.source,
    eventKind: eventKind({ venue: facts.venue, type: facts.type, eventtype: ev?.eventtype }),
    venue: facts.venue, start_date: start, end_date: end, daysUntil: start && toMs(start) > now.getTime() ? daysUntil(start, now) : null,
    productref: refPath(r.productref), productname: prod ? prod.product || prod.name || null : null, participantproductid: refId(r.participantproductid),
    status: r.status ?? null, status_norm: norm, attendance, isGoing: norm === "approved" && attendance === "pending",
    doccreateddate: toIso(r.doccreateddate), initiatedfrom: r.initiatedfrom ?? null, deliveryref: refPath(r.deliveryRef ?? r.deliveryref),
    eticket: { eligible: et ? et.eligible !== false : false, issued: et ? et.issued === true || !!et.qr || !!et.ticketid : false, qr: et ? et.qr ?? et.ticketid ?? null : null },
    zone: zone ? { zonename: zone.zonename ?? null, cohorts: Array.isArray(zone.cohorts) ? zone.cohorts.map(refId) : [] } : null,
    invitation: inv ? { status: inv.status ?? null, expirydate: toIso(inv.expirydate), created: toIso(inv.created) } : null,
    arena: ar ? { queueid: refId(ar.queueid), pairingmode: ar.pairingmode ?? null, stagerole: Array.isArray(ar.stagerole) ? ar.stagerole : [], status: ar.status ?? null, liveassignmentstatus: ar.liveassignmentstatus ?? null } : null,
  };
}

/** Pure projection. raw = { pmd, requests[], names: Map, eticket[], invitations[], arenas[], zones[] } */
function project(raw, opts = {}) {
  const { limit, since, now } = parseOptions(opts);
  const kindFilter = opts.kind ? String(opts.kind).toLowerCase() : null;
  const all = newestFirst((raw.requests || []).map((r) => projectRequest(r, raw.names || new Map(), raw.eticket || [], raw.invitations || [], raw.arenas || [], raw.zones || [], now)), "start_date");
  let items = kindFilter ? all.filter((i) => i.eventKind === kindFilter) : all;
  const total = items.length;
  items = sinceFilter(items, "start_date", since).slice(0, limit);
  const future = all.filter((i) => i.daysUntil != null && i.status_norm !== "rejected" && i.status_norm !== "cancelled").sort((a, b) => a.daysUntil - b.daysUntil);
  const next = future[0] || null, nextBig = future.find((i) => i.eventKind === "big") || null;
  const attended = all.filter((i) => i.attendance === "attended");
  const ts = tally(all, "status_norm"), ta = tally(all, "attendance");
  return envelope({
    now,
    summary: {
      headline: all.length
        ? `${plural(all.length, "event request")}: ${tallyText(ts)}; attendance: ${tallyText(ta)}` + (next ? ` · next ${next.eventname || next.eventref} on ${next.start_date?.slice(0, 10)} (${next.status_norm})` : "")
        : "No event participation on record for this profile.",
      nextEventId: next ? refId(next.eventref) : null, nextEventName: next?.eventname ?? null, nextEventKind: next?.eventKind ?? null, nextEventStart: next?.start_date ?? null, nextEventStatus: next?.status_norm ?? null,
      nextBigEventName: nextBig?.eventname ?? null, nextBigEventStart: nextBig?.start_date ?? null, nextBigEticketEligible: nextBig?.eticket.eligible ?? null,
      lastAttendedEventName: attended[0]?.eventname ?? null, lastAttendedAt: attended[0]?.start_date ?? null,
      latestProductEvent: raw.pmd?.productevent ? { eventid: refId(raw.pmd.productevent.eventid), activityname: raw.pmd.productevent.activityname ?? null, activitydate: toIso(raw.pmd.productevent.activitydate) } : null,
    },
    counts: {
      total, live: all.filter((i) => i.eventKind === "live").length, big: all.filter((i) => i.eventKind === "big").length,
      requested: ts.requested || 0, approved: ts.approved || 0, rejected: ts.rejected || 0, cancelled: ts.cancelled || 0,
      going: all.filter((i) => i.isGoing).length, attended: ta.attended || 0, unattended: ta.unattended || 0, pending: ta.pending || 0,
      invitations: (raw.invitations || []).length,
    },
    items,
  });
}

async function load(profileid, opts = {}) {
  const [pmd, requests, eticket, invitations, arenas] = await Promise.all([
    docById(C.PMD, profileid).then(stripHidden),
    docsOf(C.EVENT_REQUEST, (c) => c.where("profileid", "==", profileid)),
    docsOf(C.ETICKET, (c) => c.where("profileid", "==", profileid)).catch(() => []),
    docsOf(C.BIG_INVITATION, (c) => c.where("profileid", "==", profileid)),
    docsOf(C.ARENA_PARTICIPANT, (c) => c.where("profileid", "==", profileid)),
  ]);
  if (!requests.length && !invitations.length) return emptyEnvelope("No event participation on record for this profile.", parseOptions(opts).now);
  const eventRefs = requests.map((r) => r.eventref).filter(Boolean);
  const arenaPaths = requests.map((r) => (r.arenaeventid ? `arena events/${refId(r.arenaeventid)}` : null)).filter(Boolean);
  const [names, zones] = await Promise.all([
    getAllByRef([...eventRefs, ...requests.map((r) => r.productref), ...arenaPaths]),
    eventRefs.length ? docsOf(C.EVENT_ZONES, (c) => c.where("eventref", "in", eventRefs.slice(0, 30))).catch(() => []) : [],
  ]);
  // event zones carry cohorts[]/coordinators[]/mentors[], not participants — the zone a participant
  // sits in is the zone whose cohorts[] contains one of their B!G cohorts; until that join is wired
  // the first zone of the event is reported (zonename only). TODO(confirm on data).
  return project({ pmd, requests, names, eticket, invitations, arenas, zones }, opts);
}

module.exports = Object.freeze({
  name: "events",
  description: "All live-event and big-event participation: requested / approved / rejected / cancelled, going, attended or unattended, e-ticket, zone, B!G invitation and arena participation. Filter kind=live|big.",
  input_schema: withFilter("kind", { type: "string", enum: ["live", "big"] }),
  sources: [C.PMD.name, C.EVENT_REQUEST.name, C.EVENT_COLLECTION.name, C.ARENA_EVENTS.name, C.EVENT_ZONES.name, C.ETICKET.name, C.BIG_INVITATION.name, C.ARENA_PARTICIPANT.name],
  handler: (input, ctx = {}) => load(input.profileid, { ...input, now: ctx.now }),
  load, project, eventKind,
});
