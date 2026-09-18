/**
 * participant360/envelope.js — pure projection helpers + the one response shape.
 *
 * Nothing here touches Firestore. Every tool returns
 *   { ok, version, generatedAt, data: { summary, counts, items } }
 * where `summary`, `counts`, `items` are the static keys and their contents are tool-specific.
 * Reserved keys inside them: summary.headline (string), counts.total / counts.returned (int),
 * items[].kind (only when a tool mixes record types).
 */
const VERSION = 1;
const MS_PER_DAY = 86_400_000;

/** Input schema shared by every tool (Messages API `input_schema` shape). */
const PARTICIPANT_INPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    profileid: {
      type: "string",
      description: "profile_data document id of the participant. Resolve an email/phone first with `resolve`.",
    },
    limit: { type: "integer", minimum: 1, maximum: 100, description: "Max items to return, newest first. Default 20." },
    since: { type: "string", description: "ISO date; only items on/after this date." },
  },
  required: ["profileid"],
  additionalProperties: false,
});

/** Extends the shared schema with one tool-specific filter. */
function withFilter(name, schema) {
  return Object.freeze({
    ...PARTICIPANT_INPUT_SCHEMA,
    properties: { ...PARTICIPANT_INPUT_SCHEMA.properties, [name]: schema },
  });
}

/** Firestore Timestamp | Date | {seconds} | ISO string | null -> ISO string | null. */
function toIso(v) {
  if (v == null) return null;
  if (typeof v.toDate === "function") return v.toDate().toISOString();
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString();
  if (typeof v === "object" && typeof v.seconds === "number") return new Date(v.seconds * 1000).toISOString();
  if (typeof v === "string") {
    const d = new Date(v);
    return isNaN(d) ? null : d.toISOString();
  }
  return null;
}

function toMs(v) {
  const iso = toIso(v);
  return iso ? new Date(iso).getTime() : null;
}

/** YYYY-MM-DD for headlines. */
function toDay(v) {
  const iso = toIso(v);
  return iso ? iso.slice(0, 10) : null;
}

/** Whole days from `now` to `v` (negative in the past); null when unknown. */
function daysUntil(v, now = new Date()) {
  const ms = toMs(v);
  return ms == null ? null : Math.ceil((ms - now.getTime()) / MS_PER_DAY);
}

/** DocumentReference | "a/b" | null -> id | null. */
function refId(ref) {
  if (!ref) return null;
  if (typeof ref === "string") return ref.split("/").pop();
  return ref.id || null;
}

/** DocumentReference | "a/b" | null -> path | null. */
function refPath(ref) {
  if (!ref) return null;
  if (typeof ref === "string") return ref;
  return ref.path || null;
}

/** Firestore status conventions: null / "" means not started. */
function normalizeStatus(s) {
  if (s == null || s === "") return "not_started";
  return String(s).trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/** { value: n } for `key` across `rows`, sorted by n desc. */
function tally(rows, key) {
  const out = {};
  for (const r of rows) {
    const v = r[key] == null ? "null" : String(r[key]);
    out[v] = (out[v] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

/** "2 completed, 1 ongoing" from a tally. */
function tallyText(t) {
  const parts = Object.entries(t).map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`);
  return parts.length ? parts.join(", ") : "none";
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Sort newest-first by an ISO field, then cap. */
function newestFirst(items, field, limit) {
  const sorted = [...items].sort((a, b) => (b[field] || "").localeCompare(a[field] || ""));
  return typeof limit === "number" ? sorted.slice(0, limit) : sorted;
}

/** Keep rows whose ISO `field` is on/after `since` (ISO); no-op when since is null. */
function sinceFilter(items, field, since) {
  const ms = toMs(since);
  if (ms == null) return items;
  return items.filter((r) => {
    const t = toMs(r[field]);
    return t != null && t >= ms;
  });
}

/** Parses/normalises the shared options. */
function parseOptions(input = {}, defaults = {}) {
  const limit = Number.parseInt(input.limit, 10);
  return {
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : defaults.limit || 20,
    since: toIso(input.since),
    now: input.now instanceof Date ? input.now : new Date(),
  };
}

/** The one response shape. `counts.total` = how many exist, `counts.returned` = items.length. */
function envelope({ summary, counts, items, now = new Date() }) {
  const safeItems = Array.isArray(items) ? items : [];
  return {
    ok: true,
    version: VERSION,
    generatedAt: now.toISOString(),
    data: {
      summary: { headline: "", ...(summary || {}) },
      counts: { total: safeItems.length, ...(counts || {}), returned: safeItems.length },
      items: safeItems,
    },
  };
}

/** Empty response with a headline, for "nothing on record" / unavailable sources. */
function emptyEnvelope(headline, now, extraSummary = {}, extraCounts = {}) {
  return envelope({ summary: { headline, ...extraSummary }, counts: { total: 0, ...extraCounts }, items: [], now });
}

module.exports = {
  VERSION,
  PARTICIPANT_INPUT_SCHEMA,
  withFilter,
  envelope,
  emptyEnvelope,
  parseOptions,
  toIso,
  toMs,
  toDay,
  daysUntil,
  refId,
  refPath,
  normalizeStatus,
  tally,
  tallyText,
  plural,
  newestFirst,
  sinceFilter,
};
