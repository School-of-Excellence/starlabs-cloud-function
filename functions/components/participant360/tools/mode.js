/**
 * mode — each product mode the participant is in and which home widgets that mode shows.
 *
 * Reads: participant metadata (participantmode, productmode[] — written by participantmode.js, the
 * mode engine; see specs/validated/02 §7) · profile_data.participantmode · modes (labels) ·
 * eiflixhomewidgets (widget config; a widget is visible when its modes[] / mode includes the
 * participant's mode) · participantmetadata exception (projection health).
 */
const { C, docsOf, docById, stripHidden } = require("../collection");
const {
  PARTICIPANT_INPUT_SCHEMA, envelope, emptyEnvelope, parseOptions,
  toIso, refId, refPath, plural, tally, tallyText,
} = require("../envelope");

const first = (...vals) => vals.find((v) => v != null && v !== "") ?? null;

function normalizeProductMode(pm) {
  if (typeof pm === "string") return { productref: null, mode: pm, since: null };
  return { productref: first(pm?.productref, pm?.product, pm?.productid), mode: first(pm?.mode, pm?.participantmode, pm?.status), since: first(pm?.date, pm?.since, pm?.updated) };
}

function widgetStatus(w, mode) {
  const modes = Array.isArray(w.modes) ? w.modes.map(String) : w.mode != null ? [String(w.mode)] : [];
  if (w.active === false || w.enabled === false) return { status: "hidden", reason: "widget disabled in config" };
  if (!modes.length) return { status: "visible", reason: "widget has no mode restriction" };
  if (modes.includes(String(mode))) return { status: w.locked === true ? "locked" : "visible", reason: `mode ${mode} listed on widget` };
  return { status: "hidden", reason: `mode ${mode} not in widget modes [${modes.join(", ")}]` };
}

/** Pure projection. raw = { pmd, profile, modes: Map(modeid -> doc), widgets[], exceptions[] } */
function project(raw, opts = {}) {
  const { limit, now } = parseOptions(opts);
  const pmd = stripHidden(raw.pmd) || {};
  const modesCfg = raw.modes || new Map();
  const cfg = (m) => (m != null ? modesCfg.get(String(m)) : null) || null;
  const label = (m) => { const d = cfg(m); return d ? d.label || d.name || d.title || d.mode || null : null; };
  const primary = first(pmd.participantmode, raw.profile?.participantmode);
  let productModes = (Array.isArray(pmd.productmode) ? pmd.productmode : []).map(normalizeProductMode).filter((m) => m.mode != null);
  if (!productModes.length && primary) productModes = [{ productref: null, mode: primary, since: null }];
  const items = productModes.map((m) => {
    const widgets = (raw.widgets || []).map((w) => {
      const { status, reason } = widgetStatus(w, m.mode);
      return { widgetid: w.id, name: first(w.name, w.title, w.widgetname, w.id), status, reason, source: "eiflixhomewidgets" };
    });
    const tw = tally(widgets, "status");
    const prodDoc = m.productref ? raw.products?.get(refPath(m.productref)) : null;
    return {
      productref: refPath(m.productref), productname: prodDoc ? prodDoc.product || prodDoc.name || null : null,
      mode: String(m.mode), modeLabel: label(m.mode), modeSequence: cfg(m.mode)?.sequence ?? null, modeInfo: cfg(m.mode)?.info || null, modeSince: toIso(m.since), isPrimary: String(m.mode) === String(primary),
      counts: { widgets: widgets.length, visible: tw.visible || 0, hidden: tw.hidden || 0, locked: tw.locked || 0 },
      widgets,
    };
  }).slice(0, limit);
  const allWidgets = items.flatMap((i) => i.widgets);
  const tw = tally(allWidgets, "status");
  const exceptions = (raw.exceptions || []).map((e) => ({ logid: e.id, err: e.err ?? null, triggerdoc: e.triggerdoc ?? null, failed: e.failed ?? null, created: toIso(e.created) }));
  return envelope({
    now,
    summary: {
      headline: primary || items.length
        ? `Mode ${primary ?? "?"}${label(primary) ? ` (${label(primary)})` : ""} · ${plural(items.length, "product mode")} · widgets: ${tallyText(tw)}` + (exceptions.length ? ` · ${plural(exceptions.length, "projection exception")}` : "")
        : "No mode on record for this profile.",
      participantmode: primary ?? null, participantmodeLabel: label(primary), lastRebuilt: toIso(pmd.updatedAt ?? pmd.updated),
      projectionHealthy: !exceptions.length && pmd.failed !== true, exceptions,
    },
    counts: { total: items.length, widgets: allWidgets.length, widgetsVisible: tw.visible || 0, widgetsHidden: tw.hidden || 0, widgetsLocked: tw.locked || 0, exceptions: exceptions.length },
    items,
  });
}

async function load(profileid, opts = {}) {
  const [pmd, profile, modeDocs, widgets, exceptions] = await Promise.all([
    docById(C.PMD, profileid),
    docById(C.PROFILE, profileid),
    docsOf(C.MODES),
    docsOf(C.HOME_WIDGETS).catch(() => []),
    docsOf(C.PMD_EXCEPTION, (c) => c.where("profileid", "==", profileid)).catch(() => []),
  ]);
  if (!pmd && !profile) return emptyEnvelope("No mode on record for this profile.", parseOptions(opts).now);
  // modes docs (starlabs-test): { docid, mode: "Event Mode", sequence: 2, info } — key by BOTH doc id and mode name
  const modes = new Map(modeDocs.flatMap((d) => [[d.id, d], ...(d.mode != null ? [[String(d.mode), d]] : [])]));
  return project({ pmd, profile, modes, widgets, exceptions }, opts);
}

module.exports = Object.freeze({
  name: "mode",
  description: "The participant's current mode per product (from the mode engine projection) and which home widgets each mode shows: visible | hidden | locked with the reason; plus projection health.",
  input_schema: PARTICIPANT_INPUT_SCHEMA,
  sources: [C.PMD.name, C.PROFILE.name, C.MODES.name, C.HOME_WIDGETS.name, C.PMD_EXCEPTION.name],
  handler: (input, ctx = {}) => load(input.profileid, { ...input, now: ctx.now }),
  load, project, widgetStatus,
});
