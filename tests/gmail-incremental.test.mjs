// Gmail ingest is incremental: source.sync_cursor holds Gmail's historyId, and
// each run fetches only threads that changed since then. An empty cursor does
// a bounded backfill; an expired or invalid historyId falls back to a bounded
// window sync and re-seeds the cursor. Every run stays inside a subrequest
// budget (fetches + D1 queries), leaving any overflow pending for the next run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestGmail, GMAIL_LIMITS, RECEIVED_QUERY } from '../src/ingest/gmail.ts';
import worker from '../src/index.ts';
import { makeEnv, withGmail, inbound, outbound, row, expireHistory, MAILBOX, SOURCE_ID } from './helpers/gmail.mjs';

const DAY = 86400_000;
const ago = (days) => new Date(Math.floor((Date.now() - days * DAY) / 1000) * 1000).toISOString();

/** Count D1 statements the way the budget must: one per run/all/first, one per statement in a batch. */
function countingDb(db) {
  const counter = { queries: 0 };
  const wrapStmt = (stmt) => ({
    bind: (...a) => wrapStmt(stmt.bind(...a)),
    run: () => { counter.queries++; return stmt.run(); },
    all: () => { counter.queries++; return stmt.all(); },
    first: () => { counter.queries++; return stmt.first(); },
    _inner: stmt,
  });
  const wrapped = {
    ...db,
    prepare: (sql) => wrapStmt(db.prepare(sql)),
    batch: (stmts) => { counter.queries += stmts.length; return db.batch(stmts.map((s) => s._inner ?? s)); },
  };
  return { db: wrapped, counter };
}

async function run(env, threads, opts = {}) {
  const logs = [];
  const real = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => logs.push(a.map(String).join(' '));
  console.warn = (...a) => logs.push('WARN ' + a.map(String).join(' '));
  console.error = (...a) => logs.push('ERROR ' + a.map(String).join(' '));
  const requests = [];
  try { await withGmail(threads, () => ingestGmail(env), { requests, ...opts }); }
  finally { Object.assign(console, real); }
  const cursor = (await env.DB.prepare('SELECT sync_cursor FROM source WHERE id = ?1').bind(SOURCE_ID).first()).sync_cursor;
  return { logs, requests, cursor: cursor ? JSON.parse(cursor) : null, paths: requests.map((u) => u.pathname.replace('/gmail/v1/users/me/', '').replace(/\/.*/, '/:id')) };
}

const manyThreads = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`t${i}`, [inbound(ago(1 + (i % 20)), `C${i} <c${i}@example.com>`)]]));
const ingested = async (env) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM thread').first()).n;

// --- empty cursor: bounded backfill ------------------------------------------------

test('empty cursor: bounded backfill stores the historyId and catches up over later runs', async () => {
  const env = makeEnv();
  const total = GMAIL_LIMITS.threadsPerRun * 2 + 10;
  const threads = manyThreads(total);

  // Pages as large as the backfill asks for (Gmail allows 500), so the per-run thread cap is what binds.
  const page = { pageSize: GMAIL_LIMITS.backfillPageSize };
  const first = await run(env, threads, page);
  assert.equal(await ingested(env), GMAIL_LIMITS.threadsPerRun, 'first run is capped');
  assert.match(first.cursor.historyId, /^\d+$/);
  assert.equal(first.cursor.pending.length, total - GMAIL_LIMITS.threadsPerRun);
  assert.ok(first.logs.some((l) => l.includes('mode=backfill') && l.includes(`query "${RECEIVED_QUERY}"`)), first.logs.join('\n'));
  assert.equal(first.paths.filter((p) => p === 'threads/:id').length, GMAIL_LIMITS.threadsPerRun);

  await run(env, threads, page);
  const third = await run(env, threads, page);
  assert.equal(await ingested(env), total, 'later runs catch up');
  assert.deepEqual(third.cursor.pending, []);
  assert.equal(third.cursor.historyId, first.cursor.historyId, 'nothing changed, so the historyId is unchanged');
});

// --- normal incremental run ----------------------------------------------------------

test('incremental: only changed threads are fetched, via history.list from the stored historyId', async () => {
  const env = makeEnv();
  const threads = manyThreads(8);
  await run(env, threads); // backfill (8 < cap)
  const before = (await run(env, threads)).cursor;

  threads.t3.push(inbound(ago(0), 'C3 <c3@example.com>', 'Re: following up'));
  threads.fresh = [inbound(ago(0), 'New <new@example.com>', 'Hello')];
  threads.t5[0].labelIds = ['SPAM']; // Gmail moved it to spam

  const { paths, requests, cursor } = await run(env, threads);
  assert.ok(!paths.includes('messages'), 'no full listing');
  const hist = requests.filter((u) => u.pathname.endsWith('/history'));
  assert.ok(hist.length >= 1 && hist[0].searchParams.get('startHistoryId') === before.historyId);
  const fetched = requests.filter((u) => u.pathname.includes('/threads/')).map((u) => u.pathname.split('/').pop()).sort();
  assert.deepEqual(fetched, ['fresh', 't3', 't5']);
  assert.ok(Number(cursor.historyId) > Number(before.historyId), 'cursor advanced');
  assert.ok(await row(env, 'fresh'));
  assert.equal((await row(env, 't5')).triage, 'spam');
});

test('incremental run with nothing changed fetches no threads', async () => {
  const env = makeEnv();
  const threads = manyThreads(3);
  await run(env, threads);
  const { paths } = await run(env, threads);
  assert.deepEqual(paths.filter((p) => p !== 'history'), [], `only history.list: ${paths}`);
});

// --- expired / invalid cursor --------------------------------------------------------

test('expired historyId (404): falls back to a bounded window sync and re-seeds the cursor', async () => {
  const env = makeEnv();
  const threads = manyThreads(4);
  await run(env, threads);
  const old = (await run(env, threads)).cursor.historyId;

  expireHistory(threads);
  threads.late = [inbound(ago(0), 'Late <late@example.com>', 'Are you there?')];
  const r = await run(env, threads);
  assert.ok(r.logs.some((l) => l.startsWith('WARN') && /expired|invalid/.test(l) && l.includes('mode=fallback')), r.logs.join('\n'));
  assert.ok(r.paths.includes('profile') && r.paths.includes('messages'), 'bounded window listing');
  assert.ok(r.paths.filter((p) => p === 'threads/:id').length <= GMAIL_LIMITS.threadsPerRun);
  assert.ok(await row(env, 'late'), 'mail from the gap is picked up');
  assert.ok(Number(r.cursor.historyId) > Number(old), 're-seeded');

  const next = await run(env, threads);
  assert.ok(next.paths.includes('history') && !next.paths.includes('messages'), 'back to incremental');
});

test('invalid historyId (400): same fallback', async () => {
  const env = makeEnv();
  env.DB.raw.prepare('UPDATE source SET sync_cursor = ? WHERE id = ?').run(JSON.stringify({ historyId: 'not-a-number', pending: [] }), SOURCE_ID);
  const threads = manyThreads(2);
  const r = await run(env, threads);
  assert.ok(r.logs.some((l) => l.startsWith('WARN') && l.includes('mode=fallback')), r.logs.join('\n'));
  assert.equal(await ingested(env), 2);
  assert.match(r.cursor.historyId, /^\d+$/);
});

// --- drafts ----------------------------------------------------------------------------

test('a saved draft reply is not a reply: the thread stays waiting', async () => {
  const env = makeEnv();
  const threads = { d: [inbound(ago(1), 'Dana <dana@example.com>'), { ...outbound(ago(0)), labelIds: ['DRAFT'] }] };
  await run(env, threads);
  const t = await row(env, 'd');
  assert.equal(t.status, 'waiting');
  assert.equal(t.last_outbound_at, null);
});

// --- budget ------------------------------------------------------------------------------

test('a run never exceeds its subrequest budget; overflow stays pending for the next run', async () => {
  const env = makeEnv();
  env.INGEST_MAX_SUBREQUESTS = '60';
  env.INGEST_MAX_D1_QUERIES = '50';
  // Long threads maximise D1 work per thread (responses per reply).
  const threads = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`long${i}`, [
    inbound(ago(9), `L${i} <l${i}@example.com>`), outbound(ago(8)), inbound(ago(7), `L${i} <l${i}@example.com>`), outbound(ago(6)),
    inbound(ago(5), `L${i} <l${i}@example.com>`), outbound(ago(4)),
  ]]));
  const { db, counter } = countingDb(env.DB);
  const wrappedEnv = { ...env, DB: db };

  const r = await run(wrappedEnv, threads);
  const gmailCalls = r.requests.length;
  const tokenCalls = 1; // at most one token exchange per mailbox per run
  assert.ok(counter.queries <= 50, `D1 queries ${counter.queries} <= 50`);
  assert.ok(gmailCalls + tokenCalls + counter.queries <= 60, `subrequests ${gmailCalls + tokenCalls + counter.queries} <= 60`);
  assert.ok(r.cursor.pending.length > 0, 'overflow left pending');
  assert.ok(r.logs.some((l) => /subrequests fetch=\d+ d1=\d+/.test(l)), r.logs.join('\n'));
  const firstCount = await ingested(env);
  assert.ok(firstCount > 0 && firstCount < 40);

  for (let i = 0; i < 10 && (await ingested(env)) < 40; i++) await run(wrappedEnv, threads);
  assert.equal(await ingested(env), 40, 'all threads arrive over later runs');
});

test('default budget is finite and D1 queries count within it (the runner caps are justified in tests/run-limits)', () => {
  assert.ok(Number.isFinite(GMAIL_LIMITS.maxSubrequests) && Number.isFinite(GMAIL_LIMITS.maxD1Queries));
  assert.ok(GMAIL_LIMITS.maxD1Queries <= GMAIL_LIMITS.maxSubrequests, 'D1 queries count toward the total too');
});

test('worst case per run fits the default budget with 3 mailboxes', async () => {
  const env = makeEnv();
  for (const box of ['orders@inhousewellness.com', 'hello@inhousewellness.com']) {
    env.DB.raw.prepare(`INSERT INTO source (id, brand_id, channel, provider, address) VALUES (?, 'inhouse', 'email', 'gmail', ?)`).run(`gmail:${box}`, box);
  }
  const threads = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`w${i}`, [
    inbound(ago(9), `W${i} <w${i}@example.com>`), outbound(ago(8)), inbound(ago(7), `W${i} <w${i}@example.com>`), outbound(ago(6)),
  ]]));
  const { db, counter } = countingDb(env.DB);
  const r = await run({ ...env, DB: db }, threads);
  const subrequests = r.requests.length + 3 + counter.queries;
  assert.ok(counter.queries <= GMAIL_LIMITS.maxD1Queries, `D1 ${counter.queries} <= ${GMAIL_LIMITS.maxD1Queries}`);
  assert.ok(subrequests <= GMAIL_LIMITS.maxSubrequests, `subrequests ${subrequests} <= ${GMAIL_LIMITS.maxSubrequests}`);
});

// --- where ingest runs ---------------------------------------------------------------------------

test('the Worker does not ingest: no scheduled handler and no cron triggers (ingest runs on GitHub Actions)', async () => {
  const { readFileSync } = await import('node:fs');
  assert.equal(typeof worker.scheduled, 'undefined');
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.doesNotMatch(toml.replace(/#.*$/gm, ''), /\[triggers\]|crons\s*=/);
});
