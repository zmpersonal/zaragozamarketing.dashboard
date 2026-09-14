// prove/apply-known-senders.mjs turns the sent-mail backfill into the SQL that
// is applied at setup (local file now, production D1 at deploy): our own
// domain is filtered out, since a colleague copied on a thread says nothing
// about whether a sender is a customer. Repeatable and idempotent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

// The backfill's output shape, fabricated addresses.
const BACKFILL = `-- known_sender backfill from sent mail.
INSERT INTO known_sender (address, first_seen_at, replied_at) VALUES
  ('dana@example.com', 100, 100),
  ('julian@inhousewellness.com', 110, 110),
  ('Ops@InHouseWellness.com', 120, 120),
  ('billing@mail.inhousewellness.com', 130, 130),
  ('someone@notinhousewellness.com', 140, 140),
  ('x@inhousewellness.com.example', 150, 150),
  ('o''brien@old.example', 160, 160)
ON CONFLICT (address) DO UPDATE SET replied_at = MIN(COALESCE(known_sender.replied_at, excluded.replied_at), excluded.replied_at);
`;
const KEPT = ["dana@example.com", "o'brien@old.example", 'someone@notinhousewellness.com', 'x@inhousewellness.com.example'];

function run(extra = (dir) => []) {
  const dir = mkdtempSync(join(tmpdir(), 'apply-known-'));
  const input = join(dir, 'backfill.sql');
  writeFileSync(input, BACKFILL, { mode: 0o600 });
  const out = join(dir, 'filtered.sql');
  const r = spawnSync(process.execPath, ['prove/apply-known-senders.mjs', '--in', input, '--out', out, ...extra(dir)], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  return { ...r, dir, input, out };
}

const freshDb = (file = ':memory:') => { const db = new DatabaseSync(file); db.exec(SCHEMA); return db; };
const addresses = (db) => db.prepare('SELECT address FROM known_sender ORDER BY address').all().map((r) => r.address);

test('own-domain addresses (any case, any subdomain) are filtered; lookalike domains are kept; counts are printed', () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  const db = freshDb();
  db.exec(readFileSync(r.out, 'utf8'));
  assert.deepEqual(addresses(db), KEPT);
  assert.match(r.stdout, /^INPUT ROWS: 7$/m);
  assert.match(r.stdout, /^FILTERED \(own domain inhousewellness\.com\): 3$/m);
  assert.match(r.stdout, /^TO APPLY: 4$/m);
  assert.equal((statSync(r.out).mode & 0o777).toString(8), '600');
  assert.doesNotMatch(r.stdout + r.stderr, /dana@|julian@|ops@/i, 'no addresses printed');
});

test('idempotent: applying twice changes nothing, and rows from an earlier unfiltered apply are removed', () => {
  const r = run();
  const sql = readFileSync(r.out, 'utf8');
  const db = freshDb();
  db.exec(BACKFILL); // the unfiltered file applied before this round
  assert.equal(addresses(db).length, 7);
  db.exec(sql);
  const once = db.prepare('SELECT * FROM known_sender ORDER BY address').all();
  db.exec(sql);
  assert.deepEqual(db.prepare('SELECT * FROM known_sender ORDER BY address').all(), once);
  assert.deepEqual(addresses(db), KEPT);
});

test('repeatable: the same input gives byte-identical output', () => {
  assert.equal(readFileSync(run().out, 'utf8'), readFileSync(run().out, 'utf8'));
});

test('the earliest reply is kept over a later one already in the database; a seen-never-replied row gains it', () => {
  const r = run();
  const db = freshDb();
  db.prepare('INSERT INTO known_sender (address, first_seen_at, replied_at) VALUES (?, 50, 500)').run('dana@example.com');
  db.prepare('INSERT INTO known_sender (address, first_seen_at, replied_at) VALUES (?, 50, NULL)').run("o'brien@old.example");
  db.exec(readFileSync(r.out, 'utf8'));
  assert.equal(db.prepare('SELECT replied_at FROM known_sender WHERE address = ?').get('dana@example.com').replied_at, 100);
  assert.equal(db.prepare('SELECT replied_at FROM known_sender WHERE address = ?').get("o'brien@old.example").replied_at, 160);
});

test('--sqlite applies to a local database file and reports before/after counts', () => {
  const r0 = run();
  const file = join(r0.dir, 'local.sqlite');
  const db = freshDb(file);
  db.exec(BACKFILL);
  db.close();
  const r = run(() => ['--sqlite', file]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^SQLITE .*: known_sender before 7 \(3 own domain\), after 4 \(0 own domain\)$/m);
  assert.deepEqual(addresses(new DatabaseSync(file)), KEPT);
});

test('--exclude-domain replaces the default and is repeatable', () => {
  const r = run(() => ['--exclude-domain', 'example.com', '--exclude-domain', 'old.example']);
  assert.equal(r.status, 0, r.stderr);
  const db = freshDb();
  db.exec(readFileSync(r.out, 'utf8'));
  assert.ok(!addresses(db).includes('dana@example.com') && !addresses(db).includes("o'brien@old.example"));
  assert.ok(addresses(db).includes('julian@inhousewellness.com'));
});

test('refuses output inside the repo and a malformed domain', () => {
  const inside = spawnSync(process.execPath, ['prove/apply-known-senders.mjs', '--in', run().input, '--out', join(ROOT, 'seeds', 'x.sql')], { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(inside.status, 0);
  assert.match(inside.stderr, /outside the repo/);
  assert.ok(!existsSync(join(ROOT, 'seeds', 'x.sql')));
  const bad = run(() => ['--exclude-domain', "x.com' OR 1=1 --"]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /domain/);
});
