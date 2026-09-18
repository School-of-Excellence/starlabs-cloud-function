/**
 * videoAsk — every VideoAsk the participant submitted, split by event vs non-event.
 * Reads: arenavideoask (event-bound) · participantvideoask (product/queue-bound) · event collection /
 * products (names). Payload keys (videourl, transcript, duration) not yet confirmed on a real doc —
 * read defensively.
 */
const { C, docsOf, getAllByRef } = require("../collection");
const {
  withFilter, envelope, emptyEnvelope, parseOptions,
  toIso, refId, refPath, plural, newestFirst, sinceFilter,
} = require("../envelope");

const first = (...vals) => vals.find((v) => v != null && v !== "") ?? null;

function projectOne(d, kind, names) {
  const ev = d.eventref ? names.get(refPath(d.eventref)) : null, prod = d.productref ? names.get(refPath(d.productref)) : null;
  return {
    kind, id: d.id, videoaskid: first(d.videoaskid, d.videoask_id, d.formid), videoask: first(d.videoask, d.title, d.question, d.name),
    eventref: refPath(d.eventref), eventname: ev ? ev.name || ev.eventname || null : null,
    productref: refPath(d.productref), productname: prod ? prod.product || prod.name || null : null, queueref: refPath(first(d.queueref, d.queueid)),
    submittedAt: toIso(first(d.submittedon, d.submittedAt, d.date, d.created, d.timestamp)),
    videourl: first(d.videourl, d.videoUrl, d.mediaurl, d.url, d.answer?.media_url), durationSec: d.duration ?? d.answer?.duration ?? null,
    transcript: first(d.transcript, d.transcription, d.answer?.transcription),
  };
}

/** Pure projection. raw = { arena[], participant[], names: Map } */
function project(raw, opts = {}) {
  const { limit, since, now } = parseOptions(opts);
  const kindFilter = opts.kind ? String(opts.kind) : null;
  const names = raw.names || new Map();
  const all = newestFirst([...(raw.arena || []).map((d) => projectOne(d, "event", names)), ...(raw.participant || []).map((d) => projectOne(d, "nonEvent", names))], "submittedAt");
  let items = kindFilter ? all.filter((i) => i.kind === kindFilter) : all;
  const total = items.length;
  items = sinceFilter(items, "submittedAt", since).slice(0, limit);
  const last = all[0] || null, lastEvent = all.find((i) => i.kind === "event") || null;
  const events = all.filter((i) => i.kind === "event").length;
  return envelope({
    now,
    summary: {
      headline: all.length ? `${plural(all.length, "VideoAsk")}: ${events} at events, ${all.length - events} outside events` + (last ? ` · last "${last.videoask || last.videoaskid}" on ${last.submittedAt?.slice(0, 10)}` : "") : "No VideoAsk submissions on record for this profile.",
      lastSubmittedAt: last?.submittedAt ?? null, lastVideoask: last?.videoask ?? null, lastKind: last?.kind ?? null, lastEventName: lastEvent?.eventname ?? null,
    },
    counts: { total, events, nonEvents: all.length - events, withTranscript: all.filter((i) => i.transcript).length },
    items,
  });
}

async function load(profileid, opts = {}) {
  const [arena, participant] = await Promise.all([
    docsOf(C.ARENA_VIDEOASK, (c) => c.where("profileid", "==", profileid)),
    docsOf(C.PARTICIPANT_VIDEOASK, (c) => c.where("profileid", "==", profileid)),
  ]);
  if (!arena.length && !participant.length) return emptyEnvelope("No VideoAsk submissions on record for this profile.", parseOptions(opts).now);
  const names = await getAllByRef([...arena, ...participant].flatMap((d) => [d.eventref, d.productref]));
  return project({ arena, participant, names }, opts);
}

module.exports = Object.freeze({
  name: "videoAsk",
  description: "Every VideoAsk the participant submitted, across events (arenavideoask) and outside events (participantvideoask), with the linked event/product and media. Filter kind=event|nonEvent.",
  input_schema: withFilter("kind", { type: "string", enum: ["event", "nonEvent"] }),
  sources: [C.ARENA_VIDEOASK.name, C.PARTICIPANT_VIDEOASK.name, C.EVENT_COLLECTION.name, C.PRODUCTS.name],
  handler: (input, ctx = {}) => load(input.profileid, { ...input, now: ctx.now }),
  load, project,
});
