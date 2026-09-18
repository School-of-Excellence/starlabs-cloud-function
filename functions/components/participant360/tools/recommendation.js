/**
 * recommendation — personal and mode-based recommended playlists with per-video progress, plus
 * recommended procedures.
 *
 * Reads: participant metadata (playlist -> video-id map per type, written by RecommendedPlaylistTrigger_to_pmd)
 * · recommended mix playlist (profileid; list[], personalised, type, date) · content analytics (progress
 * per videoid) · episodes (titles) · procedure_recommend / procedures.
 */
const { C, docsOf, docById, getAllByRef, stripHidden } = require("../collection");
const {
  PARTICIPANT_INPUT_SCHEMA, envelope, emptyEnvelope, parseOptions,
  toIso, refId, refPath, plural, newestFirst, tally, tallyText,
} = require("../envelope");

const COMPLETE_RATIO = 0.9;

/** content analytics rows -> Map(videoid -> { totaltimespend, lastWatched }) */
function progressMap(rows) {
  const m = new Map();
  for (const r of rows || []) {
    const id = refId(r.videoid) || r.videoname;
    if (!id) continue;
    const cur = m.get(id) || { totaltimespend: 0, lastWatched: null };
    cur.totaltimespend += Number(r.totaltimespend) || 0;
    const t = toIso(r.logdate);
    if (t && (!cur.lastWatched || t > cur.lastWatched)) cur.lastWatched = t;
    m.set(id, cur);
  }
  return m;
}

function projectVideo(entry, progress, episodes) {
  const id = typeof entry === "string" ? entry : refId(entry?.id ?? entry?.videoid ?? entry?.ref);
  const ep = episodes.get(`episodes/${id}`) || null;
  const p = progress.get(id) || { totaltimespend: 0, lastWatched: null };
  const duration = Number(ep?.duration ?? entry?.duration) || null;
  const status = p.totaltimespend === 0 ? "notStarted" : duration && p.totaltimespend >= duration * COMPLETE_RATIO ? "completed" : "inProgress";
  return { videoid: id, title: entry?.title ?? ep?.title ?? null, type: entry?.type ?? (String(id).startsWith("sv_") ? "solarvoice" : "eiflixcontent"), totaltimespend: p.totaltimespend, lastWatched: p.lastWatched, status };
}

function projectPlaylist(pl, progress, episodes) {
  const videos = (pl.list || []).map((e) => projectVideo(e, progress, episodes));
  const t = tally(videos, "status");
  const done = t.completed || 0;
  return {
    kind: pl.personalised === true ? "personal" : "modeBased",
    playlistid: pl.id, procedureid: null, title: pl.title ?? null, type: pl.type ?? null, mode: pl.mode ?? pl.participantmode ?? null,
    date: toIso(pl.date), bufferdocref: refPath(pl.bufferdocref), personalised: pl.personalised === true,
    progressPct: videos.length ? Math.round((done / videos.length) * 100) : 0,
    counts: { videos: videos.length, completed: done, inProgress: t.inProgress || 0, notStarted: t.notStarted || 0 },
    videos,
  };
}

function projectProcedure(pr, procedures) {
  const d = procedures.get(refPath(pr.procedureref)) || null;
  return {
    kind: "procedure", playlistid: null, procedureid: refId(pr.procedureref) ?? pr.procedureid ?? pr.id,
    title: d?.name ?? d?.title ?? pr.name ?? null, type: "procedure", mode: pr.mode ?? null, date: toIso(pr.date ?? pr.created ?? pr.recommendedAt),
    bufferdocref: null, personalised: false, progressPct: pr.completed === true ? 100 : 0,
    counts: { videos: 0, completed: 0, inProgress: 0, notStarted: 0 }, videos: [],
  };
}

/** Pure projection. raw = { pmd, playlists[], analytics[], episodes: Map, procedureRecs[], procedures: Map } */
function project(raw, opts = {}) {
  const { limit, now } = parseOptions(opts);
  const progress = progressMap(raw.analytics);
  const episodes = raw.episodes || new Map();
  const all = newestFirst([
    ...(raw.playlists || []).map((p) => projectPlaylist(p, progress, episodes)),
    ...(raw.procedureRecs || []).map((p) => projectProcedure(p, raw.procedures || new Map())),
  ], "date");
  const total = all.length;
  const items = all.slice(0, limit);
  const videos = all.flatMap((p) => p.videos);
  const tv = tally(videos, "status"), tk = tally(all, "kind");
  const latest = all.find((p) => p.kind !== "procedure") || null;
  const lastWatched = videos.filter((v) => v.lastWatched).sort((a, b) => b.lastWatched.localeCompare(a.lastWatched))[0] || null;
  return envelope({
    now,
    summary: {
      headline: total
        ? `${plural(total, "recommendation")} (${tallyText(tk)}); ${plural(videos.length, "video")}: ${tallyText(tv)}` + (latest ? ` · latest "${latest.title || latest.playlistid}" ${latest.progressPct}% done` : "")
        : "No recommendations on record for this profile.",
      latestPlaylistId: latest?.playlistid ?? null, latestPlaylistTitle: latest?.title ?? null, latestPlaylistDate: latest?.date ?? null,
      overallProgressPct: videos.length ? Math.round(((tv.completed || 0) / videos.length) * 100) : null,
      lastWatchedVideoid: lastWatched?.videoid ?? null, lastWatchedAt: lastWatched?.lastWatched ?? null,
    },
    counts: { total, personal: tk.personal || 0, modeBased: tk.modeBased || 0, procedures: tk.procedure || 0, videos: videos.length, videosCompleted: tv.completed || 0, videosInProgress: tv.inProgress || 0, videosNotStarted: tv.notStarted || 0 },
    items,
  });
}

async function load(profileid, opts = {}) {
  const [pmd, playlists, analytics, procedureRecs] = await Promise.all([
    docById(C.PMD, profileid).then(stripHidden),
    docsOf(C.RECOMMENDED_PLAYLIST, (c) => c.where("profileid", "==", profileid)),
    docsOf(C.CONTENT_ANALYTICS, (c) => c.where("profileid", "==", profileid).orderBy("logdate", "desc").limit(1000)).catch(() => docsOf(C.CONTENT_ANALYTICS, (c) => c.where("profileid", "==", profileid).limit(1000))),
    docsOf(C.PROCEDURE_RECOMMEND, (c) => c.where("profileid", "==", profileid)).catch(() => []),
  ]);
  if (!playlists.length && !procedureRecs.length) return emptyEnvelope("No recommendations on record for this profile.", parseOptions(opts).now);
  const videoIds = new Set(playlists.flatMap((p) => (p.list || []).map((e) => (typeof e === "string" ? e : refId(e?.id ?? e?.videoid ?? e?.ref)))).filter(Boolean));
  const [episodes, procedures] = await Promise.all([
    getAllByRef([...videoIds].slice(0, 300).map((id) => `episodes/${id}`)),
    getAllByRef(procedureRecs.map((p) => p.procedureref).filter(Boolean)),
  ]);
  return project({ pmd, playlists, analytics, episodes, procedureRecs, procedures }, opts);
}

module.exports = Object.freeze({
  name: "recommendation",
  description: "All recommended content — personal playlists and mode-based playlists — with per-video progress (notStarted | inProgress | completed), plus recommended procedures. NOT for what they watched outside recommendations (use content).",
  input_schema: PARTICIPANT_INPUT_SCHEMA,
  sources: [C.PMD.name, C.RECOMMENDED_PLAYLIST.name, C.CONTENT_ANALYTICS.name, C.EPISODES.name, C.PROCEDURE_RECOMMEND.name, C.PROCEDURES.name],
  handler: (input, ctx = {}) => load(input.profileid, { ...input, now: ctx.now }),
  load, project, progressMap,
});
