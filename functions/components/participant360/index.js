/**
 * participant360/index.js — tool registry, runner, and the HTTP front door.
 *
 * Registry: one entry per tool { name, description, input_schema, sources, handler } — the first
 * three are exactly what the Messages API `tools` param takes, so an AI agent and the HTTP route run
 * the SAME handlers. A tool cannot be declared without being runnable, or vice versa.
 *
 * HTTP:  GET /participant360                      -> tool catalogue
 *        GET /participant360/resolve/{key}        -> { profileid, email, name }
 *        GET /participant360/{tool}/{profileid}?limit=&since=&<filter>=
 *        Authorization: Bearer <Firebase ID token>; caller must hold admin | ah | developer.
 * Response: { ok, version, generatedAt, data: { summary, counts, items } }
 */
const { onRequest } = require("firebase-functions/v2/https");
const { C, col, getAllByRef, admin, WATSON_SERVICE_ACCOUNT } = require("./collection");
const { VERSION, refPath } = require("./envelope");
const { resolveParticipant, resolveTool } = require("./resolve");

const TOOLS = Object.freeze([
  require("./tools/purchase"),
  require("./tools/finance"),
  require("./tools/activeProduct"),
  require("./tools/forms"),
  require("./tools/appointment"),
  require("./tools/queue"),
  require("./tools/events"),
  require("./tools/communication"),
  require("./tools/recommendation"),
  require("./tools/content"),
  require("./tools/mode"),
  require("./tools/roles"),
  require("./tools/videoAsk"),
  require("./tools/evolutionMapping"),
  require("./tools/systemBilling"),
  require("./tools/profileAuthentication"),
]);
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
const ALLOWED_ROLES = Object.freeze(["admin", "ah", "developer"]);

/** The `tools` array for messages.create() — handlers stripped; includes `resolve`. */
function toolDefinitions() {
  return [resolveTool, ...TOOLS].map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}

/**
 * Single-router tool definition: ONE Messages-API tool named "participant360" that takes { tool, participantid }
 * and dispatches to the 16 readers. Use this when the agent should see one tool instead of sixteen;
 * runRouterTool() executes it. (toolDefinitions() remains the 16-separate-tools form.)
 */
function routerToolDefinition() {
  const names = TOOLS.map((t) => t.name);
  const filters = Object.fromEntries(TOOLS.flatMap((t) => Object.entries(t.input_schema.properties).filter(([k]) => !["profileid", "limit", "since"].includes(k))));
  return {
    name: "participant360",
    description: "Read one participant's data by topic. Pick the tool for the question: " + TOOLS.map((t) => t.name + " — " + t.description.split(".")[0]).join("; ") + ". Resolve an email or phone to a participantid first with the resolve tool.",
    input_schema: {
      type: "object",
      properties: {
        tool: { type: "string", enum: names, description: "Which topic to read: " + names.join(" | ") },
        participantid: { type: "string", description: "StarLabs profileid (profile_data document id). If you only have an email or phone, call resolve first." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max items to return, newest first. Default 20." },
        since: { type: "string", description: "ISO date; only items on/after this date (tools with time-ordered items)." },
        ...Object.fromEntries(Object.entries(filters).map(([k, v]) => [k, { ...v, description: (v.description ? v.description + " " : "") + "Optional filter; only used by the tool(s) that declare it." }])),
      },
      required: ["tool", "participantid"],
      additionalProperties: false,
    },
  };
}

/** Executes a call made through the single-router definition. Same outcome shape as runTool(). */
function runRouterTool(input = {}, ctx = {}) {
  const { tool, participantid, ...rest } = input || {};
  if (typeof tool !== "string" || !tool) return failure("bad_request", { message: "tool is required", tools: TOOLS.map((t) => t.name) });
  return runTool(tool, { ...rest, profileid: participantid }, ctx);
}

/** Catalogue for GET /participant360. */
function catalogue() {
  return { ok: true, version: VERSION, tools: TOOLS.map((t) => ({ name: t.name, description: t.description, sources: t.sources, filters: Object.keys(t.input_schema.properties).filter((k) => !["profileid", "limit", "since"].includes(k)) })) };
}

function failure(error, extra = {}) {
  return { ok: false, error, ...extra };
}

/** Validates the locked shape so a tool that drifts fails its own call, not the caller. */
function assertShape(result) {
  const d = result && result.data;
  if (!d || typeof d.summary !== "object" || typeof d.summary.headline !== "string" || typeof d.counts !== "object" || !Number.isInteger(d.counts.total) || !Number.isInteger(d.counts.returned) || !Array.isArray(d.items)) {
    throw new Error("tool returned an invalid envelope (summary.headline / counts.total / counts.returned / items required)");
  }
  if (d.counts.returned !== d.items.length) throw new Error(`counts.returned (${d.counts.returned}) != items.length (${d.items.length})`);
  return result;
}

/**
 * Runs one tool. Never throws: failures come back as { ok:false, error } so the caller (HTTP route or
 * agent loop) can report them without dying. `ctx.participant` (from resolve) is passed to tools that
 * need email/uid/phone (finance, communication, systemBilling); `ctx.audit` receives a record per call.
 */
async function runTool(name, input = {}, ctx = {}) {
  if (name === resolveTool.name) return { ok: true, result: await resolveTool.handler(input) };
  const tool = BY_NAME.get(name);
  if (!tool) return failure("unknown_tool", { message: `no tool named '${name}'`, tools: TOOLS.map((t) => t.name) });
  const profileid = typeof input.profileid === "string" ? input.profileid.trim() : "";
  if (!profileid) return failure("bad_request", { message: "profileid is required" });

  const started = Date.now();
  let outcome;
  try {
    const participant = ctx.participant || (await resolveParticipant(profileid));
    if (!participant) outcome = failure("participant_not_found", { participantid: profileid });
    else outcome = { ok: true, result: assertShape(await tool.handler({ ...input, profileid: participant.profileid }, { ...ctx, participant })) };
  } catch (err) {
    console.error(`[participant360] tool ${name} failed for ${profileid}:`, err && err.stack ? err.stack : err);
    outcome = failure("internal", { message: err && err.message });
  }
  if (typeof ctx.audit === "function") {
    try { await ctx.audit({ tool: name, profileid, ok: outcome.ok, ms: Date.now() - started, ...(outcome.ok ? {} : { error: outcome.error }) }); }
    catch (err) { console.error("[participant360] audit failed", err && err.message); }
  }
  return outcome;
}

/** Wraps a runTool() outcome as the tool_result content block the Messages API expects. */
function toToolResult(toolUseId, outcome) {
  return { type: "tool_result", tool_use_id: toolUseId, content: JSON.stringify(outcome.ok ? outcome.result : { error: outcome.error, ...outcome }), ...(outcome.ok ? {} : { is_error: true }) };
}

// ─── HTTP guard ──────────────────────────────────────────────────────────────────────────────────
async function requireRole(req) {
  const hdr = req.get("Authorization") || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7).trim() : null;
  if (!token) return { status: 401, body: failure("unauthenticated", { message: "missing Bearer token" }) };
  let decoded;
  try { decoded = await admin.auth().verifyIdToken(token); }
  catch { return { status: 401, body: failure("unauthenticated", { message: "invalid or expired token" }) }; }

  // caller's profile -> role_ref -> users_roles: the same chain AuthguardService.getRoles() walks.
  const userRef = col(C.USER_DATA).doc(decoded.uid);
  let snap = await col(C.PROFILE).where("user_ref", "==", userRef).limit(1).get();
  if (snap.empty && decoded.email) snap = await col(C.PROFILE).where("email", "==", decoded.email).limit(1).get();
  if (snap.empty) return { status: 403, body: failure("forbidden", { message: "no profile for caller", requiredRoles: ALLOWED_ROLES }) };
  const roleRef = snap.docs[0].get("role_ref");
  const roles = roleRef ? (await getAllByRef([roleRef])).get(refPath(roleRef)) || {} : {};
  const granted = ALLOWED_ROLES.filter((r) => roles[r] === true);
  if (!granted.length) return { status: 403, body: failure("forbidden", { message: "role not allowed", requiredRoles: ALLOWED_ROLES }) };
  return { caller: { uid: decoded.uid, email: decoded.email || null, profileid: snap.docs[0].id, roles: granted } };
}

const STATUS = { bad_request: 400, unauthenticated: 401, forbidden: 403, unknown_tool: 404, participant_not_found: 404, internal: 500 };

const participant360 = onRequest({ cors: true, secrets: [WATSON_SERVICE_ACCOUNT], memory: "512MiB", timeoutSeconds: 60 }, async (req, res) => {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json(failure("method_not_allowed"));
  const [tool, key] = req.path.split("/").filter(Boolean).map(decodeURIComponent);
  if (!tool) return res.status(200).json(catalogue());

  const auth = await requireRole(req);
  if (auth.status) return res.status(auth.status).json(auth.body);

  const query = { ...(req.query || {}), ...(req.method === "POST" && req.body && typeof req.body === "object" ? req.body : {}) };
  if (tool === resolveTool.name) {
    const p = await resolveParticipant(key || query.key);
    return p ? res.status(200).json({ ok: true, profileid: p.profileid, email: p.email, name: p.name }) : res.status(404).json(failure("participant_not_found", { key: key || query.key }));
  }
  if (!BY_NAME.has(tool)) return res.status(404).json(failure("unknown_tool", { message: `no tool named '${tool}'`, tools: TOOLS.map((t) => t.name) }));
  const profileid = key || query.profileid;
  if (!profileid) return res.status(400).json(failure("bad_request", { message: "participantid missing: /participant360/{tool}/{participantid}" }));

  const participant = await resolveParticipant(profileid);
  if (!participant) return res.status(404).json(failure("participant_not_found", { participantid: profileid }));

  const { limit, since, ...filters } = query;
  const outcome = await runTool(tool, { ...filters, profileid: participant.profileid, limit, since }, {
    participant,
    audit: (rec) => console.log("[participant360]", JSON.stringify({ ...rec, caller: auth.caller.profileid, requestId: req.get("X-Request-Id") || null })),
  });
  if (!outcome.ok) return res.status(STATUS[outcome.error] || 500).json(outcome);
  res.set("Cache-Control", "no-store");
  return res.status(200).json(outcome.result);
});

module.exports = { participant360, TOOLS, toolDefinitions, routerToolDefinition, runRouterTool, catalogue, runTool, toToolResult, assertShape, requireRole, ALLOWED_ROLES };
