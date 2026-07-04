#!/usr/bin/env node
/*
 * predeploy.js — the CF PREDEPLOY gate (master plan 2026-07-02 L13/L14; Option B rework 2026-07-05).
 *
 * Wired in firebase.json → runs on EVERY `firebase deploy`. Flow:
 *   0. REQUIRE GitHub CLI login — postdeploy records the deploy under the dev's identity (`gh auth token`);
 *   1. regenerate functions-manifest.json (guard + console read it);
 *   2. detect WHICH functions this deploy ships (parse the parent `firebase deploy --only`);
 *   3. fast-skip if no deploying function is a Firestore trigger (nothing the loop-guard can exercise);
 *   4. PROMPT: run the loop-guard?  (non-TTY/CI → always run; SKIP_TEST=1 → explicit skip);
 *   5. ensureHubCache(): auto-clone/refresh the PUBLIC hub into .cicd-hub/ (gitignored, sha-versioned);
 *   6. run the hub's cf-predeploy.sh FROM THE CACHE (boots the emulator with THIS repo's code, runs
 *      the guard). NON-ZERO EXIT ⇒ the Firebase CLI ABORTS the deploy.
 *
 * Option B (2026-07-05): no .env.cicd, no setscript.sh, no E2E_HUB_PATH, no local hub to maintain.
 * The guard machinery stays the hub's — reused VERBATIM from the cache → zero drift. The only thing a
 * developer needs is `gh auth login` (identity) plus the tooling they already have to deploy CF
 * (git, Node 22, Java 21, firebase-tools).
 */
const { spawnSync, execSync } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HUB_REPO = 'https://github.com/School-of-Excellence/starlabs-e2e-tests';
const CACHE = path.join(REPO_ROOT, '.cicd-hub'); // gitignored, auto-managed hub checkout

// --- gh auth gate: identity-based deploy recording needs `gh auth token` (postdeploy). Fail fast so a
//     dev never deploys and then silently fails to record. -----------------------------------------
function requireGhAuth() {
  try {
    execSync('gh auth status', { stdio: 'ignore' });
  } catch {
    console.error('✋ predeploy blocked: not logged in to the GitHub CLI.');
    console.error('   Run:  gh auth login        (needed so the deploy is recorded to the console)');
    process.exit(1);
  }
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

// --- Option B: keep the PUBLIC hub cached + set up, then reuse its cf-predeploy.sh (no drift) ------
function hubLatestSha() {
  try {
    return execSync(`git ls-remote ${HUB_REPO} refs/heads/main`, { encoding: 'utf8' }).split(/\s/)[0];
  } catch {
    return '';
  }
}

/**
 * Ensure .cicd-hub/ holds a ready, up-to-date checkout of the (public) hub. "Check latest version,
 * else use cache": compare the remote main sha against .cicd-hub/.hubversion.
 *   - warm + current            → reuse instantly (no network work beyond ls-remote)
 *   - offline but cache ready    → reuse with a staleness warning
 *   - offline and no cache       → fail closed (can't guarantee the guard)
 *   - new sha / no cache         → shallow clone (or fetch+reset) + npm ci + stage emulator config
 */
function ensureHubCache() {
  const ready = fs.existsSync(path.join(CACHE, 'scripts', 'cf-predeploy.sh'));
  const versionFile = path.join(CACHE, '.hubversion');
  const cachedSha = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : '';
  const latest = hubLatestSha();

  if (ready && cachedSha && (latest === cachedSha || latest === '')) {
    if (latest === '') console.warn('   ⚠ could not reach GitHub — using the cached guard (may be stale).');
    return;
  }
  if (!latest && !ready) {
    console.error('✋ predeploy blocked: guard not cached and GitHub is unreachable — cannot verify the');
    console.error('   deploying triggers are loop-safe. Connect to the network and retry.');
    process.exit(1);
  }

  console.log(`   preparing guard environment (${ready ? 'updating' : 'first-time clone of'} the hub)…`);
  try {
    if (!fs.existsSync(path.join(CACHE, '.git'))) {
      fs.rmSync(CACHE, { recursive: true, force: true });
      execSync(`git clone --depth 1 ${HUB_REPO} "${CACHE}"`, { stdio: 'inherit' });
    } else {
      execSync('git fetch --depth 1 origin main', { cwd: CACHE, stdio: 'inherit' });
      execSync('git reset --hard origin/main', { cwd: CACHE, stdio: 'inherit' });
    }
    execSync('npm ci', { cwd: CACHE, stdio: 'inherit' });
    execSync('bash ci/setup-emulator-config.sh', { cwd: CACHE, stdio: 'inherit' });
    fs.writeFileSync(versionFile, latest);
  } catch (e) {
    console.error('✋ predeploy blocked: failed to prepare the guard cache (.cicd-hub).');
    console.error(`   Remove .cicd-hub and retry, or check network/Node 22/Java 21. Details: ${e.message}`);
    process.exit(1);
  }
}

(async () => {
  console.log('\n══ CF predeploy gate (loop-guard) ═══════════════════════════════');

  // 0. Identity gate — postdeploy records under the dev's GitHub identity.
  requireGhAuth();

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
  // loop-guard can exercise; skip the whole hub/emulator boot (honest: logged, not silent).
  if (only) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'functions-manifest.json'), 'utf8'));
      const triggers = new Set((manifest.functions ?? []).filter((f) => f.triggerPath).map((f) => f.name));
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

  // 4. Ensure the cached hub, then run its (hub-owned) guard against THIS repo's code.
  ensureHubCache();
  const guard = spawnSync('bash', [path.join(CACHE, 'scripts', 'cf-predeploy.sh')], {
    cwd: CACHE,
    stdio: 'inherit',
    env: { ...process.env, CF_DIR: REPO_ROOT, ...(only ? { GUARD_ONLY: only.join(',') } : {}) },
  });
  process.exit(guard.status ?? 1);
})();
