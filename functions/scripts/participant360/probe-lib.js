/* global process, __dirname */
/**
 * probe-lib.js — the shared, unit-testable core behind probe-purchase.js and probe-all.js.
 *
 * Everything that can be tested without Firebase lives here: argument parsing, service-account
 * validation (allow/deny lists), tool discovery, running tools through the real registry path
 * (runTool), plain-JSON conversion of raw docs, and report/summary formatting.
 *
 * Nothing in this file calls process.exit() or touches the network. Errors that should stop a probe
 * are thrown as ProbeError with an `exitCode`; the CLI wrappers translate them.
 *
 *   exit codes:  0 ok · 1 tool/participant failure · 2 usage / bad input · 3 safety refusal
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const DEFAULT_PROJECT = "starlabs-test"; // Firestore project behind the starlabs-test-19.web.app test site
const DENYLIST = Object.freeze(["fir-sample-aae4a", "watsonproduction-becde", "salesleadcrm", "launch-your-legacy-development"]);
/** Only these project ids may ever be probed. --project can pick one of them; nothing else. */
const ALLOWLIST = Object.freeze(["starlabs-test", "starlabs-test-19", "starlabs-cicd"]);
const TOOLS_DIR = path.join(__dirname, "..", "..", "components", "participant360", "tools");
/** Default folder for probe reports: functions/probe-output/ (git-ignored). */
const OUTPUT_DIR = path.join(__dirname, "..", "..", "probe-output");
/** Env vars that could steer the Admin SDK to another project via Application Default Credentials. */
const ADC_ENV = Object.freeze(["GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_CONFIG", "GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"]);

class ProbeError extends Error {
  constructor(message, exitCode = 1) { super(message); this.exitCode = exitCode; }
}

// ─── arguments ───────────────────────────────────────────────────────────────────────────────
/**
 * @param {string[]} argv          process.argv.slice(2)
 * @param {{ multiTool?: boolean }} [o]  multiTool: accept --tools a,b (probe-all) instead of --tool
 */
function parseArgs(argv, o = {}) {
  const out = { key: null, sa: null, project: DEFAULT_PROJECT, tool: "purchase", tools: null, limit: 20, since: null, outFile: null, raw: false, help: false, continueOnError: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new ProbeError(`${a} needs a value`, 2); return argv[++i]; };
    if (a === "--sa") out.sa = next();
    else if (a === "--project") out.project = next();
    else if (a === "--tool") out.tool = next();
    else if (a === "--tools" && o.multiTool) out.tools = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--limit") out.limit = Number(next());
    else if (a === "--since") out.since = next();
    else if (a === "--out") out.outFile = next();
    else if (a === "--raw") out.raw = true;
    else if (a === "--fail-fast" && o.multiTool) out.continueOnError = false;
    else if (a === "-h" || a === "--help") out.help = true;
    else if (!out.key && !a.startsWith("--")) out.key = a;
    else throw new ProbeError(`unknown argument: ${a}`, 2);
  }
  return out;
}

function expandHome(p) {
  return p && p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

// ─── service account / project safety ────────────────────────────────────────────────────────
/**
 * Resolves and validates the service-account key. Never loads any Firebase code.
 * @returns {{ sa: object, saPath: string }}
 */
function loadServiceAccount({ sa, project }, env = process.env, fsx = fs) {
  const saPath = expandHome(sa || env.STARLABS_TEST_SA || env.GOOGLE_APPLICATION_CREDENTIALS);
  if (!saPath || !fsx.existsSync(saPath)) throw new ProbeError("service-account file not found. Pass --sa <path> or set STARLABS_TEST_SA / GOOGLE_APPLICATION_CREDENTIALS.", 2);
  let key;
  try { key = JSON.parse(fsx.readFileSync(saPath, "utf8")); } catch (e) { throw new ProbeError(`service-account file is not valid JSON: ${e.message}`, 2); }
  if (!key || key.type !== "service_account" || !key.client_email || !key.private_key || !key.project_id) {
    throw new ProbeError("file is not a Firebase service-account key (needs type=service_account, project_id, client_email, private_key).", 2);
  }
  checkProject(key.project_id, project);
  return { sa: key, saPath };
}

/** Deny-list wins over everything; then the target must be allow-listed; then the key must match it. */
function checkProject(keyProjectId, requestedProject) {
  if (DENYLIST.includes(keyProjectId) || DENYLIST.includes(requestedProject)) {
    throw new ProbeError(`HARD ABORT: project '${keyProjectId}' is production/finance/CRM. This probe only runs against ${DEFAULT_PROJECT}.`, 3);
  }
  if (!ALLOWLIST.includes(requestedProject)) throw new ProbeError(`--project '${requestedProject}' is not an allowed probe target (${ALLOWLIST.join(", ")}).`, 3);
  if (keyProjectId !== requestedProject) throw new ProbeError(`service account is for '${keyProjectId}' but --project is '${requestedProject}'. Refusing to run.`, 3);
}

/** Refuses to run with the emulator env set and scrubs every ADC-related variable. */
function hardenEnv(env = process.env) {
  if (env.FIRESTORE_EMULATOR_HOST) throw new ProbeError("FIRESTORE_EMULATOR_HOST is set — this probe targets the test project, not the emulator. Unset it first.", 3);
  for (const k of ADC_ENV) delete env[k];
}

// ─── tools ───────────────────────────────────────────────────────────────────────────────────
function listTools(dir = TOOLS_DIR, fsx = fs) {
  return fsx.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => f.replace(/\.js$/, "")).sort();
}

/** Validates the requested tool name(s) against the folder; returns the ordered list to run. */
function selectTools({ tool, tools }, available) {
  const wanted = tools && tools.length ? tools : [tool];
  const unknown = wanted.filter((t) => !available.includes(t));
  if (unknown.length) throw new ProbeError(`unknown tool(s) '${unknown.join(", ")}'. Tools: ${available.join(", ")}`, 2);
  return wanted;
}

/** Canonical run order for probe-all: cheapest / most certain first, Watson-dependent last. */
const ALL_ORDER = Object.freeze(["roles", "mode", "purchase", "activeProduct", "appointment", "queue", "events", "videoAsk", "evolutionMapping", "content", "recommendation", "communication", "forms", "profileAuthentication", "finance", "systemBilling"]);

// ─── running ─────────────────────────────────────────────────────────────────────────────────
/** Firestore Timestamp → ISO, DocumentReference → "<ref path>", everything else untouched. */
function toPlain(value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value, (k, v) => {
    if (v && typeof v.toDate === "function") return v.toDate().toISOString();
    if (v && typeof v === "object" && typeof v.path === "string" && typeof v.id === "string" && !Array.isArray(v)) return `<ref ${v.path}>`;
    return v;
  }));
}

/**
 * Runs one tool through the real registry path (runTool → load → project → assertShape).
 * @returns {{ tool, ok, ms, response?, error? }}
 */
async function runOne(p360, tool, participant, opts, log = () => {}) {
  const started = Date.now();
  const outcome = await p360.runTool(tool, { profileid: participant.profileid, limit: opts.limit, since: opts.since }, { participant, audit: (rec) => log(`▶ audit ${JSON.stringify(rec)}`) });
  const ms = Date.now() - started;
  return outcome.ok ? { tool, ok: true, ms, response: outcome.result } : { tool, ok: false, ms, error: outcome };
}

/**
 * Runs several tools sequentially (one shared participant resolution). A failing tool is recorded and
 * the run continues unless opts.continueOnError === false.
 */
async function runMany(p360, tools, participant, opts, log = () => {}) {
  const results = [];
  for (const tool of tools) {
    log(`▶ ${tool} …`);
    let r;
    try { r = await runOne(p360, tool, participant, opts, log); }
    catch (err) { r = { tool, ok: false, ms: 0, error: { ok: false, error: "internal", message: err && err.message } }; }
    results.push(r);
    log(r.ok ? `✓ ${tool} ${r.ms} ms — ${r.response.data.summary.headline}` : `✗ ${tool} ${r.ms} ms — ${r.error.error}: ${r.error.message ?? ""}`);
    if (!r.ok && opts.continueOnError === false) break;
  }
  return results;
}

/** One line per tool for the terminal. */
function summaryTable(results) {
  const w = Math.max(...results.map((r) => r.tool.length), 4);
  const lines = results.map((r) => {
    const status = r.ok ? "OK  " : "FAIL";
    const detail = r.ok ? `total ${r.response.data.counts.total}, returned ${r.response.data.counts.returned} — ${r.response.data.summary.headline}` : `${r.error.error}${r.error.message ? ": " + r.error.message : ""}`;
    return `${status}  ${r.tool.padEnd(w)}  ${String(r.ms).padStart(5)} ms  ${detail}`;
  });
  const okCount = results.filter((r) => r.ok).length;
  lines.push(`${okCount}/${results.length} tools ok`);
  return lines.join("\n");
}

/** The JSON report written by both probes. */
function buildReport({ project, participant, key, results, raw = null }) {
  const byTool = Object.fromEntries(results.map((r) => [r.tool, r.ok ? r.response : { ok: false, ...r.error }]));
  return { ok: results.every((r) => r.ok), project, key, participant, generatedAt: new Date().toISOString(), tools: results.map((r) => ({ tool: r.tool, ok: r.ok, ms: r.ms })), results: byTool, ...(raw ? { raw } : {}) };
}

/** Exit code for a finished run. */
function exitCodeFor(results) {
  return results.length && results.every((r) => r.ok) ? 0 : 1;
}

module.exports = { ProbeError, DEFAULT_PROJECT, DENYLIST, ALLOWLIST, ALL_ORDER, ADC_ENV, TOOLS_DIR, OUTPUT_DIR, parseArgs, expandHome, loadServiceAccount, checkProject, hardenEnv, listTools, selectTools, toPlain, runOne, runMany, summaryTable, buildReport, exitCodeFor };
