#!/usr/bin/env node
/*
 * secret-scan.js — blocks a Cloud Functions deploy that would upload a hardcoded credential.
 *
 * Run by scripts/cicd/predeploy.js as its FIRST step (before the gh gate, the manifest, the scope
 * fast-path, the SKIP_TEST/menu choice and the loop-guard), and by .github/workflows/secret-scan.yml.
 *
 * WHAT IS SCANNED = what `firebase deploy` uploads: every file under each functions `source` in
 * firebase.json, minus that codebase's `ignore` list (firebase-tools prepareFunctionsUpload: minimatch with
 * {matchBase, dot}; default ["node_modules", ".git"] when no list; plus firebase-debug*.log and
 * .runtimeconfig.json). Git is NOT consulted: untracked files are uploaded, so they are scanned, and
 * .gitignore does not exclude anything from a functions upload. The whole source is uploaded even for
 * `--only functions:x`, so the whole source is scanned. Ignore patterns this file cannot interpret
 * exactly are NOT applied (scan more, never less).
 *
 * BLOCK  (exit 1): high-confidence formats — cloud/API keys, tokens, webhooks, private keys,
 *                  service-account keys, credentials embedded in URLs, JWTs.
 * WARN   (exit 0): generic `password|secret|token… = "literal"` assignments (too noisy to block).
 * ERROR  (exit 2): anything that prevents a complete scan (bad firebase.json, missing source dir,
 *                  unreadable file, malformed allow-list). predeploy.js blocks the deploy on ANY non-zero.
 *
 * Output never contains a secret value: only file:line, rule, length and SHA-256 (the hash is what an
 * allow-list entry needs; it is not reversible for a random credential).
 *
 * FALSE POSITIVES — .secretscan-allow.json (repo root), reviewed like code:
 *   { "version": 1, "entries": [ { "file": "functions/…/x.js", "rule": "google-api-key",
 *       "sha256": "<64 hex from the scan output>", "reason": "why this is not a secret",
 *       "approvedBy": "<name>" } ] }
 *   An entry excuses ONE exact value, in ONE exact file, for ONE rule. No wildcards, no inline
 *   "ignore" comments, no env-var bypass — by design. Stale entries (match nothing) are reported.
 *
 * Usage: node scripts/cicd/secret-scan.js [--root <repo root>]
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALLOW_FILE = '.secretscan-allow.json';

// --- rules ---------------------------------------------------------------------------------------
// `v` named group = the secret value (hashed / measured); whole match when absent.
const RULES = [
  { id: 'aws-access-key-id', severity: 'block', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  {
    id: 'aws-secret-access-key',
    severity: 'block',
    re: /aws.{0,20}?(?:secret|private).{0,20}?['"`](?<v>[A-Za-z0-9/+=]{40})['"`]/gi,
  },
  { id: 'google-api-key', severity: 'block', re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  { id: 'slack-webhook-url', severity: 'block', re: /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/+-]{20,}/g },
  { id: 'slack-token', severity: 'block', re: /\bxox[abposre]-[0-9A-Za-z-]{10,}/g },
  { id: 'github-token', severity: 'block', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}/g },
  { id: 'stripe-live-key', severity: 'block', re: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}/g },
  { id: 'sendgrid-api-key', severity: 'block', re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g },
  { id: 'twilio-api-key', severity: 'block', re: /\bSK[0-9a-f]{32}\b/g },
  { id: 'npm-token', severity: 'block', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: 'llm-api-key', severity: 'block', re: /\bsk-(?:ant-|proj-)[A-Za-z0-9_-]{20,}/g },
  { id: 'ngrok-authtoken', severity: 'block', re: /\b2[A-Za-z0-9]{26}_[0-9][A-Za-z0-9]{20}\b/g },
  {
    id: 'private-key-block',
    severity: 'block',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  { id: 'gcp-service-account-key', severity: 'block', re: /"private_key_id"\s*:\s*"(?<v>[0-9a-f]{40})"/g },
  {
    id: 'url-with-credentials',
    severity: 'block',
    re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/'"`]+:(?<v>[^\s@/'"`]{3,})@[A-Za-z0-9.-]+/gi,
    skipValue: (v) => /^(\$\{|\{\{|<|%s|\*+$|password$|pass$|pwd$|secret$|changeme$)/i.test(v),
  },
  { id: 'jwt', severity: 'block', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    id: 'generic-secret-assignment',
    severity: 'warn',
    re: /\b[A-Za-z0-9_]*(?:password|passwd|secret|api_?key|apikey|access_?token|auth_?token|client_?secret|private_?key|token)[A-Za-z0-9_]*['"]?\s*[:=]\s*(['"`])(?<v>[^'"`\s]{8,})\1/gi,
    skipLine: (line) => /defineSecret\(|process\.env\b|getWebhookUrl\(/.test(line),
    // identifiers / collection names / placeholders are not credentials
    skipValue: (v) =>
      /^(dummy|changeme|change_me|example|sample|placeholder|redacted|your[-_]|xxx|<|\$\{|\{\{|test)/i.test(v) ||
      v.includes('${') ||
      !/[A-Za-z]/.test(v) ||
      !/[0-9!@#$%^&*+=/.~]/.test(v),
  },
];
// --- high-entropy strings: credentials with NO recognisable prefix under ANY variable name -----------
// (e.g. `const xyz = "<random token>"` — the 2026-10-13 miss). Thresholds measured on this repo's deploy
// package: 32+ chars, Shannon entropy >= 4.0 bits/char, >= 2 upper + 2 lower + 2 digits. Known look-alikes
// are skipped: alphabet strings (a run of 10+ consecutive chars), paths / URLs / Firestore "collection/docId"
// refs, lockfile integrity hashes (this rule only), and values a specific rule above already reported.
// Limits: hex-only or lower-case-only secrets, and secrets shorter than 32 chars, are not caught by entropy.
const ENTROPY_RULE = 'high-entropy-string';
const ENTROPY_LITERAL = /(['"`])(?<v>[A-Za-z0-9_+/=-]{32,})\1/g;
const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']);
const FORMAT_RULES = RULES.filter((r) => r.severity === 'block').map((r) => new RegExp(r.re.source, r.re.flags.replace('g', '')));

function shannon(s) {
  const counts = {};
  for (const ch of s) counts[ch] = (counts[ch] || 0) + 1;
  let h = 0;
  for (const n of Object.values(counts)) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}
function hasSequentialRun(s, len = 10) {
  let run = 1;
  for (let i = 1; i < s.length; i++) {
    run = s.charCodeAt(i) === s.charCodeAt(i - 1) + 1 ? run + 1 : 1;
    if (run >= len) return true;
  }
  return false;
}
function looksLikeRandomSecret(v) {
  const count = (re) => (v.match(re) || []).length;
  if (count(/[A-Z]/g) < 2 || count(/[a-z]/g) < 2 || count(/[0-9]/g) < 2) return false;
  if (shannon(v) < 4.0) return false;
  if (hasSequentialRun(v)) return false; // 'ABCDEFGHIJ…' id alphabets
  if (/^\/|\/\/|(^|\/)[a-z][a-z_]{2,}\//.test(v)) return false; // paths, URLs, collection/docId
  if (FORMAT_RULES.some((re) => re.test(v))) return false; // already reported by a specific rule
  return true;
}

const RULE_IDS = new Set([...RULES.map((r) => r.id), ENTROPY_RULE]);

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Findings for one file's text. Never returns the value — only its length and hash. */
function scanText(text, relFile) {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineOf = (idx) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const lines = text.split('\n');
  const findings = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text))) {
      const value = (m.groups && m.groups.v) || m[0];
      const line = lineOf(m.index);
      if (rule.skipLine && rule.skipLine(lines[line - 1] || '')) continue;
      if (rule.skipValue && rule.skipValue(value)) continue;
      findings.push({ file: relFile, line, rule: rule.id, severity: rule.severity, length: value.length, sha256: sha256(value) });
    }
  }
  if (!LOCKFILES.has(path.basename(relFile))) {
    ENTROPY_LITERAL.lastIndex = 0;
    let m;
    while ((m = ENTROPY_LITERAL.exec(text))) {
      const value = m.groups.v;
      if (!looksLikeRandomSecret(value)) continue;
      findings.push({ file: relFile, line: lineOf(m.index), rule: ENTROPY_RULE, severity: 'block', length: value.length, sha256: sha256(value) });
    }
  }
  return findings;
}

// --- deploy package file list (mirrors firebase-tools prepareFunctionsUpload) -------------------
const SIMPLE_GLOB = /^[A-Za-z0-9._*?-]+$/; // no "/", "**", "[...]", "{...}", "!" — matched exactly
function compileIgnore(patterns) {
  const matchers = [];
  const unsupported = [];
  for (const p of patterns) {
    if (typeof p !== 'string' || !SIMPLE_GLOB.test(p) || p.includes('**')) {
      unsupported.push(String(p));
      continue;
    }
    const re = new RegExp('^' + p.replace(/[.+^${}()|[\]\\-]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    matchers.push((name) => re.test(name)); // matchBase → basename; dot:true → "*" matches dotfiles
  }
  return { isIgnored: (name) => matchers.some((fn) => fn(name)), unsupported };
}

function functionsConfigs(repoRoot) {
  const cfgPath = path.join(repoRoot, 'firebase.json');
  if (!fs.existsSync(cfgPath)) throw new Error(`firebase.json not found at ${cfgPath}`);
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    throw new Error(`firebase.json is not valid JSON (${e.message})`);
  }
  const fns = cfg.functions;
  if (!fns) throw new Error('firebase.json has no "functions" section — nothing to scan');
  return (Array.isArray(fns) ? fns : [fns]).map((f) => ({
    source: f.source || 'functions',
    ignore: Array.isArray(f.ignore) ? f.ignore : ['node_modules', '.git'],
  }));
}

function listDeployFiles(repoRoot) {
  const files = [];
  const unsupported = new Set();
  for (const { source, ignore } of functionsConfigs(repoRoot)) {
    const srcDir = path.resolve(repoRoot, source);
    if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
      throw new Error(`functions source directory not found: ${source}`);
    }
    const { isIgnored, unsupported: u } = compileIgnore([...ignore, 'firebase-debug.log', 'firebase-debug.*.log', '.runtimeconfig.json']);
    u.forEach((p) => unsupported.add(p));
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (isIgnored(e.name)) continue;
        const abs = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue; // not followed by our walk; firebase archives the link itself
        if (e.isDirectory()) walk(abs);
        else if (e.isFile()) files.push({ abs, rel: path.relative(repoRoot, abs).split(path.sep).join('/') });
      }
    })(srcDir);
  }
  return { files, unsupportedIgnore: [...unsupported] };
}

function readText(abs) {
  const buf = fs.readFileSync(abs); // throws on unreadable → scan ERROR (fail closed)
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf).swap16().toString('utf16le');
  if (buf.subarray(0, 8000).includes(0)) return null; // binary
  return buf.toString('utf8');
}

// --- allow-list ----------------------------------------------------------------------------------
function loadAllowlist(repoRoot) {
  const p = path.join(repoRoot, ALLOW_FILE);
  if (!fs.existsSync(p)) return [];
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`${ALLOW_FILE} is not valid JSON (${e.message})`);
  }
  if (!doc || doc.version !== 1 || !Array.isArray(doc.entries)) throw new Error(`${ALLOW_FILE}: expected { "version": 1, "entries": [...] }`);
  doc.entries.forEach((e, i) => {
    const bad = (why) => {
      throw new Error(`${ALLOW_FILE} entry #${i + 1}: ${why}`);
    };
    if (!e || typeof e !== 'object') bad('not an object');
    if (typeof e.file !== 'string' || !e.file || /[*?[\]{}!\\]/.test(e.file) || path.isAbsolute(e.file) || e.file.includes('..')) {
      bad('"file" must be one exact repo-relative path (forward slashes, no wildcards)');
    }
    if (!RULE_IDS.has(e.rule)) bad(`"rule" must be one of: ${[...RULE_IDS].join(', ')}`);
    if (!/^[0-9a-f]{64}$/.test(e.sha256 || '')) bad('"sha256" must be the 64-hex hash printed by the scan');
    if (typeof e.reason !== 'string' || e.reason.trim().length < 10) bad('"reason" is required (why this is not a secret)');
    if (typeof e.approvedBy !== 'string' || !e.approvedBy.trim()) bad('"approvedBy" is required');
  });
  return doc.entries;
}

// --- whole repo ----------------------------------------------------------------------------------
function scanRepo(repoRoot) {
  const allow = loadAllowlist(repoRoot);
  const { files, unsupportedIgnore } = listDeployFiles(repoRoot);
  const blocked = [];
  const warnings = [];
  const allowed = [];
  const binary = [];
  for (const f of files) {
    const text = readText(f.abs);
    if (text === null) {
      binary.push(f.rel);
      continue;
    }
    for (const finding of scanText(text, f.rel)) {
      const entry = allow.find((a) => a.file === finding.file && a.rule === finding.rule && a.sha256 === finding.sha256);
      if (entry) allowed.push({ ...finding, entry });
      else (finding.severity === 'block' ? blocked : warnings).push(finding);
    }
  }
  const stale = allow.filter((a) => !allowed.some((x) => x.entry === a));
  return { scanned: files.length, blocked, warnings, allowed, binary, stale, unsupportedIgnore };
}

// --- CLI -----------------------------------------------------------------------------------------
function main(argv) {
  const i = argv.indexOf('--root');
  const repoRoot = path.resolve(i >= 0 && argv[i + 1] ? argv[i + 1] : path.join(__dirname, '..', '..'));
  let r;
  try {
    r = scanRepo(repoRoot);
  } catch (e) {
    console.error(`✋ secret scan ERROR — could not complete: ${e.message}`);
    return 2;
  }
  const fmt = (x) => `   ${x.file}:${x.line}   [${x.rule}]   value hidden (${x.length} chars, sha256 ${x.sha256})`;
  console.log(`   secret scan: ${r.scanned} files in the functions deploy package (tracked + untracked)`);
  if (r.unsupportedIgnore.length) console.log(`   note: ignore pattern(s) not applied (scanned anyway): ${r.unsupportedIgnore.join(', ')}`);
  if (r.binary.length) console.log(`   note: skipped ${r.binary.length} binary file(s): ${r.binary.slice(0, 5).join(', ')}${r.binary.length > 5 ? ', …' : ''}`);
  if (r.allowed.length) console.log(`   ${r.allowed.length} allow-listed finding(s) (${ALLOW_FILE}) — not blocking`);
  for (const s of r.stale) console.log(`   ⚠ stale ${ALLOW_FILE} entry (matches nothing — remove it): ${s.file} [${s.rule}]`);
  if (r.warnings.length) {
    console.log(`   ⚠ ${r.warnings.length} possible secret(s) — generic pattern, NOT blocking; please review:`);
    r.warnings.forEach((w) => console.log(fmt(w)));
  }
  if (r.blocked.length) {
    console.log(`✋ DEPLOY BLOCKED — ${r.blocked.length} hardcoded secret(s) in files that would be uploaded:`);
    r.blocked.forEach((b) => console.log(fmt(b)));
    console.log('   Fix: move the value to Secret Manager (defineSecret("NAME") + `firebase functions:secrets:set NAME`)');
    console.log('   and rotate it if it was ever committed or deployed. Confirmed false positive? Add an exact');
    console.log(`   entry to ${ALLOW_FILE} (file + rule + sha256 + reason + approvedBy) and get it reviewed.`);
    return 1;
  }
  console.log(`   ✓ secret scan: clean${r.allowed.length ? ` (${r.allowed.length} allow-listed)` : ''}`);
  return 0;
}

module.exports = { RULES, scanText, listDeployFiles, loadAllowlist, scanRepo, sha256 };

if (require.main === module) {
  let code;
  try {
    code = main(process.argv.slice(2));
  } catch (e) {
    console.error(`✋ secret scan ERROR — could not complete: ${e && e.message}`);
    code = 2;
  }
  process.exit(code);
}
