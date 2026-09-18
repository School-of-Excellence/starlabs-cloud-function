/**
 * appointment — all appointment history with a derived status.
 *
 * Reads: appointments (bookedby == profileid, matched as string or DocumentReference) ·
 * appointmenttype / products / profile_data (names, one getAll) · openviduroom (video provider).
 * Derived status: cancelled -> "cancelled"; attended -> "attended"; starttime in future -> "upcoming";
 * otherwise "missed". Raw `attended` / `cancelled` booleans are kept alongside.
 */
const { C, col, docsOf, getAllByRef } = require("../collection");
const {
  withFilter, envelope, emptyEnvelope, parseOptions,
  toIso, toMs, refId, refPath, plural, newestFirst, sinceFilter,
} = require("../envelope");

function deriveStatus(a, now) {
  if (a.cancelled === true) return "cancelled";
  if (a.attended === true) return "attended";
  const start = toMs(a.starttime);
  if (start != null && start > now.getTime()) return "upcoming";
  return "missed";
}

function projectAppointment(a, names, rooms, now) {
  const typeDoc = names.get(refPath(a.appointment)), prodDoc = names.get(refPath(a.productid));
  const hosts = (a.hosts || []).map((h) => {
    const id = refId(h), d = names.get(refPath(h)) || names.get(`profile_data/${id}`);
    return { profileid: id, name: d ? d.name || null : null };
  });
  const start = toIso(a.starttime), end = toIso(a.endtime);
  const room = rooms.get(a.id) || null;
  const video = a.zoomdata || a.zoomlink || a.zoomjoinurl
    ? { provider: "zoom", roomid: a.zoomdata?.id ?? a.zoomdata?.meetingid ?? null }
    : room ? { provider: room.livekit ? "livekit" : "openvidu", roomid: room.roomid ?? room.id } : null;
  return {
    appointmentid: a.id,
    appointment: refPath(a.appointment), appointmenttype: typeDoc ? typeDoc.name || typeDoc.title || null : null,
    productid: refPath(a.productid), productname: prodDoc ? prodDoc.product || prodDoc.name || null : null,
    participantproductid: refId(a.participantproductid),
    starttime: start, endtime: end,
    durationMin: start && end ? Math.round((new Date(end) - new Date(start)) / 60000) : null,
    created: toIso(a.created),
    hosts, bookedby: refId(a.bookedby),
    attended: a.attended === true, cancelled: a.cancelled === true,
    status: deriveStatus(a, now), video,
  };
}

/** Pure projection. raw = { appointments[], names: Map, rooms: Map(appointmentid -> room) } */
function project(raw, opts = {}) {
  const { limit, since, now } = parseOptions(opts);
  const statusFilter = opts.status ? String(opts.status).toLowerCase() : null;
  const rooms = raw.rooms || new Map();
  let all = (raw.appointments || []).map((a) => projectAppointment(a, raw.names || new Map(), rooms, now));
  all = newestFirst(all, "starttime");
  let items = statusFilter ? all.filter((i) => i.status === statusFilter) : all;
  const total = items.length;
  items = sinceFilter(items, "starttime", since).slice(0, limit);
  const by = (s) => all.filter((i) => i.status === s);
  const upcoming = [...by("upcoming")].sort((a, b) => (a.starttime || "").localeCompare(b.starttime || ""));
  const next = upcoming[0] || null, lastAttended = by("attended")[0] || null;
  const decided = by("attended").length + by("missed").length;
  return envelope({
    now,
    summary: {
      headline: all.length
        ? `${plural(all.length, "appointment")}: ${by("attended").length} attended, ${by("cancelled").length} cancelled, ${by("missed").length} missed, ${upcoming.length} upcoming` +
          (next ? ` · next ${next.appointmenttype || "appointment"} on ${next.starttime?.slice(0, 10)}${next.hosts[0]?.name ? " with " + next.hosts[0].name : ""}` : "")
        : "No appointments on record for this profile.",
      nextAppointmentId: next?.appointmentid ?? null, nextStarttime: next?.starttime ?? null, nextType: next?.appointmenttype ?? null, nextHost: next?.hosts[0]?.name ?? null,
      lastAttendedAt: lastAttended?.starttime ?? null, lastAttendedType: lastAttended?.appointmenttype ?? null,
      attendanceRatePct: decided ? Math.round((by("attended").length / decided) * 100) : null,
    },
    counts: { total, attended: by("attended").length, cancelled: by("cancelled").length, upcoming: upcoming.length, missed: by("missed").length },
    items,
  });
}

async function load(profileid, opts = {}) {
  const profileRef = col(C.PROFILE).doc(profileid);
  const [asString, asRef] = await Promise.all([
    docsOf(C.APPOINTMENTS, (c) => c.where("bookedby", "==", profileid)),
    docsOf(C.APPOINTMENTS, (c) => c.where("bookedby", "==", profileRef)),
  ]);
  const seen = new Set();
  const appointments = [...asString, ...asRef].filter((a) => (seen.has(a.id) ? false : seen.add(a.id)));
  if (!appointments.length) return emptyEnvelope("No appointments on record for this profile.", parseOptions(opts).now);
  const refs = [];
  for (const a of appointments) { refs.push(a.appointment, a.productid); for (const h of a.hosts || []) refs.push(typeof h === "string" ? `profile_data/${h}` : h); }
  const [names, roomDocs] = await Promise.all([
    getAllByRef(refs),
    docsOf(C.OPENVIDU_ROOM, (c) => c.where("appointmentid", "in", appointments.slice(0, 30).map((a) => a.id))).catch(() => []),
  ]);
  const rooms = new Map(roomDocs.map((r) => [r.appointmentid, r]));
  return project({ appointments, names, rooms }, opts);
}

module.exports = Object.freeze({
  name: "appointment",
  description: "All appointment history for the participant with status upcoming | attended | cancelled | missed, hosts, type, product and video provider. Filter status=…",
  input_schema: withFilter("status", { type: "string", enum: ["upcoming", "attended", "cancelled", "missed"] }),
  sources: [C.APPOINTMENTS.name, C.APPOINTMENT_TYPE.name, C.PRODUCTS.name, C.PROFILE.name, C.OPENVIDU_ROOM.name],
  handler: (input, ctx = {}) => load(input.profileid, { ...input, now: ctx.now }),
  load, project, deriveStatus,
});
