#!/usr/bin/env node
/* global process, __filename */
/**
 * probe-purchase.js — run ONE participant360 tool (default: purchase) against the TEST Firebase project
 * (starlabs-test, the Firestore project behind starlabs-test-19.web.app) for one real participant and
 * print the JSON the Cloud Function would return.
 *
 * READ-ONLY. Goes through the exact production path (resolve -> runTool -> load -> project -> assertShape).
 * No HTTP, no emulator, no writes. Never touches firestore-atc. To run all 16 tools use probe-all.js.
 *
 * USAGE  (run from  starlabs-cloud-function/functions):
 *
 *   node scripts/participant360/probe-purchase.js <profileid | email | phone> [options]
 *
 *   Options
 *     --sa <path>        service-account JSON for the test project (default: $STARLABS_TEST_SA, then
 *                        $GOOGLE_APPLICATION_CREDENTIALS)
 *     --project <id>     expected project id (default: starlabs-test); must be allow-listed AND match the key
 *     --tool <name>      any of the 16 tools (default: purchase)
 *     --limit <n>        items cap (default 20)
 *     --since <ISO>      only items on/after this date
 *     --out <file>       also write the JSON to a file
 *     --raw              also print the raw Firestore docs the purchase tool read (field-shape checks)
 *
 *   Examples
 *     node scripts/participant360/probe-purchase.js IoHmVM93pSw9SQ4KBzUn --sa C:\keys\starlabs-test.json --raw
 *     node scripts/participant360/probe-purchase.js test136@soexcellence.com --limit 5 --out out.json
 *     node scripts/participant360/probe-purchase.js IoHmVM93pSw9SQ4KBzUn --tool activeProduct
 *     npm run p360:probe -- IoHmVM93pSw9SQ4KBzUn --sa C:\keys\starlabs-test.json
 *
 * OUTPUT
 *   stdout = the JSON report only (safe to pipe / redirect). stderr = progress, audit line, headline.
 *
 * SAFETY
 *   - Deny-list (production / Watson / CRM) wins over every flag; --project must be allow-listed
 *     [starlabs-test, starlabs-test-19, starlabs-cicd] and equal the key's project_id.
 *   - Refuses to run with FIRESTORE_EMULATOR_HOST set; scrubs ADC env vars before loading firebase-admin.
 *   - Watson (finance / systemBilling) is not configured here: those two report "not configured".
 *
 * Exit codes: 0 ok · 1 tool failure / participant not found · 2 usage · 3 safety refusal
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
  try { args = lib.parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(`✗ ${e.message}`); process.exitCode = e.exitCode; return; }
  if (args.help || !args.key) { usage(); process.exitCode = args.help ? 0 : 2; return; }

  let admin;
  try {
    // 1) key + project safety — no Firebase code loaded yet
    const { sa } = lib.loadServiceAccount(args);
    const [tool] = lib.selectTools(args, lib.listTools());
    if (args.raw && tool !== "purchase") console.error("▲ --raw is only implemented for the purchase tool; ignoring it.");
    lib.hardenEnv();

    // 2) init the admin app BEFORE the module loads (collection.js only initialises when no app exists)
    admin = require("firebase-admin");
    admin.initializeApp({ credential: admin.credential.cert(sa), projectId: sa.project_id });
    console.error(`▶ project ${sa.project_id} · tool ${tool} · key ${args.key}`);

    // 3) run through the real registry path
    const p360 = require("../../components/participant360");
    const { resolveParticipant } = require("../../components/participant360/resolve");
    const participant = await resolveParticipant(args.key);
    if (!participant) throw new lib.ProbeError(`no profile_data match for '${args.key}' in ${sa.project_id}`, 1);
    console.error(`▶ resolved ${participant.profileid} <${participant.email ?? "no email"}> ${participant.name ?? ""}`);

    const result = await lib.runOne(p360, tool, participant, args, (line) => console.error(line));

    // 4) optional raw docs (field-shape check) — purchase only, same queries the tool ran
    let raw = null;
    if (args.raw && tool === "purchase") {
      const { C, docsOf, docById } = require("../../components/participant360/collection");
      const [pmd, pjps, psps] = await Promise.all([
        docById(C.PMD, participant.profileid),
        docsOf(C.PJP, (c) => c.where("profileid", "==", participant.profileid)),
        docsOf(C.PSP, (c) => c.where("profileid", "==", participant.profileid)),
      ]);
      raw = { "participant metadata": lib.toPlain(pmd), participantjourneyproduct: lib.toPlain(pjps), participantsproduct: lib.toPlain(psps) };
    }

    const report = { ok: result.ok, project: sa.project_id, tool, key: args.key, participant, ms: result.ms, ...(result.ok ? { response: result.response } : { error: result.error }), ...(raw ? { raw } : {}) };
    const json = JSON.stringify(report, null, 2);
    fs.writeSync(process.stdout.fd, json + "\n"); // synchronous: never truncated when piped or redirected
    if (args.outFile) { fs.writeFileSync(args.outFile, json); console.error(`▶ written ${path.resolve(args.outFile)}`); }

    if (result.ok) {
      console.error(`✓ ${tool} in ${result.ms} ms — ${result.response.data.summary.headline}`);
      console.error(`  counts: ${JSON.stringify(result.response.data.counts)}`);
    } else {
      console.error(`✗ tool failed: ${result.error.error} ${result.error.message ?? ""}`);
    }
    process.exitCode = lib.exitCodeFor([result]);
  } catch (e) {
    console.error(`${e instanceof lib.ProbeError && e.exitCode === 3 ? "🛑" : "✗"} ${e.message}`);
    process.exitCode = e instanceof lib.ProbeError ? e.exitCode : 1;
  } finally {
    if (admin) await Promise.all(admin.apps.map((a) => a.delete())).catch(() => {}); // close gRPC channels so the process ends promptly
  }
})();
