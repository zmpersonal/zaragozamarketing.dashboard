// SKIPPED, ROUND 10: deleted-mail handling. These tests were written in round 9
// (5 of 6 failing on the code at the time), then paused when the owner moved
// the work to round 10. They are committed skipped so they are visible in the
// repo rather than kept in a git stash. Round 10 implements the behaviour and
// removes the skips.
//
// Mail deleted in Gmail (Delete forever, emptied Trash, or Gmail's own 30-day
// spam purge) leaves the queue: the next incremental sync marks the thread
// 'deleted'. That is not an answer: no response row, no outbound time, and
// nothing for the admin report to count as a reply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestGmail } from '../src/ingest/gmail.ts';
import { resolveState } from '../src/lib/thread-state.ts';
import worker from '../src/index.ts';
import { makeEnv, withGmail, inbound, outbound, row, deleteMessages } from './helpers/gmail.mjs';
import { withAccess, mintToken, apiRequest, OWNER, AUD, TEAM } from './helpers/access.mjs';

const DAY = 86400_000;
const ago = (days) => new Date(Math.floor((Date.now() - days * DAY) / 1000) * 1000).toISOString();

async function run(env, threads, requests = []) {
  const real = { log: console.log, error: console.error, warn: console.warn };
  const errors = [];
  console.log = console.warn = () => {};
  console.error = (...a) => errors.push(a.map(String).join(' '));
  try { await withGmail(threads, () => ingestGmail(env), { requests }); } finally { Object.assign(console, real); }
  return errors;
}
const q = (env, sql, ...a) => env.DB.raw.prepare(sql).all(...a);
const one = (env, sql, ...a) => env.DB.raw.prepare(sql).get(...a);

async function apiQueue(env) {
  Object.assign(env, { ACCESS_TEAM: TEAM, ACCESS_AUD: AUD, OWNERS: OWNER, ASSETS: { fetch: async () => new Response('') } });
  const token = await mintToken({ email: OWNER });
  const res = await withAccess(() => worker.fetch(apiRequest('queue', { token }), env));
  const board = await withAccess(() => worker.fetch(apiRequest('board', { token }), env));
  return { queue: await res.json(), board: await board.json() };
}

function mailbox() {
  return {
    gone: [inbound(ago(2), 'Dana <dana@example.com>', 'Heater tripping the breaker')],
    stays: [inbound(ago(1), 'Sam <sam@example.com>', 'Chiller warranty')],
  };
}

test.skip('a waiting customer thread deleted in Gmail leaves the queue as deleted, and is not an answer', async () => {
  const env = makeEnv();
  const threads = mailbox();
  await run(env, threads);
  assert.equal((await row(env, 'gone')).status, 'waiting');

  deleteMessages(threads, 'gone');
  const requests = [];
  const errors = await run(env, threads, requests);
  assert.deepEqual(errors, [], 'a deleted thread is not an ingest failure');
  const hist = requests.find((u) => u.pathname.endsWith('/history'));
  assert.ok(hist.searchParams.getAll('historyTypes').includes('messageDeleted'), 'sync asks Gmail for deletions');

  const t = await row(env, 'gone');
  assert.equal(t.status, 'deleted');
  assert.ok(t.deleted_at > 0);
  assert.equal(t.awaiting_since, null, 'the clock stops');
  assert.equal(t.last_outbound_at, null, 'no outbound was invented');
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM response').n, 0, 'no response measurement');
  assert.deepEqual(q(env, "SELECT actor, kind FROM action WHERE thread_id = 'gmail:gone'").map((a) => [a.actor, a.kind]), [['system', 'deleted']]);
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM ingest_failure').n, 0);

  const { queue, board } = await apiQueue(env);
  const ids = queue.threads.map((x) => x.id);
  assert.ok(!ids.includes('gmail:gone'), 'out of the queue');
  assert.ok(ids.includes('gmail:stays'));
  assert.equal(board.board[0].waiting, 1, 'board counts exclude it');
  assert.equal((await row(env, 'stays')).status, 'waiting', 'other threads untouched');
});

test.skip('only the customer message deleted, a draft reply left behind: nothing inbound remains, so deleted', async () => {
  const env = makeEnv();
  const threads = { d: [inbound(ago(2), 'Dana <dana@example.com>'), { ...outbound(ago(1)), labelIds: ['DRAFT'] }] };
  await run(env, threads);
  deleteMessages(threads, 'd', [0]);
  await run(env, threads);
  const t = await row(env, 'd');
  assert.equal(t.status, 'deleted');
  assert.equal(t.last_outbound_at, null, 'a draft is still not a reply');
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM response').n, 0);
});

test.skip('one of two inbound messages deleted: the thread still exists and is still waiting', async () => {
  const env = makeEnv();
  const threads = { two: [inbound(ago(3), 'Dana <dana@example.com>'), inbound(ago(1), 'Dana <dana@example.com>', 'Re: still broken')] };
  await run(env, threads);
  deleteMessages(threads, 'two', [1]);
  await run(env, threads);
  const t = await row(env, 'two');
  assert.equal(t.status, 'waiting');
  assert.equal(t.deleted_at, null);
});

test.skip('a blocked thread deleted in Gmail leaves the blocked group; a closed one stays closed and is only stamped', async () => {
  const env = makeEnv();
  const threads = { b: [inbound(ago(3), 'B <b@example.com>')], c: [inbound(ago(3), 'C <c@example.com>')] };
  await run(env, threads);
  env.DB.raw.prepare("UPDATE thread SET status = 'blocked', blocked_on = 'supplier', blocked_since = 5 WHERE id = 'gmail:b'").run();
  env.DB.raw.prepare("UPDATE thread SET status = 'closed', closed_at = 7, awaiting_since = NULL WHERE id = 'gmail:c'").run();
  deleteMessages(threads, 'b');
  deleteMessages(threads, 'c');
  await run(env, threads);
  const b = await row(env, 'b');
  assert.equal(b.status, 'deleted');
  assert.equal(b.blocked_since, null);
  const c = await row(env, 'c');
  assert.equal(c.status, 'closed');
  assert.equal(c.closed_at, 7);
  assert.ok(c.deleted_at > 0);
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM response').n, 0);
});

test.skip('a deleted thread that was never ingested is ignored, not recorded as a failure', async () => {
  const env = makeEnv();
  const threads = mailbox();
  await run(env, threads);
  threads.later = [inbound(ago(0), 'X <x@example.com>')];
  deleteMessages(threads, 'later'); // arrives and is deleted between two syncs
  const errors = await run(env, threads);
  assert.deepEqual(errors, []);
  assert.equal(await row(env, 'later'), null);
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM ingest_failure').n, 0);
});

test.skip('state rules: a deleted thread stays deleted, and reopens like a closed one if the customer writes again', () => {
  const existing = { status: 'deleted', last_inbound_at: 100, last_outbound_at: null, awaiting_since: null };
  assert.deepEqual(resolveState(existing, [{ at: 100, inbound: true }]), { status: 'deleted', awaiting_since: null, reopened: false, unblocked: false });
  const r = resolveState(existing, [{ at: 100, inbound: true }, { at: 200, inbound: true }]);
  assert.equal(r.status, 'waiting');
  assert.equal(r.awaiting_since, 200);
  assert.equal(r.reopened, true);
});
