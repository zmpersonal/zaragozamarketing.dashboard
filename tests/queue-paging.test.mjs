// The queue is paged, per tier and visibly (round 11). The first request
// returns one page of each tier and every tier's total, the totals from a
// single grouped COUNT(*). Further pages come one tier at a time. Paging never
// mixes tiers, so a customer can't be displaced by bulk or spam; it can only be
// on a later page of Needs reply, which the UI says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { QUEUE_PAGE } from '../src/index.ts';
import { makeApiEnv, withAccess, mintToken, insertThread, OWNER } from './helpers/access.mjs';

const NOW = 1789480800;
const H = 3600;

function seed(env, { customers = 0, bulk = 0, spam = 0 }) {
  const add = (id, triage, hoursAgo) => {
    insertThread(env, { id, awaiting_since: NOW - hoursAgo * H, started: NOW - hoursAgo * H });
    env.DB.raw.prepare('UPDATE thread SET triage = ? WHERE id = ?').run(triage, id);
  };
  for (let i = 0; i < spam; i++) add(`gmail:s${i}`, 'spam', 1000 + i);
  for (let i = 0; i < bulk; i++) add(`gmail:b${i}`, 'bulk', 500 + i);
  for (let i = 0; i < customers; i++) add(`gmail:c${i}`, 'customer', 1 + i);
}

/** D1 wrapper recording each statement and the rows it returned. */
function recordingDb(db) {
  const calls = [];
  const wrap = (stmt, sql) => ({
    bind: (...a) => wrap(stmt.bind(...a), sql),
    all: async () => { const r = await stmt.all(); calls.push({ sql, rows: r.results }); return r; },
    first: async () => { const r = await stmt.first(); calls.push({ sql, rows: r ? [r] : [] }); return r; },
    run: async () => { calls.push({ sql, rows: [] }); return stmt.run(); },
  });
  return { calls, db: { ...db, prepare: (sql) => wrap(db.prepare(sql), sql), batch: (s) => db.batch(s) } };
}

async function get(env, query = '', email = OWNER) {
  const token = await mintToken({ email });
  const res = await withAccess(() => worker.fetch(new Request(`https://console.example/api/queue${query}`, { headers: { 'Cf-Access-Jwt-Assertion': token } }), env));
  return { status: res.status, body: await res.json() };
}

test('the first page is 50 rows per tier at most, with every tier total, oldest first', async () => {
  assert.equal(QUEUE_PAGE, 50);
  const env = makeApiEnv();
  seed(env, { customers: 120, bulk: 70, spam: 400 });
  const { status, body } = await get(env);
  assert.equal(status, 200);
  const byTier = (t) => body.threads.filter((x) => (x.triage === 'bulk' || x.triage === 'spam' ? x.triage : 'customer') === t);
  assert.deepEqual(body.tiers, { customer: { shown: 50, total: 120 }, bulk: { shown: 50, total: 70 }, spam: { shown: 50, total: 400 } });
  assert.equal(body.page_size, 50);
  assert.deepEqual(byTier('customer').map((t) => t.id), Array.from({ length: 50 }, (_, i) => `gmail:c${119 - i}`), 'oldest customers first');
  assert.equal(body.threads.length, 150);
});

test('paging walks one tier to the end: every thread exactly once, never another tier', async () => {
  const env = makeApiEnv();
  seed(env, { customers: 120, bulk: 30, spam: 400 });
  for (const [tier, total] of [['customer', 120], ['spam', 400]]) {
    const seen = [];
    for (let offset = 0; offset < total; offset += 50) {
      const { status, body } = await get(env, `?tier=${tier}&offset=${offset}`);
      assert.equal(status, 200);
      assert.equal(body.tier, tier);
      assert.equal(body.offset, offset);
      assert.equal(body.total, total);
      assert.ok(body.threads.every((t) => (t.triage === 'bulk' || t.triage === 'spam' ? t.triage : 'customer') === tier), `page ${offset} of ${tier} mixed tiers`);
      seen.push(...body.threads.map((t) => t.id));
    }
    assert.equal(seen.length, total);
    assert.equal(new Set(seen).size, total, `${tier}: no thread twice`);
  }
  const past = await get(env, '?tier=customer&offset=150');
  assert.deepEqual(past.body.threads, []);
});

test('totals come from one grouped COUNT(*), and the whole first page is four statements', async () => {
  const env = makeApiEnv();
  seed(env, { customers: 60, bulk: 60, spam: 60 });
  const { db, calls } = recordingDb(env.DB);
  const { status } = await get({ ...env, DB: db });
  assert.equal(status, 200);
  const counts = calls.filter((c) => /COUNT\(\*\)/i.test(c.sql));
  assert.equal(counts.length, 1, calls.map((c) => c.sql).join('\n---\n'));
  assert.ok(counts[0].rows.length <= 3, 'one row per tier');
  const reads = calls.filter((c) => /FROM thread/i.test(c.sql));
  assert.equal(reads.length, 4, 'three pages and one count');
  assert.ok(calls.filter((c) => /FROM thread/i.test(c.sql)).every((c) => c.rows.length <= 50));
});

test("an agent's pages hold their own and unassigned threads, and totals match", async () => {
  const env = makeApiEnv();
  const agent = 'dana.agent@inhousewellness.com';
  seed(env, { customers: 60 });
  env.DB.raw.prepare("UPDATE thread SET assignee = 'someone.else@inhousewellness.com' WHERE id IN ('gmail:c0','gmail:c1')").run();
  const first = await get(env, '', agent);
  assert.deepEqual(first.body.tiers.customer, { shown: 50, total: 58 });
  const second = await get(env, '?tier=customer&offset=50', agent);
  assert.equal(second.body.threads.length, 8);
  assert.ok(![...first.body.threads, ...second.body.threads].some((t) => t.id === 'gmail:c0' || t.id === 'gmail:c1'));
});

test('a bad tier or offset is 400', async () => {
  const env = makeApiEnv();
  for (const q of ['?tier=vip', '?tier=spam&offset=-1', '?tier=spam&offset=abc', '?tier=spam&offset=1.5', '?offset=50']) {
    assert.equal((await get(env, q)).status, 400, q);
  }
});

test('queue rows carry only what the list renders; notes and the full preview come with the thread', async () => {
  const env = makeApiEnv();
  seed(env, { customers: 1 });
  const long = 'a long preview '.repeat(40);
  env.DB.raw.prepare('UPDATE thread SET preview = ?, blocked_note = ? WHERE id = ?').run(long, 'note', 'gmail:c0');
  const { body } = await get(env, '?tier=customer');
  // preview joined the row in round 14: a phone row's subject is only its kind
  // ("Voicemail"), so the transcript is what tells one row from another. It is
  // truncated in SQL, and blocked_note still never travels with the list.
  assert.deepEqual(Object.keys(body.threads[0]).sort(), ['assignee', 'awaiting_since', 'blocked_on', 'blocked_since', 'brand_id', 'channel', 'conversation_started_at', 'customer_handle', 'customer_name', 'id', 'is_automated', 'preview', 'status', 'subject', 'triage', 'triage_signals']);
  assert.equal(body.threads[0].preview.length, 120, 'the row carries a bounded preview, not the whole thing');
  const token = await mintToken({ email: OWNER });
  const detail = await withAccess(() => worker.fetch(new Request('https://console.example/api/threads/gmail:c0', { headers: { 'Cf-Access-Jwt-Assertion': token } }), env));
  assert.equal((await detail.json()).thread.preview, long, 'the whole preview is on the thread');
});

test('threads waiting since the same second still page without repeats or gaps', async () => {
  const env = makeApiEnv();
  for (let i = 0; i < 130; i++) {
    insertThread(env, { id: `gmail:tie${String((i * 37) % 130).padStart(3, '0')}`, awaiting_since: NOW, started: NOW });
  }
  env.DB.raw.prepare("UPDATE thread SET triage = 'spam'").run();
  const seen = [];
  for (let offset = 0; offset < 130; offset += 50) {
    const { body } = await get(env, `?tier=spam&offset=${offset}`);
    seen.push(...body.threads.map((t) => t.id));
  }
  assert.equal(new Set(seen).size, 130);
  assert.deepEqual(seen, [...seen].sort(), 'ties are broken by id, so the order is total and stable');
});
