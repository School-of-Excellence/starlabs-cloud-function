#!/usr/bin/env node
/*
 * generate-manifest.js — emit functions-manifest.json (repo root), the machine-readable inventory
 * of every exported Cloud Function (master plan 2026-07-02, L14/L19).
 *
 * Consumers:
 *  - the PREDEPLOY loop-guard (hub cf-guards/no-retrigger-loop.spec.ts) — seeds each Firestore
 *    trigger path in the emulator and asserts bounded executions;
 *  - the POSTDEPLOY reporter (scripts/cicd/postdeploy.js) — tells the release console which
 *    functions a deploy shipped (CF Board Dev/Prod matrix);
 *  - the console's listCfBranches — Δfunctions names + types per branch.
 *
 * Parsing reuses the proven approach of functions/predeploy-check.js + loopDetector.js:
 * index.js `exports.X = module.fn` + `const module = require("./components/…")`, then per-function
 * type/trigger detection in the component source. DETERMINISTIC output (sorted, no timestamps) so
 * the CI freshness check (`git diff --exit-code`) works.
 *
 * Run: node scripts/cicd/generate-manifest.js   (from the repo root; also runs inside predeploy)
 */
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FUNCTIONS_DIR = path.join(REPO_ROOT, 'functions');
const OUT = path.join(REPO_ROOT, 'functions-manifest.json');

function removeComments(code) {
  return code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function parseIndexFile(indexPath) {
  let content = fs.readFileSync(indexPath, 'utf8');
  content = removeComments(content);
  const requires = {};
  const requireRegex = /const\s+(\w+)\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g;
  let m;
  while ((m = requireRegex.exec(content)) !== null) requires[m[1]] = m[2];
  const functions = [];
  const seen = new Set();
  // (a) re-export form — the repo convention: `exports.X = module.fn` (body lives in the component file).
  const reexportRegex = /exports\.(\w+)\s*=\s*(\w+)\.(\w+)/g;
  while ((m = reexportRegex.exec(content)) !== null) {
    if (seen.has(m[1])) continue;
    functions.push({ kind: 'reexport', exportName: m[1], moduleName: m[2], functionName: m[3] });
    seen.add(m[1]);
  }
  // (b) INLINE form — `exports.X = onDocumentCreated(...)` defined directly in index.js (body is HERE,
  //     not in a component file). Without this, inline functions are invisible to the manifest and thus
  //     ungated by the loop-guard — the testHUB miss, 2026-07-05.
  const inlineRegex = /exports\.(\w+)\s*=\s*[\w.]+\s*\(/g;
  while ((m = inlineRegex.exec(content)) !== null) {
    if (seen.has(m[1])) continue;
    functions.push({ kind: 'inline', exportName: m[1] });
    seen.add(m[1]);
  }
  return { requires, functions, indexContent: content };
}

function readComponentFiles(requires, indexDir) {
  const files = {};
  for (const p of new Set(Object.values(requires))) {
    const f = path.resolve(indexDir, p + '.js');
    files[p] = fs.existsSync(f) ? removeComments(fs.readFileSync(f, 'utf8')) : null;
  }
  return files;
}

function functionBody(content, functionName) {
  const patterns = [`exports.${functionName}`, `const ${functionName}`, `module.exports.${functionName}`];
  for (const p of patterns) {
    const i = content.indexOf(p);
    if (i !== -1) return content.substring(i, i + 5000);
  }
  return '';
}

function detectType(body) {
  if (/onRequest|https\.onRequest/.test(body)) return 'onRequest';
  if (/onCall|https\.onCall/.test(body)) return 'onCall';
  if (/onSchedule|pubsub\.schedule|schedule\(/.test(body)) return 'onSchedule';
  if (/onMessagePublished|pubsub\.topic/.test(body)) return 'onMessagePublished';
  if (/onDocumentCreated|\.onCreate\(/.test(body)) return 'onDocumentCreated';
  if (/onDocumentUpdated|\.onUpdate\(/.test(body)) return 'onDocumentUpdated';
  if (/onDocumentWritten|\.onWrite\(/.test(body)) return 'onDocumentWritten';
  if (/onDocumentDeleted|\.onDelete\(/.test(body)) return 'onDocumentDeleted';
  return 'UNKNOWN';
}

/** Firestore trigger path + (optional) named database — string arg, object-opts arg, or v1 .document(). */
function detectTrigger(body) {
  const patterns = [
    /onDocument(?:Written|Updated|Created|Deleted)\s*\(\s*["']([^"']+)["']/,       // v2 string arg
    /onDocument(?:Written|Updated|Created|Deleted)\s*\(\s*\{[^}]*?document:\s*["']([^"']+)["']/, // v2 opts object
    /\.document\s*\(\s*["']([^"']+)["']\s*\)/,                                     // v1 .document()
  ];
  let triggerPath;
  for (const re of patterns) {
    const m = body.match(re);
    if (m) { triggerPath = m[1]; break; }
  }
  if (!triggerPath) return {};
  const db = body.match(/database:\s*["']([^"']+)["']/);
  return { triggerPath, ...(db ? { database: db[1] } : {}) };
}

function exportedNames(indexPath) {
  if (!fs.existsSync(indexPath)) return new Set();
  const { functions } = parseIndexFile(indexPath);
  return new Set(functions.map((f) => f.exportName));
}

function main() {
  const indexPath = path.join(FUNCTIONS_DIR, 'index.js');
  const { requires, functions, indexContent } = parseIndexFile(indexPath);
  const files = readComponentFiles(requires, FUNCTIONS_DIR);
  // The emulator boots the FILTERED entry — flag which functions it actually loads, so the
  // loop-guard can report "no coverage" honestly instead of false-passing (hub cf-predeploy.sh).
  const emulatorExports = exportedNames(path.join(FUNCTIONS_DIR, 'index.emulator.js'));

  const out = functions
    .map((f) => {
      let body;
      let file;
      if (f.kind === 'inline') {
        body = functionBody(indexContent, f.exportName); // defined inline in index.js
        file = 'index.js';
      } else {
        const reqPath = requires[f.moduleName];
        const content = reqPath ? files[reqPath] : null;
        body = content ? functionBody(content, f.functionName) : '';
        file = reqPath ? `${reqPath.replace(/^\.\//, '')}.js` : undefined;
      }
      const type = body ? detectType(body) : 'UNKNOWN';
      return {
        name: f.exportName,
        type,
        file,
        ...detectTrigger(body),
        emulatorLoaded: emulatorExports.has(f.exportName),
        codebase: 'default',
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  fs.writeFileSync(OUT, JSON.stringify({ version: 1, functions: out }, null, 2) + '\n');
  const triggers = out.filter((f) => f.triggerPath).length;
  console.log(`functions-manifest.json: ${out.length} functions (${triggers} Firestore triggers, ${out.filter((f) => f.emulatorLoaded).length} emulator-loaded)`);
}

try {
  main();
} catch (e) {
  console.error('generate-manifest failed:', e.message);
  process.exit(1);
}
