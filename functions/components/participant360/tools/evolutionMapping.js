/**
 * evolutionMapping — configured evolution mappings/videos and the participant's AEL activity.
 *
 * Reads: participant metadata (currentael, completedael, crossovermetric, extendedlifeimpact — written
 * by participantAELData_to_pmd / participantsely_to_pmd) · liveevolutionmapping · evolutionmappingvideo
 * (deleted == false) · accelerated evolution level (config) · participant AEL · evolutionwishlistlog.
 */
const { C, docsOf, docById, stripHidden } = require("../collection");
const {
  PARTICIPANT_INPUT_SCHEMA, envelope, emptyEnvelope, parseOptions,
  toIso, refId, plural, newestFirst,
} = require("../envelope");

const first = (...vals) => vals.find((v) => v != null && v !== "") ?? null;
const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** Pure projection. raw = { pmd, mappings[], videos[], levels[], ael[], wishlist[] } */
function project(raw, opts = {}) {
  const { limit, now } = parseOptions(opts);
  const pmd = stripHidden(raw.pmd) || {};
  const videos = (raw.videos || []).map((v, i) => ({ id: v.id, title: v.title ?? null, videourl: v.videourl ?? null, created: toIso(v.created), deleted: v.deleted === true, order: i + 1 }));
  const byId = new Map(videos.map((v) => [v.id, v]));
  const mappings = (raw.mappings || []).map((m) => {
    const list = (m.videolist || []).map((x) => byId.get(refId(x)) || { id: refId(x), title: null, videourl: null, created: null, deleted: false, order: null });
    return { kind: "mapping", id: m.id, title: m.title ?? null, live: m.live === true, created: toIso(m.created), counts: { videos: list.length }, videos: list.map((v, i) => ({ ...v, order: i + 1 })) };
  });
  const achieved = new Map();
  for (const a of raw.ael || []) { const lvl = num(first(a.level, a.ael, a.currentael)); if (lvl != null && !achieved.has(lvl)) achieved.set(lvl, a); }
  const currentael = num(first(pmd.currentael, [...achieved.keys()].sort((a, b) => b - a)[0]));
  const completed = Array.isArray(pmd.completedael) ? pmd.completedael.map(num).filter((x) => x != null) : [...achieved.keys()];
  const levels = (raw.levels || []).map((l) => ({ level: num(first(l.level, l.order, l.id)), name: first(l.name, l.title, l.label) })).filter((l) => l.level != null).sort((a, b) => a.level - b.level)
    .map((l) => { const a = achieved.get(l.level); const done = completed.includes(l.level) || !!a || (currentael != null && l.level <= currentael); return { kind: "ael", level: l.level, name: l.name, achieved: done, achievedAt: a ? toIso(first(a.achievedon, a.date, a.created)) : null, source: a ? first(a.source, a.stagename, a.queuename) : null, isCurrent: l.level === currentael }; });
  const wishlist = newestFirst((raw.wishlist || []).map((w) => ({ kind: "wishlist", id: w.id, questionid: refId(first(w.questionref, w.questionid)), question: first(w.question, w.questiontext), answer: first(w.answer, w.wish, w.text), date: toIso(first(w.date, w.created)) })), "date");
  const all = [...mappings, ...levels, ...wishlist];
  const total = all.length;
  const items = all.slice(0, limit);
  const live = mappings.find((m) => m.live) || mappings[0] || null;
  const curName = levels.find((l) => l.isCurrent)?.name ?? null;
  return envelope({
    now,
    summary: {
      headline: total || currentael != null
        ? `AEL level ${currentael ?? "?"}${curName ? ` (${curName})` : ""}, ${completed.length} completed · ${plural(mappings.length, "evolution mapping")}${live ? ` (live: "${live.title || live.id}", ${live.counts.videos} videos)` : ""} · ${plural(wishlist.length, "wishlist entry")}`
        : "No evolution mapping on record for this profile.",
      currentael, currentLevelName: curName, completedael: completed, crossovermetric: num(pmd.crossovermetric), extendedlifeimpact: num(pmd.extendedlifeimpact),
      liveMappingId: live?.id ?? null, liveMappingTitle: live?.title ?? null,
      lastVideoAt: newestFirst(videos, "created")[0]?.created ?? null, lastWishlistAt: wishlist[0]?.date ?? null,
    },
    counts: { total, mappings: mappings.length, videos: videos.filter((v) => !v.deleted).length, videosDeleted: videos.filter((v) => v.deleted).length, aelLevels: levels.length, aelAchieved: levels.filter((l) => l.achieved).length, wishlist: wishlist.length },
    items,
  });
}

async function load(profileid, opts = {}) {
  const [pmd, mappings, videos, levels, ael, wishlist] = await Promise.all([
    docById(C.PMD, profileid),
    docsOf(C.LIVE_EVOLUTION, (c) => c.where("profileid", "==", profileid)),
    docsOf(C.EVOLUTION_VIDEO, (c) => c.where("profileid", "==", profileid)),
    docsOf(C.AEL_LEVELS),
    docsOf(C.PARTICIPANT_AEL, (c) => c.where("profileid", "==", profileid)).catch(() => []),
    docsOf(C.WISHLIST_LOG, (c) => c.where("profileid", "==", profileid)).catch(() => []),
  ]);
  if (!mappings.length && !videos.length && !ael.length && !wishlist.length && pmd?.currentael == null) return emptyEnvelope("No evolution mapping on record for this profile.", parseOptions(opts).now);
  return project({ pmd, mappings, videos, levels, ael, wishlist }, opts);
}

module.exports = Object.freeze({
  name: "evolutionMapping",
  description: "Configured evolution mappings and their videos, the accelerated-evolution (AEL) level ladder with what the participant achieved and when, and their evolution wishlist entries.",
  input_schema: PARTICIPANT_INPUT_SCHEMA,
  sources: [C.PMD.name, C.LIVE_EVOLUTION.name, C.EVOLUTION_VIDEO.name, C.AEL_LEVELS.name, C.PARTICIPANT_AEL.name, C.WISHLIST_LOG.name],
  handler: (input, ctx = {}) => load(input.profileid, { ...input, now: ctx.now }),
  load, project,
});
