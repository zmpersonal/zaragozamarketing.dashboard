// /api/queue must never let one tier crowd another out. Round 8 found 8 of 45
// real Needs-reply threads missing because one query served all three tiers
// under one LIMIT and older spam used up the rows. Each tier is now its own
// query with its own limit, and the response says when a tier was cut.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { QUEUE_LIMITS } from '../src/index.ts';
import { makeApiEnv, withAccess, mintToken, apiRequest, insertThread, OWNER } from './helpers/access.mjs';

const NOW = 1789480800;
const H = 3600;

function seed(env, { customers, bulk, spam }) {
  const add = (id, triage, hoursAgo, extra = {}) => {
    insertThread(env, { id, awaiting_since: NOW - hoursAgo * H, started: NOW - hoursAgo * H, ...extra });
    env.DB.raw.prepare('UPDATE thread SET triage = ? WHERE id = ?').run(triage, id);
  };
  // Spam and bulk are OLDER than every customer, so oldest-first ordering puts them first.
  for (let i = 0; i < spam; i++) add(`gmail:s${i}`, 'spam', 500 + i);
  for (let i = 0; i < bulk; i++) add(`gmail:b${i}`, 'bulk', 300 + i);
  for (let i = 0; i < customers; i++) add(`gmail:c${i}`, 'customer', 1 + i);
}

/** Wrap D1 so every result set a statement returns is recorded. */
function recordingDb(db) {
  const results = [];
  const wrap = (stmt, sql) => ({
    bind: (...a) => wrap(stmt.bind(...a), sql),
    all: async () => { const r = await stmt.all(); results.push({ sql, rows: r.results }); return r; },
    first: async () => { const r = await stmt.first(); results.push({ sql, rows: r ? [r] : [] }); return r; },
    run: () => stmt.run(),
  });
  return { results, db: { ...db, prepare: (sql) => wrap(db.prepare(sql), sql), batch: (s) => db.batch(s) } };
}

async function queue(env, email = OWNER) {
  const res = await withAccess(async () => worker.fetch(apiRequest('queue', { token: await mintToken({ email }) }), env));
  assert.equal(res.status, 200);
  return res.json();
}

test('realistic mix: every Needs-reply thread comes back, however much older spam and bulk there is', async () => {
  const env = makeApiEnv();
  // Scaled from the limits, so raising any limit also raises the pressure: this proves separation, not headroom.
  const spam = QUEUE_LIMITS.customer + QUEUE_LIMITS.bulk + QUEUE_LIMITS.spam + 150;
  seed(env, { customers: 45, bulk: 60, spam });
  const body = await queue(env);
  const ids = new Set(body.threads.map((t) => t.id));
  for (let i = 0; i < 45; i++) assert.ok(ids.has(`gmail:c${i}`), `customer thread c${i} missing from the queue`);
  assert.deepEqual(body.tiers.customer, { shown: 45, total: 45 });
  assert.deepEqual(body.tiers.bulk, { shown: 60, total: 60 });
  assert.deepEqual(body.tiers.spam, { shown: QUEUE_LIMITS.spam, total: spam }, 'spam is cut, and says so');
});

test('separation, not headroom: no statement serving /api/queue returns rows from more than one tier', async () => {
  const env = makeApiEnv();
  seed(env, { customers: 5, bulk: 5, spam: 5 });
  const { db, results } = recordingDb(env.DB);
  const res = await withAccess(async () => worker.fetch(apiRequest('queue', { token: await mintToken({ email: OWNER }) }), { ...env, DB: db }));
  assert.equal(res.status, 200);
  const threadResults = results.filter((r) => r.rows.some((row) => 'triage' in row && 'id' in row));
  assert.ok(threadResults.length >= 3, 'one thread query per tier');
  for (const r of threadResults) {
    const tiers = new Set(r.rows.map((row) => (row.triage === 'bulk' || row.triage === 'spam' ? row.triage : 'customer')));
    assert.ok(tiers.size <= 1, `one statement returned ${[...tiers].join(' + ')}:\n${r.sql}`);
  }
});

test('a tier we do not recognise is served with Needs reply, never dropped', async () => {
  const env = makeApiEnv();
  seed(env, { customers: 1, bulk: 0, spam: QUEUE_LIMITS.spam + 10 });
  insertThread(env, { id: 'gmail:odd', awaiting_since: NOW, started: NOW });
  env.DB.raw.prepare("UPDATE thread SET triage = 'not_customer_legacy' WHERE id = 'gmail:odd'").run();
  const body = await queue(env);
  assert.ok(body.threads.some((t) => t.id === 'gmail:odd'));
  assert.equal(body.tiers.customer.total, 2);
});

test("an agent's queue is separated the same way (their threads and unassigned ones)", async () => {
  const env = makeApiEnv();
  const agent = 'dana.agent@inhousewellness.com';
  seed(env, { customers: 10, bulk: 0, spam: QUEUE_LIMITS.spam + QUEUE_LIMITS.customer + 10 });
  env.DB.raw.prepare("UPDATE thread SET assignee = 'someone.else@inhousewellness.com' WHERE id = 'gmail:c0'").run();
  env.DB.raw.prepare(`UPDATE thread SET assignee = ? WHERE id = 'gmail:c1'`).run(agent);
  const body = await queue(env, agent);
  const ids = new Set(body.threads.map((t) => t.id));
  assert.ok(!ids.has('gmail:c0'), "another agent's thread is not in my queue");
  for (let i = 1; i < 10; i++) assert.ok(ids.has(`gmail:c${i}`), `c${i}`);
  assert.equal(body.tiers.customer.total, 9);
});
