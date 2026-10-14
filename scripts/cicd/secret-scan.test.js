/*
 * Tests for scripts/cicd/secret-scan.js and its predeploy integration.  Run:  node --test scripts/cicd/
 *
 * FAKE CREDENTIALS ONLY: every secret-shaped value is generated at random when the test runs (fake()),
 * so no credential-looking literal is ever stored in this file (it would trip scanners and push
 * protection). Fixture repos live in os.tmpdir() — nothing is written into this repo.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const scanner = require('./secret-scan');
const SCANNER = path.join(__dirname, 'secret-scan.js');
const PREDEPLOY = path.join(__dirname, 'predeploy.js');

// --- fake credential factory (random at runtime) --------------------------------------------------
const UP = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOW = 'abcdefghijklmnopqrstuvwxyz';
const DIG = '0123456789';
const HEX = '0123456789abcdef';
const rnd = (n, set) => Array.from(crypto.randomBytes(n), (b) => set[b % set.length]).join('');
const ALNUM = UP + LOW + DIG;
const fake = {
  awsKeyId: () => 'AKIA' + rnd(16, UP + DIG),
  awsSecret: () => rnd(40, ALNUM + '/+'),
  googleKey: () => 'AIza' + rnd(35, ALNUM + '_-'),
  slackWebhook: () => `https://hooks.slack.com/services/T${rnd(10, UP + DIG)}/B${rnd(10, UP + DIG)}/${rnd(24, ALNUM)}`,
  slackToken: () => 'xoxb-' + rnd(12, DIG) + '-' + rnd(24, ALNUM),
  githubToken: () => 'ghp_' + rnd(36, ALNUM),
  stripeLive: () => 'sk_' + 'live_' + rnd(24, ALNUM),
  sendgrid: () => 'SG.' + rnd(22, ALNUM + '_-') + '.' + rnd(43, ALNUM + '_-'),
  privateKey: () => ['-----BEGIN ', 'PRIVATE KEY-----'].join('') + '\n' + rnd(64, ALNUM) + '\n-----END PRIVATE KEY-----',
  saJson: () => JSON.stringify({ type: 'service_account', private_key_id: rnd(40, HEX) }, null, 1),
  urlCreds: () => `postgres://admin:${rnd(14, ALNUM)}@db.example.internal:5432/app`,
  jwt: () => ['eyJ' + rnd(20, ALNUM), 'eyJ' + rnd(30, ALNUM), rnd(43, ALNUM + '_-')].join('.'),
  password: () => rnd(10, ALNUM) + rnd(2, UP) + rnd(2, DIG) + rnd(2, LOW), // always mixed → not identifier-like
  ngrok: () => '2' + rnd(24, ALNUM) + rnd(1, UP) + rnd(1, LOW) + '_' + rnd(1, DIG) + rnd(20, ALNUM),
  // a prefix-less random credential (any vendor): 40 random chars, guaranteed upper+lower+digit
  opaque: () => rnd(34, ALNUM) + rnd(2, UP) + rnd(2, LOW) + rnd(2, DIG),
};
const entropyOf = (s) => {
  const c = {};
  for (const ch of s) c[ch] = (c[ch] || 0) + 1;
  return Object.values(c).reduce((h, n) => h - (n / s.length) * Math.log2(n / s.length), 0);
};

// --- temp fixture repo -----------------------------------------------------------------------------
function fixtureRepo({ ignore, files = {}, allow } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-'));
  const fn = { source: 'functions', codebase: 'default' };
  if (ignore !== undefined) fn.ignore = ignore;
  fs.writeFileSync(path.join(root, 'firebase.json'), JSON.stringify({ functions: [fn] }));
  fs.mkdirSync(path.join(root, 'functions'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  if (allow) fs.writeFileSync(path.join(root, '.secretscan-allow.json'), JSON.stringify(allow, null, 2));
  return root;
}
const REAL_IGNORE = ['node_modules', '.git', 'firebase-debug.log', 'firebase-debug.*.log', '*.local', 'test', 'docs'];
const runCli = (root) => spawnSync(process.execPath, [SCANNER, '--root', root], { encoding: 'utf8' });
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');

// === 1. every high-confidence rule blocks ===========================================================
const BLOCKING = [
  ['aws-access-key-id', () => `const id = "${fake.awsKeyId()}";`],
  ['aws-secret-access-key', () => `const awsSecretAccessKey = "${fake.awsSecret()}";`],
  ['google-api-key', () => `const k = "${fake.googleKey()}";`],
  ['slack-webhook-url', () => `const hook = "${fake.slackWebhook()}";`],
  ['slack-token', () => `const t = '${fake.slackToken()}';`],
  ['github-token', () => `const g = "${fake.githubToken()}";`],
  ['stripe-live-key', () => `const s = "${fake.stripeLive()}";`],
  ['sendgrid-api-key', () => `const m = "${fake.sendgrid()}";`],
  ['private-key-block', () => fake.privateKey()],
  ['gcp-service-account-key', () => fake.saJson()],
  ['url-with-credentials', () => `const db = "${fake.urlCreds()}";`],
  ['jwt', () => `const tok = "${fake.jwt()}";`],
  ['ngrok-authtoken', () => `const xyz = "${fake.ngrok()}";`],
  ['high-entropy-string', () => `const xyz = "${fake.opaque()}";`], // no prefix, meaningless name
];
for (const [rule, make] of BLOCKING) {
  test(`blocks: ${rule}`, () => {
    const findings = scanner.scanText(make(), 'functions/x.js');
    const hit = findings.find((f) => f.rule === rule);
    assert.ok(hit, `expected rule ${rule}, got ${JSON.stringify(findings.map((f) => f.rule))}`);
    assert.equal(hit.severity, 'block');
    assert.equal(hit.file, 'functions/x.js');
    assert.ok(hit.line >= 1);
  });
}

test('regression: prefix-less token under a meaningless name (const xyz = "...") is BLOCKED', () => {
  // The miss reported 2026-10-13: an ngrok-shaped token in salescrm-updates.js passed the scan.
  for (const v of [fake.ngrok(), fake.opaque(), fake.opaque().replace(/.{8}$/, '+/=A9b8Q')]) {
    const findings = scanner.scanText(`    const xyz = "${v}";`, 'functions/components/salescrm-updates.js');
    assert.ok(findings.some((f) => f.severity === 'block'), `not blocked: entropy=${entropyOf(v).toFixed(2)}`);
  }
});

test('a value matched by a specific rule is reported ONCE (no duplicate high-entropy finding)', () => {
  for (const v of [fake.googleKey(), fake.ngrok(), fake.githubToken()]) {
    const findings = scanner.scanText(`const k = "${v}";`, 'functions/a.js');
    assert.equal(findings.length, 1, JSON.stringify(findings.map((f) => f.rule)));
    assert.notEqual(findings[0].rule, 'high-entropy-string');
  }
});

test('high-entropy rule ignores the false positives found in this codebase', () => {
  const docId = () => rnd(20, ALNUM);
  const text = [
    "const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';", // id alphabet
    `const ref = "appointments/${docId()}${docId()}";`, // collection/docId path
    `const ref2 = "participantsproduct/${docId()}/items/${docId()}";`,
    `const u = "https://storage.googleapis.com/${docId()}${docId()}";`, // URL
    `const p = "/v1/projects/${docId()}${docId()}";`, // absolute path
    `const h = "${rnd(64, HEX)}";`, // hex digest — no upper case
    `const t = "${rnd(40, LOW + DIG)}";`, // lower+digit only
    `const short = "${rnd(31, ALNUM)}";`, // below 32 chars
    'const name = "appointmentZoomIntegrationWebhookCollectionV2";', // long identifier
  ].join('\n');
  const findings = scanner.scanText(text, 'functions/components/x.js');
  assert.deepEqual(findings.map((f) => `${f.line}:${f.rule}`), []);
});

test('lockfile integrity hashes are not high-entropy findings (format rules still apply there)', () => {
  const integrity = `"integrity": "sha512-${rnd(86, ALNUM + '+/')}=="`;
  assert.deepEqual(scanner.scanText(integrity, 'functions/package-lock.json'), []);
  const leaked = `"x": "${fake.githubToken()}"`;
  assert.equal(scanner.scanText(leaked, 'functions/package-lock.json')[0].rule, 'github-token');
});

test('reports the correct line number', () => {
  const text = `// one\n// two\nconst hook = "${fake.slackWebhook()}";\n`;
  const [hit] = scanner.scanText(text, 'functions/a.js');
  assert.equal(hit.line, 3);
});

// === 2. legitimate runtime secret access is NOT flagged ===========================================
test('defineSecret(), process.env and secret NAMES are not findings', () => {
  const text = [
    'const { defineSecret } = require("firebase-functions/params");',
    'const SLACK_TOKEN = defineSecret("SLACK_WEBHOOK_SECRET_TOKEN");',
    'const pw = process.env.DB_PASSWORD;',
    'const key = process.env.POD_CONTROLLER_WEB_API_KEY || fallback;',
    'exports.f = onRequest({ secrets: [SLACK_TOKEN, "ZOOM_CLIENTSECRET"] }, h);',
    'const url = await commonService.getWebhookUrl("slackWorkshopQandAWebhook");',
    'const WS_SECRET_COLLECTION = "workshopsecrets";',
    'const BUCKET = "openvidu-appdata-bucket-0123456789";',
    "watitemplateid: 'app_slot_reminder_template_v2',",
  ].join('\n');
  assert.deepEqual(scanner.scanText(text, 'functions/ok.js'), []);
});

test('generic password assignment is a WARNING, not a block', () => {
  const findings = scanner.scanText(`const dbPassword = "${fake.password()}";`, 'functions/w.js');
  assert.ok(findings.length >= 1);
  assert.ok(findings.every((f) => f.severity === 'warn'), JSON.stringify(findings));
});

test('generic rule ignores obvious placeholders', () => {
  const text = 'const password = "changeme123";\nconst apiKey = "your-api-key-here";\nconst token = "${TOKEN}";';
  assert.deepEqual(scanner.scanText(text, 'functions/p.js'), []);
});

// === 3. masking: the value never leaves the scanner ===============================================
test('findings never contain the secret value', () => {
  const value = fake.slackWebhook();
  const [hit] = scanner.scanText(`const h = "${value}";`, 'functions/m.js');
  const serialized = JSON.stringify(hit);
  assert.ok(!serialized.includes(value));
  assert.ok(!serialized.includes(value.slice(-12)), 'no tail fragment either');
  assert.equal(hit.sha256, sha(value));
  assert.equal(hit.length, value.length);
});

test('CLI output never contains the secret value', () => {
  const value = fake.awsKeyId();
  const root = fixtureRepo({ ignore: REAL_IGNORE, files: { 'functions/index.js': `const k = "${value}";\n` } });
  const r = runCli(root);
  assert.equal(r.status, 1);
  assert.ok(!(r.stdout + r.stderr).includes(value));
  assert.ok(!(r.stdout + r.stderr).includes(value.slice(4)));
  assert.match(r.stdout, /functions\/index\.js:1/);
  assert.match(r.stdout, /aws-access-key-id/);
});

// === 4. which files are scanned (= what firebase deploy uploads) ==================================
test('scans UNTRACKED files (no git involved) and nested dirs', () => {
  const root = fixtureRepo({ ignore: REAL_IGNORE, files: { 'functions/components/deep/x.js': `"${fake.githubToken()}"` } });
  const r = runCli(root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /functions\/components\/deep\/x\.js:1/);
});

test('honours firebase.json ignore rules (basename match anywhere, globs, dotfiles)', () => {
  const s = fake.slackWebhook();
  const root = fixtureRepo({
    ignore: REAL_IGNORE,
    files: {
      'functions/index.js': 'module.exports = {};\n',
      'functions/test/fixture.js': `"${s}"`, // ignored: "test"
      'functions/sub/test/fixture.js': `"${s}"`, // ignored: matchBase → any depth
      'functions/docs/readme.md': `"${s}"`, // ignored: "docs"
      'functions/node_modules/pkg/index.js': `"${s}"`, // ignored: "node_modules"
      'functions/.secret.local': `TOKEN=${fake.slackToken()}`, // ignored: "*.local" (dot:true)
      'functions/firebase-debug.2.log': `"${s}"`, // ignored: "firebase-debug.*.log"
    },
  });
  const r = runCli(root);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('a dotfile that is NOT ignored is scanned (e.g. .env.<project>)', () => {
  const root = fixtureRepo({ ignore: REAL_IGNORE, files: { 'functions/.env.myproj': `SLACK_HOOK=${fake.slackWebhook()}\n` } });
  assert.equal(runCli(root).status, 1);
});

test('no ignore key in firebase.json → firebase defaults (node_modules, .git) and nothing else', () => {
  const root = fixtureRepo({
    files: {
      'functions/node_modules/x.js': `"${fake.githubToken()}"`,
      'functions/test/x.js': `"${fake.githubToken()}"`, // NOT ignored without an ignore list
    },
  });
  const r = runCli(root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /functions\/test\/x\.js/);
  assert.doesNotMatch(r.stdout, /node_modules/);
});

test('unsupported ignore pattern is NOT applied (scan more, never less)', () => {
  const root = fixtureRepo({ ignore: ['node_modules', 'sub/**'], files: { 'functions/sub/x.js': `"${fake.githubToken()}"` } });
  assert.equal(runCli(root).status, 1);
});

test('files outside the functions source are out of scope (not uploaded)', () => {
  // Scope is the functions upload; a secret outside functions/ is CI's job (gitleaks), not predeploy's.
  const root = fixtureRepo({ ignore: REAL_IGNORE, files: { 'functions/index.js': '', 'outside.js': `"${fake.githubToken()}"` } });
  assert.equal(runCli(root).status, 0);
});

test('binary files are skipped and listed', () => {
  const root = fixtureRepo({ ignore: REAL_IGNORE, files: { 'functions/index.js': '' } });
  fs.writeFileSync(path.join(root, 'functions', 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]));
  const r = runCli(root);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /binary/i);
});

// === 5. allow-list: exact, narrow, documented ======================================================
test('allow-list suppresses ONLY the exact value in the exact file for the exact rule', () => {
  const key = fake.googleKey();
  const other = fake.googleKey();
  const allow = { version: 1, entries: [{ file: 'functions/a.js', rule: 'google-api-key', sha256: sha(key), reason: 'public Firebase web API key used for identitytoolkit', approvedBy: 'test' }] };
  const root = fixtureRepo({
    ignore: REAL_IGNORE,
    allow,
    files: {
      'functions/a.js': `const k = "${key}";\n`, // allowed
      'functions/b.js': `const k = "${key}";\n`, // same value, other file → BLOCK
      'functions/c.js': `const k = "${other}";\n`, // other value → BLOCK
    },
  });
  const r = runCli(root);
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout, /functions\/a\.js:1 /);
  assert.match(r.stdout, /functions\/b\.js:1/);
  assert.match(r.stdout, /functions\/c\.js:1/);
  assert.match(r.stdout, /1 allow-listed/);
});

test('allow-listed value alone → clean exit', () => {
  const key = fake.googleKey();
  const allow = { version: 1, entries: [{ file: 'functions/a.js', rule: 'google-api-key', sha256: sha(key), reason: 'public web key', approvedBy: 'test' }] };
  const root = fixtureRepo({ ignore: REAL_IGNORE, allow, files: { 'functions/a.js': `"${key}"` } });
  assert.equal(runCli(root).status, 0);
});

for (const [name, entry] of [
  ['missing reason', { file: 'functions/a.js', rule: 'google-api-key', sha256: 'a'.repeat(64), approvedBy: 'x' }],
  ['wildcard file', { file: 'functions/*.js', rule: 'google-api-key', sha256: 'a'.repeat(64), reason: 'r', approvedBy: 'x' }],
  ['bad hash', { file: 'functions/a.js', rule: 'google-api-key', sha256: 'abc', reason: 'r', approvedBy: 'x' }],
  ['unknown rule', { file: 'functions/a.js', rule: '*', sha256: 'a'.repeat(64), reason: 'r', approvedBy: 'x' }],
]) {
  test(`malformed allow-list (${name}) → scanner error exit 2 (fail closed)`, () => {
    const root = fixtureRepo({ ignore: REAL_IGNORE, allow: { version: 1, entries: [entry] }, files: { 'functions/a.js': '' } });
    assert.equal(runCli(root).status, 2);
  });
}

// === 6. fail closed ================================================================================
test('missing firebase.json → exit 2', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-'));
  assert.equal(runCli(root).status, 2);
});

test('invalid firebase.json → exit 2', () => {
  const root = fixtureRepo({ ignore: REAL_IGNORE, files: { 'functions/a.js': '' } });
  fs.writeFileSync(path.join(root, 'firebase.json'), '{ not json');
  assert.equal(runCli(root).status, 2);
});

test('functions source directory missing → exit 2', () => {
  const root = fixtureRepo({ ignore: REAL_IGNORE });
  fs.rmSync(path.join(root, 'functions'), { recursive: true });
  assert.equal(runCli(root).status, 2);
});

test('clean package → exit 0 with a pass line', () => {
  const root = fixtureRepo({ ignore: REAL_IGNORE, files: { 'functions/index.js': 'exports.a = 1;\n' } });
  const r = runCli(root);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /secret scan: clean/i);
});

// === 7. predeploy integration: scan runs FIRST, before every early exit ===========================
// A throwaway copy of the repo's scripts/cicd + a fixture functions/ — predeploy.js resolves REPO_ROOT from
// its own location, so the copy scans the fixture, never this repo. SKIP_TEST=1 is the strongest early
// exit: if the scan still blocks under it, it blocks under the menu and the fast path too.
function predeployFixture(files) {
  const root = fixtureRepo({ ignore: REAL_IGNORE, files });
  fs.mkdirSync(path.join(root, 'scripts', 'cicd'), { recursive: true });
  for (const f of ['predeploy.js', 'secret-scan.js', 'generate-manifest.js']) {
    fs.copyFileSync(path.join(__dirname, f), path.join(root, 'scripts', 'cicd', f));
  }
  return root;
}
const runPredeploy = (root) =>
  spawnSync(process.execPath, [path.join(root, 'scripts', 'cicd', 'predeploy.js')], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SKIP_TEST: '1' },
    timeout: 60000,
  });

test('predeploy BLOCKS (exit 1) on a secret even with SKIP_TEST=1, before gh/manifest/loop-guard', () => {
  const value = fake.slackWebhook();
  const root = predeployFixture({ 'functions/index.js': `const h = "${value}";\n` });
  const r = runPredeploy(root);
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 1, out);
  assert.match(out, /DEPLOY BLOCKED/);
  assert.match(out, /functions\/index\.js:1/);
  assert.ok(!out.includes(value), 'value must not be printed');
  assert.doesNotMatch(out, /functions-manifest\.json:|LOOP-GUARD|loop-guard for|not logged in/, 'nothing after the scan may run');
});

test('predeploy BLOCKS when the scanner itself is missing (fail closed)', () => {
  const root = predeployFixture({ 'functions/index.js': 'exports.a = 1;\n' });
  fs.rmSync(path.join(root, 'scripts', 'cicd', 'secret-scan.js'));
  const r = runPredeploy(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /secret scan could not complete/i);
});

test('predeploy BLOCKS when the scanner errors (malformed allow-list)', () => {
  const root = predeployFixture({ 'functions/index.js': 'exports.a = 1;\n' });
  fs.writeFileSync(path.join(root, '.secretscan-allow.json'), '{ broken');
  const r = runPredeploy(root);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /secret scan could not complete/i);
});

test('predeploy PASSES the scan on clean code and continues to the existing checks', () => {
  const root = predeployFixture({ 'functions/index.js': 'exports.a = 1;\n' });
  const r = runPredeploy(root);
  const out = r.stdout + r.stderr;
  assert.match(out, /secret scan: clean/i);
  assert.doesNotMatch(out, /DEPLOY BLOCKED/);
  // The flow moved on to the pre-existing gates (gh auth → manifest → scope → SKIP_TEST skip). Whether it
  // ends 0 depends on this machine's `gh auth`, so assert progress past the scan, not the final code.
  assert.match(out, /functions-manifest\.json:|manifest generation failed|not logged in to the GitHub CLI|LOOP-GUARD SKIPPED/);
});
