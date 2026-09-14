// Quo ingest is bounded per run, like Gmail: a stored cursor, a bounded first
// run, a cap on conversations read per run, and a budget over fetches and D1
// queries. Whatever doesn't fit waits in the cursor for the next run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestQuo, QUO_LIMITS } from '../src/ingest/quo.ts';
import { makeQuoEnv, makeQuoAccount, withQuo, SOURCE_ID } from './helpers/quo.mjs';

const T0 = 1789480800; // Tue 2026-09-15 09:00 CDT
const MIN = 60;
const DAY = 86400;

/** Count D1 statements the way Cloudflare does: one per run/all/first/raw, one per statement in a batch. */
function countingDb(db) {
  const counter = { queries: 0 };
  const wrapStmt = (stmt) => ({
    bind: (...a) => wrapStmt(stmt.bind(...a)),
    run: () => { counter.queries++; return stmt.run(); },
    all: () => { counter.queries++; return stmt.all(); },
    first: () => { counter.queries++; return stmt.first(); },
    _inner: stmt,
  });
  return { counter, db: { ...db, prepare: (sql) => wrapStmt(db.prepare(sql)), batch: (stmts) => { counter.queries += stmts.length; return db.batch(stmts.map((x) => x._inner ?? x)); } } };
}

async function run(env, account, nowSec, opts = {}) {
  const logs = [];
  const real = { log: console.log, error: console.error, warn: console.warn, now: Date.now };
  console.log = console.warn = (...a) => logs.push(a.map(String).join(' '));
  console.error = (...a) => logs.push('ERROR ' + a.map(String).join(' '));
  Date.now = () => nowSec * 1000;
  const before = account.requests.length;
  const { db, counter } = countingDb(env.DB);
  try { await withQuo(account, () => ingestQuo({ ...env, DB: db }), opts); }
  finally { Object.assign(console, { log: real.log, error: real.error, warn: real.warn }); Date.now = real.now; }
  const requests = account.requests.slice(before);
  const raw = (await env.DB.prepare('SELECT sync_cursor FROM source WHERE id = ?1').bind(SOURCE_ID).first()).sync_cursor;
  return { logs, requests, fetches: requests.length, queries: counter.queries, cursor: raw ? JSON.parse(raw) : null };
}

const count = async (env) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM thread').first()).n;
const phone = (i) => `+1512555${String(1000 + i).slice(-4)}`;
const readsOf = (requests, i) => requests.filter((u) => u.pathname !== '/v1/conversations' && u.searchParams.getAll('participants').includes(phone(i)));

function busyAccount(n) {
  const account = makeQuoAccount();
  for (let i = 0; i < n; i++) {
    account.conversation(`CN${i}`, { participants: [phone(i)], createdAt: T0 - 20 * DAY });
    account.text(`CN${i}`, T0 - (i + 1) * 3600, 'incoming'); // all inside the 30-day window
  }
  account.conversation('CN-OLD', { participants: [phone(999)], createdAt: T0 - 60 * DAY });
  account.text('CN-OLD', T0 - 45 * DAY, 'incoming'); // outside it
  return account;
}

// --- empty cursor: bounded first run ------------------------------------------------------

test('empty cursor: the first run is bounded, and later runs catch up without re-reading or going past 30 days', async () => {
  const env = makeQuoEnv();
  const total = QUO_LIMITS.conversationsPerRun * 2 + 5;
  const account = busyAccount(total);

  const first = await run(env, account, T0, { pageSize: 10 });
  assert.equal(await count(env), QUO_LIMITS.conversationsPerRun, 'first run reads at most conversationsPerRun');
  assert.ok(first.requests.filter((u) => u.pathname === '/v1/conversations').length <= QUO_LIMITS.listPagesPerRun);
  assert.equal(first.cursor.highWater, null, 'not advanced until the whole window is read');
  assert.ok(first.cursor.scan && (first.cursor.scan.pending.length > 0 || first.cursor.scan.pageToken), 'the rest is queued or behind the stored page token');
  assert.ok(first.logs.some((l) => l.includes('mode=backfill')), first.logs.join('\n'));

  let r;
  for (let i = 1; i <= 5 && (i === 1 || r.cursor.scan); i++) r = await run(env, account, T0 + i * 5 * MIN, { pageSize: 10 });
  assert.equal(r.cursor.scan, null, 'scan finished');
  assert.equal(await count(env), total, 'every conversation in the window ingested');
  assert.equal(r.cursor.highWater, T0, 'cursor = when the completed scan started');
  const all = account.requests;
  assert.equal(readsOf(all, 999).length, 0, 'the conversation outside 30 days is never read');
  for (let i = 0; i < total; i++) assert.equal(readsOf(all, i).filter((u) => u.pathname === '/v1/messages').length, 1, `CN${i} read once`);
});

// --- normal incremental run -----------------------------------------------------------------

test('incremental: only conversations with new activity are read, from the cursor with a small overlap', async () => {
  const env = makeQuoEnv();
  const account = busyAccount(5);
  await run(env, account, T0);
  assert.equal((await run(env, account, T0 + 5 * MIN)).cursor.highWater, T0 + 5 * MIN);

  account.text('CN3', T0 + 7 * MIN, 'outgoing');
  const r = await run(env, account, T0 + 10 * MIN);
  const read = r.requests.filter((u) => u.pathname === '/v1/messages');
  assert.equal(read.length, 1);
  assert.deepEqual(read[0].searchParams.getAll('participants'), [phone(3)]);
  assert.equal(Date.parse(read[0].searchParams.get('createdAfter')) / 1000, T0 + 5 * MIN - 5 * MIN);
  assert.equal(r.cursor.highWater, T0 + 10 * MIN);
  assert.equal(r.cursor.scan, null);
  assert.equal((await env.DB.prepare('SELECT status FROM thread WHERE id = ?').bind('quo:CN3').first()).status, 'answered');
  assert.ok(r.logs.some((l) => l.includes('mode=incremental')), r.logs.join('\n'));
});

test('activity on a conversation read early in a multi-run scan is not lost when the scan ends', async () => {
  const env = makeQuoEnv();
  const account = busyAccount(QUO_LIMITS.conversationsPerRun * 2 + 5);
  await run(env, account, T0, { pageSize: 10 }); // CN0 (newest) is read in this run
  account.text('CN0', T0 + 2 * MIN, 'incoming');   // after it was read, before the scan finishes
  let r;
  for (let i = 1; i <= 5; i++) { r = await run(env, account, T0 + i * 10 * MIN, { pageSize: 10 }); if (!r.cursor.scan) break; }
  assert.ok(r.cursor.scan === null, 'the scan spanned runs and completed');
  await run(env, account, T0 + 60 * MIN, { pageSize: 10 });
  assert.equal((await env.DB.prepare('SELECT last_inbound_at FROM thread WHERE id = ?').bind('quo:CN0').first()).last_inbound_at, T0 + 2 * MIN);
});

// --- over budget ------------------------------------------------------------------------------

test('over budget: a run stops inside its fetch and query budget; the rest waits and nothing is half-written', async () => {
  const env = makeQuoEnv();
  env.INGEST_MAX_SUBREQUESTS = '40';
  env.INGEST_MAX_D1_QUERIES = '30';
  const account = busyAccount(12);
  for (let i = 0; i < 12; i++) account.text(`CN${i}`, T0 - (i + 1) * 3600 + 60, 'outgoing'); // one completed wait each

  const first = await run(env, account, T0);
  assert.ok(first.fetches + first.queries <= 40, `subrequests ${first.fetches}+${first.queries}`);
  assert.ok(first.queries <= 30, `d1 ${first.queries}`);
  const done = await count(env);
  assert.ok(done > 0 && done < 12, `partial progress (${done})`);
  assert.equal(first.cursor.scan.pending.length, 12 - done);
  const responses = (await env.DB.prepare('SELECT COUNT(*) AS n FROM response').first()).n;
  assert.equal(responses, done, 'every synced conversation has its response row; none half-written');

  let r;
  for (let i = 1; i <= 10; i++) { r = await run(env, account, T0 + i * 5 * MIN); assert.ok(r.fetches + r.queries <= 40 && r.queries <= 30); if (!r.cursor.scan) break; }
  assert.equal(await count(env), 12);
  assert.equal(r.cursor.highWater, T0);
});

test('one listing page bigger than the per-run cap still reads at most conversationsPerRun', async () => {
  const env = makeQuoEnv();
  const account = busyAccount(QUO_LIMITS.conversationsPerRun + 30);
  const r = await run(env, account, T0); // real page size: the whole window arrives in one page
  assert.equal(r.requests.filter((u) => u.pathname === '/v1/messages').length, QUO_LIMITS.conversationsPerRun);
  assert.equal(r.cursor.scan.pending.length, 30);
});

test('over the fetch budget: fetches count toward subrequests and the run stops inside it', async () => {
  const env = makeQuoEnv();
  env.INGEST_MAX_SUBREQUESTS = '30';
  const account = busyAccount(10);
  const r = await run(env, account, T0);
  assert.ok(r.fetches + r.queries <= 30, `subrequests ${r.fetches}+${r.queries}`);
  assert.ok((await count(env)) < 10, 'stopped early');
});

test('a conversation too big for any run is recorded as a failure (and skipped after 3), never blocking the queue', async () => {
  const env = makeQuoEnv();
  const account = busyAccount(3);
  // More message pages than one conversation may read in a run.
  for (let k = 0; k < QUO_LIMITS.pagesPerConversation * 10 + 1; k++) account.text('CN1', T0 - 2 * 3600 + k, 'incoming');
  const r = await run(env, account, T0, { pageSize: 10 });
  assert.ok(await env.DB.prepare('SELECT 1 FROM thread WHERE id = ?').bind('quo:CN0').first());
  assert.ok(await env.DB.prepare('SELECT 1 FROM thread WHERE id = ?').bind('quo:CN2').first(), 'the queue moved on');
  assert.equal(r.requests.filter((u) => u.pathname === '/v1/messages' && u.searchParams.getAll('participants').includes(phone(1))).length, QUO_LIMITS.pagesPerConversation, 'read stops at the page cap');
  const f = await env.DB.prepare('SELECT failures, last_error FROM ingest_failure WHERE item_id = ?').bind('quo:CN1').first();
  assert.equal(f.failures, 1);
  assert.match(f.last_error, /pages/);
  assert.equal(r.cursor.highWater, null, 'held for retry, as for any failure');
});

test('a conversation whose writes can never fit one run is a failure, not deferred forever at the head of the queue', async () => {
  const env = makeQuoEnv();
  env.INGEST_MAX_D1_QUERIES = '14';
  const account = busyAccount(3);
  // CN0 is newest (read first) and ends 10 separate waits: 6 + 10 + 1 queries > 14.
  for (let k = 0; k < 10; k++) { account.text('CN0', T0 - 50 * MIN + k * 4 * MIN, 'incoming'); account.text('CN0', T0 - 49 * MIN + k * 4 * MIN, 'outgoing'); }
  for (let i = 1; i <= 4; i++) await run(env, account, T0 + i * 5 * MIN);
  assert.ok(await env.DB.prepare('SELECT 1 FROM thread WHERE id = ?').bind('quo:CN2').first(), 'the queue moved past it');
  const f = await env.DB.prepare('SELECT failures, last_error FROM ingest_failure WHERE item_id = ?').bind('quo:CN0').first();
  assert.ok(f && f.failures >= 1, 'recorded where a human can see it');
  assert.match(f.last_error, /more than one run allows/);
});

test('an expired listing page token drops the scan; the next run starts it again without advancing the cursor', async () => {
  const env = makeQuoEnv();
  const account = busyAccount(QUO_LIMITS.conversationsPerRun * QUO_LIMITS.listPagesPerRun + 15);
  const first = await run(env, account, T0, { pageSize: 10 });
  assert.ok(first.cursor.scan.pageToken, 'listing continues next run');
  account.failListingPageToken = true;
  const second = await run(env, account, T0 + 5 * MIN, { pageSize: 10 });
  assert.equal(second.cursor.highWater, null);
  assert.equal(second.cursor.scan, null, 'scan discarded');
  assert.ok(second.logs.some((l) => /page token/i.test(l)), second.logs.join('\n'));
  account.failListingPageToken = false;
  const third = await run(env, account, T0 + 10 * MIN, { pageSize: 10 });
  assert.ok(third.logs.some((l) => l.includes('mode=backfill')), 'starts over from the same point');
});

// --- defaults and worst case -----------------------------------------------------------------

test('defaults stay under Workers Paid caps, and one source worst case fits them', () => {
  assert.ok(QUO_LIMITS.maxSubrequests <= 10_000 && QUO_LIMITS.maxD1Queries <= 1_000);
  const worstFetches = QUO_LIMITS.listPagesPerRun + QUO_LIMITS.conversationsPerRun * 2 * QUO_LIMITS.pagesPerConversation;
  assert.ok(worstFetches <= QUO_LIMITS.maxSubrequests, `fetches ${worstFetches}`);
});
