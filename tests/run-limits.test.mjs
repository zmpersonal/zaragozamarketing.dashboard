// Per-run caps for ingest on GitHub Actions. The Workers subrequest ceiling is
// gone, so the counts are backstops against a runaway bug. The limits that
// actually bind are:
//   - Cloudflare's API allows 1,200 requests per 5 minutes per token, and
//     blocks every call for 5 minutes past that. Gmail + Quo D1 statements per
//     run stay under 1,000, leaving room for a human's wrangler calls.
//   - Actions minutes: every run stops starting new work at a wall-clock
//     deadline, so a run always finishes inside the job timeout
//     (tests/ingest-workflow asserts the minutes math).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Budget } from '../src/lib/budget.ts';
import { ingestGmail, GMAIL_LIMITS } from '../src/ingest/gmail.ts';
import { ingestQuo, QUO_LIMITS } from '../src/ingest/quo.ts';
import { makeEnv, withGmail, inbound, SOURCE_ID } from './helpers/gmail.mjs';
import { makeQuoEnv, makeQuoAccount, withQuo, SOURCE_ID as QUO_SOURCE } from './helpers/quo.mjs';

const CF_API_REQUESTS_PER_5_MIN = 1200;
const DAY = 86400_000;
const ago = (days) => new Date(Math.floor((Date.now() - days * DAY) / 1000) * 1000).toISOString();
const quietly = async (fn) => {
  const real = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  console.log = console.warn = console.error = (...a) => lines.push(a.map(String).join(' '));
  try { await fn(); } finally { Object.assign(console, real); }
  return lines;
};

test('D1 statements per run, Gmail + Quo, stay under the Cloudflare API rate limit with room to spare', () => {
  const perRun = GMAIL_LIMITS.maxD1Queries + QUO_LIMITS.maxD1Queries;
  assert.ok(perRun <= 1000, `${perRun} statements per run`);
  assert.ok(perRun < CF_API_REQUESTS_PER_5_MIN);
});

test('caps are raised enough to clear a backlog, and still finite', () => {
  assert.ok(GMAIL_LIMITS.threadsPerRun >= 100, `threadsPerRun ${GMAIL_LIMITS.threadsPerRun}`);
  assert.ok(QUO_LIMITS.conversationsPerRun >= 50, `conversationsPerRun ${QUO_LIMITS.conversationsPerRun}`);
  assert.ok(GMAIL_LIMITS.backfillPageSize >= 250 && QUO_LIMITS.listPagesPerRun >= 5);
  for (const [k, v] of Object.entries({ ...GMAIL_LIMITS, ...Object.fromEntries(Object.entries(QUO_LIMITS).map(([a, b]) => ['quo.' + a, b])) })) {
    assert.ok(Number.isFinite(v) && v > 0, k);
  }
});

test('Budget: nothing is affordable once the deadline has passed', () => {
  let clock = 1000;
  const b = new Budget(100, 100, { deadline: 2000, now: () => clock });
  assert.equal(b.canAfford(1, 1), true);
  clock = 2000;
  assert.equal(b.canAfford(1, 1), false);
  assert.equal(b.pastDeadline, true);
  assert.equal(new Budget(100, 100).canAfford(1, 1), true, 'no deadline, no time limit');
});

test('Gmail stops starting threads at the deadline, keeps the rest pending, and saves its cursor', async () => {
  const env = makeEnv();
  const threads = {};
  for (let i = 0; i < 40; i++) threads[`t${i}`] = [inbound(ago(1 + (i % 20)), `C${i} <c${i}@example.com>`)];
  let clock = 0;
  const budget = new Budget(5000, 5000, { deadline: 10_000, now: () => clock });
  // Every Gmail request "takes" one second.
  const lines = await quietly(() => withGmail(threads, () => ingestGmail(env, budget), { onGmail: () => { clock += 1000; } }));
  const done = env.DB.raw.prepare('SELECT COUNT(*) AS n FROM thread').get().n;
  assert.ok(done > 0 && done < 12, `stopped early (${done} threads)`);
  const cursor = JSON.parse(env.DB.raw.prepare('SELECT sync_cursor FROM source WHERE id = ?').get(SOURCE_ID).sync_cursor);
  assert.equal(cursor.pending.length, 40 - done, 'the rest waits for the next run');
  assert.ok(lines.some((l) => l.includes('deadline')), lines.join('\n'));
});

test('Quo stops starting conversations at the deadline and keeps its scan', async () => {
  const env = makeQuoEnv();
  const account = makeQuoAccount();
  const T0 = Math.floor(Date.now() / 1000) - 3600;
  for (let i = 0; i < 30; i++) {
    account.conversation(`CN${i}`, { participants: [`+1512555${1000 + i}`], createdAt: T0 - 86400 });
    account.text(`CN${i}`, T0 - i, 'incoming');
  }
  let clock = 0;
  const budget = new Budget(5000, 5000, { deadline: 10_000, now: () => clock });
  const realFetch = globalThis.fetch;
  const lines = await quietly(() => withQuo(account, async () => {
    const quoFetch = globalThis.fetch;
    globalThis.fetch = (...a) => { clock += 1000; return quoFetch(...a); };
    try { await ingestQuo(env, budget); } finally { globalThis.fetch = quoFetch; }
  }));
  globalThis.fetch = realFetch;
  const done = env.DB.raw.prepare('SELECT COUNT(*) AS n FROM thread').get().n;
  assert.ok(done > 0 && done < 10, `stopped early (${done})`);
  const cursor = JSON.parse(env.DB.raw.prepare('SELECT sync_cursor FROM source WHERE id = ?').get(QUO_SOURCE).sync_cursor);
  assert.ok(cursor.scan && cursor.scan.pending.length + done === 30);
  assert.ok(lines.some((l) => l.includes('deadline')), lines.join('\n'));
});
