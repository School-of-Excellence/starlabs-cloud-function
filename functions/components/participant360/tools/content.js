/**
 * content — recent content activity: what the participant is consuming right now and lately.
 *
 * Reads: content analytics (profileid; written by mobile/backend, read-only here; type =
 * solarvoice | eiflixcontent | …) · episodes (duration/series) · participant workshop · tier access config.
 */
const { C, docsOf, getAllByRef } = require("../collection");
const {
  withFilter, envelope, emptyEnvelope, parseOptions,
  toIso, toMs, refId, plural, newestFirst, sinceFilter, tally, tallyText,
} = require("../envelope");

function projectActivity(r, episodes) {
  const id = refId(r.videoid) || null;
  const ep = episodes.get(`episodes/${id}`) || null;
  const dur = Number(ep?.duration) || null, spent = Number(r.totaltimespend) || 0;
  return {
    kind: "activity", logdate: toIso(r.logdate), videoid: id, videoname: r.videoname ?? ep?.title ?? null,
    type: r.type ?? null, playlistid: refId(r.playlistid), playlistTitle: r.playlisttitle ?? null,
    series: Array.isArray(ep?.series) ? ep.series.map(refId).join(", ") || null : refId(ep?.series) ?? null,
    durationSec: dur, totaltimespend: spent, completionPct: dur ? Math.min(100, Math.round((spent / dur) * 100)) : null,
  };
}

function projectWorkshop(w) {
  return { kind: "workshop", workshopid: refId(w.workshopref) ?? w.workshopid ?? w.id, name: w.name ?? w.workshopname ?? null, status: w.status ?? null, enrolledAt: toIso(w.enrolledon ?? w.created ?? w.date), lastActivity: toIso(w.updated ?? w.lastactivity) };
}

/** Pure projection. raw = { analytics[], episodes: Map, workshops[], tier } */
function project(raw, opts = {}) {
  const { limit, since, now } = parseOptions(opts);
  const typeFilter = opts.type ? String(opts.type).toLowerCase() : null;
  const episodes = raw.episodes || new Map();
  const acts = newestFirst((raw.analytics || []).map((r) => projectActivity(r, episodes)), "logdate");
  const workshops = (raw.workshops || []).map(projectWorkshop);
  let items = [...(typeFilter ? acts.filter((a) => (a.type || "").toLowerCase() === typeFilter) : acts), ...(typeFilter ? [] : workshops)];
  const total = items.length;
  items = sinceFilter(items, "logdate", since).slice(0, limit);
  const cur = acts[0] || null;
  const d30 = now.getTime() - 30 * 86_400_000;
  const recent = acts.filter((a) => toMs(a.logdate) != null && toMs(a.logdate) >= d30);
  const secs = (arr) => arr.reduce((s, a) => s + a.totaltimespend, 0);
  const tt = tally(acts, "type");
  const tier = raw.tier || null;
  return envelope({
    now,
    summary: {
      headline: acts.length
        ? `Currently on "${cur.videoname || cur.videoid}" (${cur.type || "?"}, ${cur.completionPct != null ? cur.completionPct + "% " : ""}last ${cur.logdate?.slice(0, 10)}) · last 30 days: ${plural(recent.length, "play")}, ${Math.round(secs(recent) / 60)} min, ${new Set(recent.map((a) => a.logdate?.slice(0, 10))).size} active days · all-time ${tallyText(tt)}`
        : "No content activity on record for this profile.",
      currentVideoid: cur?.videoid ?? null, currentVideoname: cur?.videoname ?? null, currentType: cur?.type ?? null, currentPlaylistid: cur?.playlistid ?? null, lastActivity: cur?.logdate ?? null,
      totalPlays: acts.length, totalSeconds: secs(acts), last30dPlays: recent.length, last30dSeconds: secs(recent), last30dActiveDays: new Set(recent.map((a) => a.logdate?.slice(0, 10))).size,
      tierid: tier?.id ?? null, tier: tier?.tier ?? tier?.name ?? null,
    },
    counts: { total, eiflixcontent: tt.eiflixcontent || 0, solarvoice: tt.solarvoice || 0, other: acts.length - (tt.eiflixcontent || 0) - (tt.solarvoice || 0), workshops: workshops.length },
    items,
  });
}

async function load(profileid, opts = {}) {
  const [analytics, workshops] = await Promise.all([
    docsOf(C.CONTENT_ANALYTICS, (c) => c.where("profileid", "==", profileid).orderBy("logdate", "desc").limit(1000)).catch(() => docsOf(C.CONTENT_ANALYTICS, (c) => c.where("profileid", "==", profileid).limit(1000))),
    docsOf(C.PARTICIPANT_WORKSHOP, (c) => c.where("profileid", "==", profileid)).catch(() => []),
  ]);
  if (!analytics.length && !workshops.length) return emptyEnvelope("No content activity on record for this profile.", parseOptions(opts).now);
  const ids = [...new Set(analytics.map((r) => refId(r.videoid)).filter(Boolean))].slice(0, 300);
  const episodes = await getAllByRef(ids.map((id) => `episodes/${id}`));
  return project({ analytics, episodes, workshops, tier: null }, opts);
}

module.exports = Object.freeze({
  name: "content",
  description: "Recent content activity: what the participant is consuming right now, the last plays, time spent by type (eiflixcontent | solarvoice), 30-day activity and workshop enrolments. Filter type=… NOT for recommended playlists (use recommendation).",
  input_schema: withFilter("type", { type: "string", enum: ["eiflixcontent", "solarvoice"] }),
  sources: [C.CONTENT_ANALYTICS.name, C.EPISODES.name, C.PARTICIPANT_WORKSHOP.name],
  handler: (input, ctx = {}) => load(input.profileid, { ...input, now: ctx.now }),
  load, project,
});
