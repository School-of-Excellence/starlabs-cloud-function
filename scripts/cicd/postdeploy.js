#!/usr/bin/env node
/*
 * postdeploy.js — report EVERY `firebase deploy` to the release console (master plan 2026-07-02,
 * L15/L16). This is what makes "deployed to starlabs-test but code not pushed yet" VISIBLE on the
 * CF Board's Dev/Prod matrix — the exact case webhooks can never see.
 *
 * POSTs {repo, project, branch, sha, by, functions[]} → recordCfDeploy (bearer CONSOLE_INGEST_TOKEN).
 * BEST-EFFORT BY DESIGN: the deploy already happened — a reporting hiccup must not fail the deploy
 * command, so this script ALWAYS exits 0 (reconcilePoll's Cloud-Functions-API check heals misses
 * within 30 minutes).
 *
 * Setup: .env.cicd with CONSOLE_INGEST_URL + CONSOLE_INGEST_TOKEN (see .env.cicd.example).
 */
const { execSync } = require('child_process');
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

function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

(async () => {
  const envFile = loadEnvFile();
  const BASE = process.env.CONSOLE_INGEST_URL || envFile.CONSOLE_INGEST_URL || 'https://us-central1-starlabs-cicd.cloudfunctions.net';
  const TOKEN = process.env.CONSOLE_INGEST_TOKEN || envFile.CONSOLE_INGEST_TOKEN;
  const project = process.env.GCLOUD_PROJECT || '';

  if (!TOKEN) {
    console.warn('[postdeploy] CONSOLE_INGEST_TOKEN not set (.env.cicd) — deploy NOT reported to the console (matrix heals via the audit-log webhook (cfDeployEvent)).');
    return;
  }
  if (!project) {
    console.warn('[postdeploy] GCLOUD_PROJECT not provided by the CLI — deploy NOT reported.');
    return;
  }

  const manifestPath = path.join(REPO_ROOT, 'functions-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.warn('[postdeploy] functions-manifest.json missing — deploy NOT reported.');
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const body = {
    repo: 'starlabs-cloud-function',
    project,
    branch: git('rev-parse --abbrev-ref HEAD') || 'unknown',
    sha: git('rev-parse HEAD') || undefined,
    by: git('config user.email') || undefined,
    functions: (manifest.functions ?? []).map((f) => ({
      name: f.name,
      type: f.type,
      file: f.file,
      codebase: f.codebase,
    })),
  };

  try {
    const resp = await fetch(`${BASE}/recordCfDeploy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await resp.text();
    if (resp.ok) {
      console.log(`[postdeploy] ✓ reported ${body.functions.length} functions → console (${project}, branch ${body.branch})`);
    } else {
      console.warn(`[postdeploy] console rejected the report (HTTP ${resp.status}): ${text.slice(0, 200)} — matrix heals via the audit-log webhook (cfDeployEvent).`);
    }
  } catch (e) {
    console.warn(`[postdeploy] report failed (${e.message}) — matrix heals via the audit-log webhook (cfDeployEvent).`);
  }
})().finally(() => process.exit(0));
