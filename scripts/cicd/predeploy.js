#!/usr/bin/env node
/*
 * predeploy.js — the CF PREDEPLOY gate (master plan 2026-07-02, L13/L14; replaces the
 * loopDetector.js static check with the DYNAMIC Playwright loop-guard).
 *
 * Wired in firebase.json → runs on EVERY `firebase deploy` (any project, any machine).
 * Flow:
 *   1. regenerate functions-manifest.json (so the guard + console see the CURRENT code);
 *   2. run the hub's cf-predeploy.sh: boots a fresh local emulator with THIS repo's triggers and
 *      runs cf-guards/no-retrigger-loop.spec.ts ("a function must not retrigger the same CF and
 *      create a loop" — the operator's locked test case).
 * NON-ZERO EXIT ⇒ the Firebase CLI ABORTS the deploy. `--force` cannot skip predeploy hooks.
 *
 * Setup (one-time per developer): copy .env.cicd.example → .env.cicd and set E2E_HUB_PATH to your
 * local starlabs-e2e-tests checkout (the hub owns the emulator scripts + the guard spec).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function loadEnvFile() {
  const p = path.join(REPO_ROOT, '.env.cicd');
  const out = {};
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const envFile = loadEnvFile();
const HUB = process.env.E2E_HUB_PATH || envFile.E2E_HUB_PATH;
const TOKEN = process.env.CONSOLE_INGEST_TOKEN || envFile.CONSOLE_INGEST_TOKEN;

console.log('\n══ CF predeploy gate (loop-guard) ═══════════════════════════════');

// ONE CONTRACT (locked 2026-07-03): no complete .env.cicd → no deploy. Both values are required —
// the hub path runs the gate; the token makes postdeploy attribute the deploy (branch/sha/by) on
// the CF Board. Run `bash scripts/cicd/setscript.sh` once to generate the file.
if (!TOKEN) {
  console.error('✋ predeploy blocked: CONSOLE_INGEST_TOKEN missing from .env.cicd.');
  console.error('   One-time setup: bash scripts/cicd/setscript.sh');
  process.exit(1);
}

// 1. Fresh manifest — the guard seeds from it; the console reads it per-branch.
const gen = spawnSync(process.execPath, [path.join(__dirname, 'generate-manifest.js')], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
});
if (gen.status !== 0) {
  console.error('✋ predeploy blocked: manifest generation failed.');
  process.exit(gen.status ?? 1);
}

// 2. The dynamic loop-guard (hub-owned).
if (!HUB || !fs.existsSync(path.join(HUB, 'scripts', 'cf-predeploy.sh'))) {
  console.error('✋ predeploy blocked: E2E_HUB_PATH is not set (or has no scripts/cf-predeploy.sh).');
  console.error('   One-time setup: run  bash scripts/cicd/setscript.sh');
  console.error('   (prompts for the hub path — clones the public hub if you lack one — and');
  console.error('   fetches the ingest token, then writes .env.cicd).');
  console.error('   The deploy gate runs the Playwright no-retrigger-loop guard from the hub —');
  console.error('   deploys are NOT allowed without it.');
  process.exit(1);
}

const guard = spawnSync('bash', [path.join(HUB, 'scripts', 'cf-predeploy.sh')], {
  cwd: HUB,
  stdio: 'inherit',
  env: { ...process.env, CF_DIR: REPO_ROOT },
});
process.exit(guard.status ?? 1);
