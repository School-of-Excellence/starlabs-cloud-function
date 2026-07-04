#!/usr/bin/env node
/*
 * predeploy.js — the CF PREDEPLOY gate (master plan 2026-07-02, L13/L14; scoped + interactive
 * per operator lock 2026-07-03).
 *
 * Wired in firebase.json → runs on EVERY `firebase deploy`. Flow:
 *   1. regenerate functions-manifest.json (guard + console read it);
 *   2. detect WHICH functions this deploy ships (parses the parent `firebase deploy` command's
 *      --only list — hooks receive no args, but the parent cmdline is readable via ps);
 *   3. PROMPT: run the loop-guard? [Y = test / s = skip]  (30s auto-Y; non-TTY → always test;
 *      SKIP_TEST=1 env = explicit non-interactive skip);
 *   4. if testing: run the hub's cf-predeploy.sh scoped via GUARD_ONLY to the deploying functions
 *      (full deploy → all functions). NON-ZERO EXIT ⇒ the CLI ABORTS the deploy.
 *
 * GOAL: every function about to deploy is loop-guard-tested — no more, no less.
 * Setup (one-time): bash scripts/cicd/setscript.sh  (writes .env.cicd — hub path + ingest token).
 */
const { spawnSync, execSync } = require('child_process');
const readline = require('readline');
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

/**
 * Find the real `firebase deploy …` command line. Hooks run as `sh -c node …` children of the
 * CLI, so the DIRECT parent is a shell — walk the ancestry (ps) until a command containing
 * `deploy` appears (the firebase invocation), max 6 levels. Fail-safe: unparseable → full guard.
 */
function deployCommand() {
  let pid = process.ppid;
  for (let i = 0; i < 6 && pid && pid > 1; i++) {
    let args = '';
    try {
      args = execSync(`ps -o args= -p ${pid}`, { encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
    if (/\bdeploy\b/.test(args) && !/predeploy\.js/.test(args)) return args;
    try {
      pid = Number(execSync(`ps -o ppid= -p ${pid}`, { encoding: 'utf8' }).trim());
    } catch {
      return '';
    }
  }
  return '';
}

function deployingFunctions() {
  const cmd = deployCommand();
  const m = /--only[= ]([^\s]+)/.exec(cmd);
  if (!m) return null; // no --only (or command not found) → full deploy → guard everything
  const names = [];
  for (const t of m[1].split(',')) {
    const parts = t.split(':');
    if (parts[0] === 'functions' && parts.length === 1) return null; // bare `functions` → all
    if (parts.length > 1) names.push(parts[parts.length - 1]);       // functions:name / functions:codebase:name
    else names.push(parts[0]);                                        // lenient: `--only functions:f1,f2` style
  }
  return names.length ? names : null;
}

/**
 * Arrow-key selector (operator UX lock 2026-07-03): "Yes — test" preselected; ↓ moves to "Skip";
 * Enter confirms. NO timeout. Non-TTY (CI) → always test; SKIP_TEST=1 → explicit skip; Ctrl-C
 * aborts the deploy.
 */
function askRunTests(scopeLabel) {
  if (process.env.SKIP_TEST === '1') return Promise.resolve(false);
  if (!process.stdin.isTTY) {
    console.log('   (non-interactive terminal — running the loop-guard by default)');
    return Promise.resolve(true);
  }
  const options = [`Yes — run the loop-guard for ${scopeLabel}`, 'Skip tests and deploy (untested)'];
  return new Promise((resolve) => {
    let idx = 0;
    const line = (i) => `   ${i === idx ? '\x1b[36m❯ ' + options[i] + '\x1b[0m' : '  ' + options[i]}`;
    const render = () => process.stdout.write(`${line(0)}\n${line(1)}\n`);
    console.log('   Run loop-guard test before deploying? (↑/↓ then Enter)');
    render();
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const done = (choice) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('keypress', onKey);
      resolve(choice);
    };
    const onKey = (_str, key) => {
      if (!key) return;
      if (key.name === 'up' || key.name === 'down') {
        idx = idx === 0 ? 1 : 0;
        process.stdout.write('\x1b[2A'); // cursor up 2 lines → repaint the menu in place
        render();
      } else if (key.name === 'return') {
        done(idx === 0);
      } else if (key.ctrl && key.name === 'c') {
        process.stdin.setRawMode(false);
        console.log('\n✋ aborted — deploy cancelled.');
        process.exit(1);
      }
    };
    process.stdin.on('keypress', onKey);
  });
}

(async () => {
  const envFile = loadEnvFile();
  const HUB = process.env.E2E_HUB_PATH || envFile.E2E_HUB_PATH;
  const TOKEN = process.env.CONSOLE_INGEST_TOKEN || envFile.CONSOLE_INGEST_TOKEN;

  console.log('\n══ CF predeploy gate (loop-guard) ═══════════════════════════════');

  // ONE CONTRACT (locked 2026-07-03): no complete .env.cicd → no deploy.
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

  // 2. Scope: which functions does THIS deploy ship?
  const only = deployingFunctions();
  const scopeLabel = only ? `[${only.join(', ')}]` : 'ALL functions (full deploy)';
  console.log(`   deploying: ${scopeLabel}`);

  // Fast path: scoped deploy where NONE of the functions is a Firestore trigger → nothing the
  // loop-guard can exercise; skip the emulator boot entirely (honest: logged, not silent).
  if (only) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'functions-manifest.json'), 'utf8'));
      const triggers = new Set(
        (manifest.functions ?? [])
          .filter((f) => f.triggerPath)
          .map((f) => f.name),
      );
      if (!only.some((n) => triggers.has(n))) {
        console.log('   ✓ none of the deploying functions is a Firestore trigger — nothing to loop-guard.');
        process.exit(0);
      }
    } catch {
      /* manifest unreadable → fall through to the full prompt/guard (fail-safe) */
    }
  }

  // 3. The developer's choice (operator lock 2026-07-03): test or skip.
  const run = await askRunTests(scopeLabel);
  if (!run) {
    console.log('   ⚠⚠⚠ LOOP-GUARD SKIPPED — deploying UNTESTED functions (developer choice) ⚠⚠⚠');
    process.exit(0);
  }

  // 4. The dynamic loop-guard (hub-owned), scoped via GUARD_ONLY when --only was used.
  if (!HUB || !fs.existsSync(path.join(HUB, 'scripts', 'cf-predeploy.sh'))) {
    console.error('✋ predeploy blocked: E2E_HUB_PATH is not set (or has no scripts/cf-predeploy.sh).');
    console.error('   One-time setup: bash scripts/cicd/setscript.sh');
    console.error('   (prompts for the hub path — clones the public hub if you lack one — and');
    console.error('   fetches the ingest token, then writes .env.cicd).');
    process.exit(1);
  }

  const guard = spawnSync('bash', [path.join(HUB, 'scripts', 'cf-predeploy.sh')], {
    cwd: HUB,
    stdio: 'inherit',
    env: { ...process.env, CF_DIR: REPO_ROOT, ...(only ? { GUARD_ONLY: only.join(',') } : {}) },
  });
  process.exit(guard.status ?? 1);
})();
