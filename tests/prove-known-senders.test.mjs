// prove/backfill-known-senders.mjs: a one-off (not cron) that reads ALL sent
// mail and writes every recipient as a known_sender row to a SQL file outside
// the repo. It prints counts only: the file holds customer addresses, the
// terminal output does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVICE_ACCOUNT_JSON, PUBLIC_JWK, CLIENT_EMAIL, GMAIL_READONLY } from './helpers/google-sa.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const MAILBOX = 'support@inhousewellness.com';
const SCRIPT = 'prove/backfill-known-senders.mjs';

function run(args) {
  const dir = mkdtempSync(join(tmpdir(), 'prove-known-'));
  const keyFile = join(dir, 'key.json');
  writeFileSync(keyFile, SERVICE_ACCOUNT_JSON, { mode: 0o600 });
  const tokenLog = join(dir, 'tokens.log');
  const out = join(dir, 'known-senders.sql');
  const env = { ...process.env, GOOGLE_SERVICE_ACCOUNT_FILE: keyFile, PROVE_SA_PUBLIC_JWK: JSON.stringify(PUBLIC_JWK), PROVE_TOKEN_LOG: tokenLog };
  const r = spawnSync(process.execPath, ['--import', './tests/helpers/google-preload.mjs', SCRIPT, MAILBOX, ...args(out)], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000, env,
  });
  let tokens = [];
  try { tokens = readFileSync(tokenLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch {}
  return { ...r, out, tokens };
}

const EXPECTED = ['dana@example.com', 'hidden@old.example', "o'brien@old.example", 'other@example.com', 'plain@old.example', 'priya@acme.example', 'sam@example.com', 'someone@example.com'];

function apply(sqlFile) {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(sqlFile, 'utf8'));
  return db;
}

test('every recipient of all sent mail (To, Cc, Bcc, any age) lands in known_sender; our own mailbox does not', () => {
  const r = run((out) => ['--out', out]);
  assert.equal(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.ok(r.tokens.length > 0 && r.tokens.every((t) => t.ok && t.claims.sub === MAILBOX && t.claims.scope === GMAIL_READONLY));

  const db = apply(r.out);
  const rows = db.prepare('SELECT address, first_seen_at, replied_at FROM known_sender ORDER BY address').all();
  assert.deepEqual(rows.map((x) => x.address), EXPECTED);
  assert.ok(rows.every((x) => x.replied_at > 0 && x.first_seen_at === x.replied_at), 'replied_at set, so ingest exempts them');
  // The earliest send wins: Dana was written to yesterday AND 1000 days ago.
  const dana = rows.find((x) => x.address === 'dana@example.com');
  assert.ok(Math.abs(dana.replied_at - (Date.now() / 1000 - 1000 * 86400)) < 3600, String(dana.replied_at));

  assert.equal((statSync(r.out).mode & 0o777).toString(8), '600', 'customer data file is owner-only');
  assert.match(r.stdout, /^SENT MESSAGES SCANNED: 5$/m);
  assert.match(r.stdout, /^KNOWN SENDERS: 8$/m);
  assert.match(r.stdout, /^QUERY: in:sent$/m, 'no date bound: as far back as the mailbox goes');
});

test('prints counts only: no recipient address, no key material', () => {
  const r = run((out) => ['--out', out]);
  const printed = r.stdout + r.stderr;
  for (const a of EXPECTED) assert.ok(!printed.toLowerCase().includes(a), `printed ${a}`);
  assert.doesNotMatch(printed, /PRIVATE KEY/);
  assert.ok(!printed.includes(CLIENT_EMAIL));
});

test('re-applying the file, or applying it over rows ingest already wrote, is safe and keeps the earliest reply', () => {
  const r = run((out) => ['--out', out]);
  const db = apply(r.out);
  db.exec(readFileSync(r.out, 'utf8'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM known_sender').get().n, EXPECTED.length);

  const db2 = new DatabaseSync(':memory:');
  db2.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  db2.prepare('INSERT INTO known_sender (address, first_seen_at, replied_at) VALUES (?, 5, NULL)').run('dana@example.com');
  db2.exec(readFileSync(r.out, 'utf8'));
  assert.ok(db2.prepare('SELECT replied_at FROM known_sender WHERE address = ?').get('dana@example.com').replied_at > 0, 'a seen-but-never-replied row gains replied_at');
});

test('--max caps the scan and says so', () => {
  const r = run((out) => ['--out', out, '--max', '2']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^SENT MESSAGES SCANNED: 2 \(capped at --max 2; older sent mail not scanned\)$/m);
});

test('refuses to write inside the repo, or without --out', () => {
  const inside = run(() => ['--out', join(ROOT, 'seeds', 'known-senders.sql')]);
  assert.notEqual(inside.status, 0);
  assert.match(inside.stderr, /outside the repo/);
  assert.ok(!existsSync(join(ROOT, 'seeds', 'known-senders.sql')));
  const none = run(() => []);
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /--out/);
});

test('it is a one-off: nothing in src/ or wrangler.toml runs it', () => {
  const wrangler = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.ok(!wrangler.includes('backfill-known-senders'));
  const r = spawnSync('grep', ['-rl', 'backfill-known-senders', 'src'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.stdout.trim(), '');
});
