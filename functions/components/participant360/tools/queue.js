/**
 * queue — every queue token the participant holds/held, with stage history and activity.
 *
 * Reads: queue_token (profile_id) · queue stage log (profile_id; row.docid == token doc id, logdate = move time,
 *   movedby / movedthrough — confirmed on starlabs-test) · queue activity log
 * (participantid) · queue generation / queue variation (names) · live assignment (status, stagename,
 * stagetype, pairing ONLY — no ATC fields are projected) · cohorts queue planner.
 *
 * STRUCTURAL FENCE: this file never opens firestore-atc and never follows an atc ref. `atcmodel` on
 * the activity log is a label from reference config and is passed through as a string only.
 *
 * Derived `status` (raw tokenstatus/currentstage kept alongside) — mapping to be confirmed on data:
 *   tokenstatus cancelled|transferred|completed|delivered -> that word
 *   stage looks like "request*"                            -> requested
 *   token active with a live assignment / studio           -> going
 *   token active otherwise                                 -> attended (past stage completed, waiting for next)
 */
const { C, docsOf, getAllByRef } = require("../collection");
const {
  PARTICIPANT_INPUT_SCHEMA, envelope, emptyEnvelope, parseOptions,
  toIso, toMs, refId, refPath, normalizeStatus, plural, newestFirst, tally, tallyText,
} = require("../envelope");

// Operator vocabulary: requested | going | attended | transferred | cancelled. A completed/delivered token = attended.
const TERMINAL = { cancelled: "cancelled", canceled: "cancelled", transferred: "transferred", transfer: "transferred", completed: "attended", delivered: "attended", complete: "attended", attended: "attended" };
const ACTIVE_STATUS = new Set(["active", "ongoing", "inprogress", "in_progress", "approved"]);

function deriveStatus(t, la) {
  const ts = normalizeStatus(t.tokenstatus);
  if (TERMINAL[ts]) return TERMINAL[ts];
  if (/request|yet to start|not started/i.test(String(t.currentstage || ""))) return "requested";
  if (t.liveassignmentid || t.studioid || (la && normalizeStatus(la.status) !== "completed")) return "going";
  if (ACTIVE_STATUS.has(ts) || ts === "not_started") return "going";
  return "attended";
}

function projectToken(t, names, stageLogs, activities, las, planners, now) {
  // real rows: docid == the token document id (logdocid is the log row's own id); logdate = when the move happened
  const history = stageLogs.filter((l) => l.docid === t.id || l.logdocid === t.id || refId(l.tokenref) === t.id)
    .map((l) => ({ createdon: toIso(l.logdate ?? l.createdon), previousstage: l.previousstage ?? null, currentstage: l.currentstage ?? null, manuallymoved: l.manuallymoved === true, movedby: refId(l.movedby) ?? null, movedthrough: l.movedthrough ?? null, stagestatus: l.stagestatus ?? null }))
    .sort((a, b) => (a.createdon || "").localeCompare(b.createdon || ""));
  const qId = refId(t.queueref);
  const acts = activities.filter((a) => refId(a.queueid) === qId || refId(a.queueref) === qId)
    .map((a) => ({ activitydate: toIso(a.activitydate), activity: a.activity ?? null, atcmodel: typeof a.atcmodel === "string" ? a.atcmodel : null, sourceref: refPath(a.sourceref) }))
    .sort((a, b) => (b.activitydate || "").localeCompare(a.activitydate || ""));
  const la = t.liveassignmentid ? las.get(String(t.liveassignmentid)) || null : null;
  const slots = planners.filter((p) => refId(p.queueid) === qId).flatMap((p) => (p.selectedslots || []).map((s) => ({ queueid: qId, slot: typeof s === "string" ? s : toIso(s) })));
  const qDoc = names.get(refPath(t.queueref)), vDoc = t.variationid ? names.get(`queue variation/${refId(t.variationid)}`) : null;
  const lastChange = history.length ? history[history.length - 1].createdon : toIso(t.logdate || t.modified || t.createdon || t.created);
  const status = deriveStatus(t, la);
  return {
    tokenid: t.id, queueref: refPath(t.queueref), queuename: qDoc ? qDoc.queuename || qDoc.name || null : null,
    variationid: refId(t.variationid), variationname: vDoc ? vDoc.variationname || null : null,
    productref: refPath(t.productref), participantproductid: refId(t.participantproductid),
    tokenstatus: t.tokenstatus ?? null, stagestatus: t.stagestatus ?? null, tokennumber: t.tokennumber ?? null, queueposition: t.queueposition ?? null,
    productname: t.productname ?? null, currentstage: t.currentstage ?? null, previousstage: t.previousstage ?? null,
    status, isActive: !TERMINAL[normalizeStatus(t.tokenstatus)],
    enteredAt: toIso(t.createdon) ?? history[0]?.createdon ?? toIso(t.created), lastStageChange: lastChange,
    daysInCurrentStage: !TERMINAL[normalizeStatus(t.tokenstatus)] && lastChange ? Math.floor((now.getTime() - toMs(lastChange)) / 86_400_000) : null,
    liveassignmentid: t.liveassignmentid ?? null, studioid: t.studioid ?? null,
    studio: la ? { status: la.status ?? null, stagename: la.stagename ?? null, stagetype: la.stagetype ?? null, pairing: Array.isArray(la.pairing) ? la.pairing.map(refId) : [] } : null,
    counts: { stageMoves: history.length, activities: acts.length, plannerSlots: slots.length },
    stageHistory: history, activityLog: acts, plannerSlots: slots,
  };
}

/** Pure projection. raw = { tokens[], stageLogs[], activities[], names: Map, liveAssignments: Map, planners[] } */
function project(raw, opts = {}) {
  const { limit, now } = parseOptions(opts);
  let tokens = (raw.tokens || []).map((t) => projectToken(t, raw.names || new Map(), raw.stageLogs || [], raw.activities || [], raw.liveAssignments || new Map(), raw.planners || [], now));
  tokens.sort((a, b) => (a.isActive !== b.isActive ? (a.isActive ? -1 : 1) : (b.lastStageChange || "").localeCompare(a.lastStageChange || "")));
  const total = tokens.length;
  const items = tokens.slice(0, limit);
  const t = tally(tokens, "status");
  const active = tokens.find((x) => x.isActive) || null;
  const nextSlot = tokens.flatMap((x) => x.plannerSlots.map((s) => s.slot)).filter((s) => s && s >= now.toISOString().slice(0, 16)).sort()[0] ?? null;
  return envelope({
    now,
    summary: {
      headline: total
        ? (active ? `In queue ${active.queuename || active.queueref} at stage "${active.currentstage}" (${active.status}${active.daysInCurrentStage != null ? `, ${active.daysInCurrentStage} days in stage` : ""}${active.studio ? `, studio ${active.studio.status}` : ""})` : "No active queue token") + ` · ${plural(total, "token")}: ${tallyText(t)}`
        : "No queue tokens on record for this profile.",
      activeTokenId: active?.tokenid ?? null, activeQueueName: active?.queuename ?? null, activeVariationName: active?.variationname ?? null,
      activeStage: active?.currentstage ?? null, activeStatus: active?.status ?? null, activeSince: active?.enteredAt ?? null,
      lastStageChange: active?.lastStageChange ?? null, studioStatus: active?.studio?.status ?? null, nextPlannerSlot: nextSlot,
    },
    counts: {
      total, requested: t.requested || 0, going: t.going || 0, attended: t.attended || 0, transferred: t.transferred || 0, cancelled: t.cancelled || 0, completed: t.completed || 0,
      stageMoves: tokens.reduce((a, x) => a + x.counts.stageMoves, 0), activities: tokens.reduce((a, x) => a + x.counts.activities, 0), plannerSlots: tokens.reduce((a, x) => a + x.counts.plannerSlots, 0),
    },
    items,
  });
}

async function load(profileid, opts = {}) {
  const [tokens, stageLogs, activities, planners] = await Promise.all([
    docsOf(C.QUEUE_TOKEN, (c) => c.where("profile_id", "==", profileid)),
    docsOf(C.QUEUE_STAGE_LOG, (c) => c.where("profile_id", "==", profileid)),
    docsOf(C.QUEUE_ACTIVITY_LOG, (c) => c.where("participantid", "==", profileid)),
    docsOf(C.QUEUE_PLANNER, (c) => c.where("profileid", "==", profileid)),
  ]);
  if (!tokens.length) return emptyEnvelope("No queue tokens on record for this profile.", parseOptions(opts).now);
  const refs = [];
  for (const t of tokens) { refs.push(t.queueref); if (t.variationid) refs.push(`queue variation/${refId(t.variationid)}`); if (t.liveassignmentid) refs.push(`live assignment/${t.liveassignmentid}`); }
  const docs = await getAllByRef(refs);
  const liveAssignments = new Map();
  for (const [path, d] of docs) if (path.startsWith("live assignment/") && d) liveAssignments.set(d.id, d);
  return project({ tokens, stageLogs, activities, names: docs, liveAssignments, planners }, opts);
}

module.exports = Object.freeze({
  name: "queue",
  description: "Every queue token the participant requested, is going through, attended, was transferred from or cancelled — current stage, full stage history, activity log, studio status (token level only; never ATC content). NOT for 1:1 appointments (use appointment).",
  input_schema: PARTICIPANT_INPUT_SCHEMA,
  sources: [C.QUEUE_TOKEN.name, C.QUEUE_STAGE_LOG.name, C.QUEUE_ACTIVITY_LOG.name, C.QUEUE_GENERATION.name, C.QUEUE_VARIATION.name, C.LIVE_ASSIGNMENT.name, C.QUEUE_PLANNER.name],
  handler: (input, ctx = {}) => load(input.profileid, { ...input, now: ctx.now }),
  load, project, deriveStatus,
});
