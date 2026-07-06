#!/usr/bin/env node
/*
 * postdeploy.js — report EVERY `firebase deploy` to the release console (master plan L15/L16;
 * identity auth 2026-07-05). This is what makes "deployed to starlabs-test but code not pushed yet"
 * VISIBLE on the CF Board's Dev/Prod matrix — the exact case webhooks can never see.
 *
 * POSTs {repo, project, branch, sha, by, functions[]} → recordCfDeploy, authenticated with the DEV'S
 * OWN GitHub token (`gh auth token`). recordCfDeploy verifies the caller has PUSH access to the CF
 * repo and stamps `by` from the verified identity — NO shared secret on the dev machine, NO .env.cicd.
 * (CI may still inject the shared CONSOLE_INGEST_TOKEN; that path is honored first.)
 *
 * BEST-EFFORT BY DESIGN: the deploy already happened — a reporting hiccup must not fail the deploy
 * command, so this script ALWAYS exits 0 (the audit-log webhook cfDeployEvent heals a miss, minus sha).
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INGEST_URL = process.env.CONSOLE_INGEST_URL || 'https://us-central1-starlabs-cicd.cloudfunctions.net';

function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** The bearer for recordCfDeploy: a CI-injected shared token if present, else the dev's GitHub identity. */
function ingestBearer() {
  if (process.env.CONSOLE_INGEST_TOKEN) return process.env.CONSOLE_INGEST_TOKEN;
  try {
    return execSync('gh auth token', { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

(async () => {
  const token = ingestBearer();
  const project = process.env.GCLOUD_PROJECT || '';

  if (!token) {
    console.warn('[postdeploy] no GitHub auth (run `gh auth login`) and no CONSOLE_INGEST_TOKEN — deploy NOT reported (matrix heals via the audit-log webhook cfDeployEvent).');
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
    // Sent as a hint; recordCfDeploy OVERRIDES it with the verified GitHub login on the identity path.
    by: git('config user.email') || undefined,
    functions: (manifest.functions ?? []).map((f) => ({
      name: f.name,
      type: f.type,
      file: f.file,
      codebase: f.codebase,
    })),
  };

  try {
    const resp = await fetch(`${INGEST_URL}/recordCfDeploy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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
