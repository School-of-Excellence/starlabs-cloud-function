#!/usr/bin/env node
/* global process, __filename */
/**
 * probe-all.js — run ALL 16 participant360 tools for one real participant against the TEST Firebase
 * project (starlabs-test, the Firestore project behind starlabs-test-19.web.app) and write one JSON
 * report containing every tool's response.
 *
 * READ-ONLY. Each tool goes through the exact production path (resolve -> runTool -> load -> project
 * -> assertShape). No HTTP, no emulator, no writes. Never touches firestore-atc.
 *
 * USAGE  (run from  starlabs-cloud-function/functions):
 *
 *   node scripts/participant360/probe-all.js <profileid | email | phone> [options]
 *
 *   Options
 *     --sa <path>        service-account JSON for the test project (default: $STARLABS_TEST_SA, then
 *                        $GOOGLE_APPLICATION_CREDENTIALS)
 *     --project <id>     expected project id (default: starlabs-test); must be allow-listed AND match the key
 *     --tools a,b,c      run only these tools, in this order (default: all 16, cheapest first)
 *     --limit <n>        items cap per tool (default 20)
 *     --since <ISO>      only items on/after this date (tools with time-ordered items)
 *     --out <file>       write the JSON report here (default: participant360-<profileid>.json in cwd)
 *     --fail-fast        stop at the first failing tool (default: continue and report all)
 *
 *   Examples
 *     node scripts/participant360/probe-all.js IoHmVM93pSw9SQ4KBzUn --sa C:\keys\starlabs-test.json
 *     node scripts/participant360/probe-all.js test136@soexcellence.com --tools purchase,appointment,queue
 *     npm run p360:probe:all -- IoHmVM93pSw9SQ4KBzUn --sa C:\keys\starlabs-test.json
 *
 * OUTPUT
 *   stdout = one summary line per tool + "n/16 tools ok". stderr = progress + audit lines.
 *   The JSON report (--out) has: { ok, project, key, participant, generatedAt, tools[], results{tool: envelope} }.
 *
 * SAFETY
 *   - Deny-list (production / Watson / CRM) wins over every flag; --project must be allow-listed
 *     [starlabs-test, starlabs-test-19, starlabs-cicd] and equal the key's project_id.
 *   - Refuses to run with FIRESTORE_EMULATOR_HOST set; scrubs ADC env vars before loading firebase-admin.
 *   - Watson (finance / systemBilling) is not configured here: those two report "not configured".
 *
 * Exit codes: 0 all tools ok · 1 some tool failed or participant not found · 2 usage · 3 safety refusal
 */

const fs = require("fs");
const path = require("path");
const lib = require("./probe-lib");

function usage() {
  const src = fs.readFileSync(__filename, "utf8");
  const start = src.indexOf("/**") + 3;
  console.log(src.slice(start, src.indexOf("*/", start)).split("\n").map((l) => l.replace(/^\s*\*\s?/, "")).join("\n").trim());
}

(async () => {
  let args;
  try { args = lib.parseArgs(process.argv.slice(2), { multiTool: true }); }
  catch (e) { console.error(`✗ ${e.message}`); process.exitCode = e.exitCode; return; }
  if (args.help || !args.key) { usage(); process.exitCode = args.help ? 0 : 2; return; }

  let admin;
  try {
    // 1) key + project safety — no Firebase code loaded yet
    const { sa } = lib.loadServiceAccount(args);
    const tools = lib.selectTools({ tool: null, tools: args.tools && args.tools.length ? args.tools : lib.ALL_ORDER }, lib.listTools());
    lib.hardenEnv();

    // 2) init the admin app BEFORE the module loads (collection.js only initialises when no app exists)
    admin = require("firebase-admin");
    admin.initializeApp({ credential: admin.credential.cert(sa), projectId: sa.project_id });
    console.error(`▶ project ${sa.project_id} · ${tools.length} tool(s) · key ${args.key}`);

    // 3) resolve once, run every tool through the real registry path
    const p360 = require("../../components/participant360");
    const { resolveParticipant } = require("../../components/participant360/resolve");
    const participant = await resolveParticipant(args.key);
    if (!participant) throw new lib.ProbeError(`no profile_data match for '${args.key}' in ${sa.project_id}`, 1);
    console.error(`▶ resolved ${participant.profileid} <${participant.email ?? "no email"}> ${participant.name ?? ""}`);

    const results = await lib.runMany(p360, tools, participant, args, (line) => console.error(line));

    // 4) report + summary
    const report = lib.buildReport({ project: sa.project_id, participant, key: args.key, results });
    const outFile = path.resolve(args.outFile || `participant360-${participant.profileid}.json`);
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
    fs.writeSync(process.stdout.fd, lib.summaryTable(results) + "\n");
    console.error(`▶ written ${outFile}`);
    process.exitCode = lib.exitCodeFor(results);
  } catch (e) {
    console.error(`${e instanceof lib.ProbeError && e.exitCode === 3 ? "🛑" : "✗"} ${e.message}`);
    process.exitCode = e instanceof lib.ProbeError ? e.exitCode : 1;
  } finally {
    if (admin) await Promise.all(admin.apps.map((a) => a.delete())).catch(() => {}); // close gRPC channels so the process ends promptly
  }
})();
