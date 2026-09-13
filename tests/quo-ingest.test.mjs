// Quo ingest reads every message (and call) since a stored cursor per source,
// so an inbound followed by our reply between two polls is still observed:
// the thread reopens and last_inbound_at moves. The webhook stays the fast
// path; this poll is the backstop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestQuo } from '../src/ingest/quo.ts';
import { makeQuoEnv, makeQuoAccount, withQuo, SOURCE_ID } from './helpers/quo.mjs';

const T0 = 1789480800; // Tue 2026-09-15 09:00 CDT
const MIN = 60;

const thread = (env, cn = 'CN1') => env.DB.prepare('SELECT * FROM thread WHERE id = ?1').bind(`quo:${cn}`).first();
const source = (env) => env.DB.prepare('SELECT * FROM source WHERE id = ?1').bind(SOURCE_ID).first();
const close = (env, cn, at) =>
  env.DB.prepare(`UPDATE thread SET status = 'closed', closed_at = ?2, awaiting_since = NULL WHERE id = ?1`).bind(`quo:${cn}`, at).run();

/** Poll at a fixed "now" so the cursor and backfill window are deterministic. */
async function poll(env, account, nowSec) {
  const realNow = Date.now;
  Date.now = () => nowSec * 1000;
  try { await withQuo(account, () => ingestQuo(env)); } finally { Date.now = realNow; }
}

function setup() {
  const env = makeQuoEnv();
  const account = makeQuoAccount();
  account.conversation('CN1', { createdAt: T0 - 60 * MIN });
  return { env, account };
}

test('interleaved between polls on a CLOSED thread: inbound then our reply -> reopens, inbound observed', async () => {
  const { env, account } = setup();
  account.text('CN1', T0, 'incoming');
  account.text('CN1', T0 + 10 * MIN, 'outgoing');
  await poll(env, account, T0 + 15 * MIN);
  await close(env, 'CN1', T0 + 20 * MIN);

  // Between polls: the customer texts, and a teammate replies from the Quo app.
  account.text('CN1', T0 + 30 * MIN, 'incoming');
  account.text('CN1', T0 + 32 * MIN, 'outgoing');
  await poll(env, account, T0 + 40 * MIN);

  const t = await thread(env);
  assert.equal(t.last_inbound_at, T0 + 30 * MIN, 'the superseded inbound was observed');
  assert.equal(t.last_outbound_at, T0 + 32 * MIN);
  assert.equal(t.status, 'answered', 'reopened, and already answered');
  assert.equal(t.awaiting_since, null);
  const log = await env.DB.prepare(`SELECT actor, kind FROM action WHERE thread_id = 'quo:CN1'`).all();
  assert.deepEqual(log.results, [{ actor: 'system', kind: 'reopened' }]);
});

test('interleaved between polls on an OPEN thread: inbound then our reply -> last_inbound_at moves', async () => {
  const { env, account } = setup();
  account.text('CN1', T0, 'incoming');
  account.text('CN1', T0 + 10 * MIN, 'outgoing');
  await poll(env, account, T0 + 15 * MIN);

  account.text('CN1', T0 + 30 * MIN, 'incoming');
  account.text('CN1', T0 + 32 * MIN, 'outgoing');
  await poll(env, account, T0 + 40 * MIN);

  const t = await thread(env);
  assert.equal(t.last_inbound_at, T0 + 30 * MIN);
  assert.equal(t.status, 'answered');
});

test('interleaved between polls: our reply then a new inbound -> waiting from that inbound', async () => {
  const { env, account } = setup();
  account.text('CN1', T0, 'incoming');
  await poll(env, account, T0 + 5 * MIN);

  account.text('CN1', T0 + 10 * MIN, 'outgoing');
  account.text('CN1', T0 + 12 * MIN, 'incoming');
  await poll(env, account, T0 + 20 * MIN);

  const t = await thread(env);
  assert.equal(t.status, 'waiting');
  assert.equal(t.awaiting_since, T0 + 12 * MIN);
});

test('first sight: conversation_started_at is the conversation start, not its latest activity', async () => {
  const { env, account } = setup();
  account.text('CN1', T0, 'incoming');
  account.text('CN1', T0 + 30 * MIN, 'incoming');
  await poll(env, account, T0 + 40 * MIN);

  const t = await thread(env);
  assert.equal(t.conversation_started_at, T0 - 60 * MIN);
  assert.equal(t.awaiting_since, T0);
});

test('the cursor is stored per source and the next poll reads messages after it', async () => {
  const { env, account } = setup();
  account.text('CN1', T0, 'incoming');
  await poll(env, account, T0 + 5 * MIN);
  const cursor = (await source(env)).sync_cursor;
  assert.equal(cursor, String(T0), 'cursor = newest activity observed');

  account.requests.length = 0;
  account.text('CN1', T0 + 10 * MIN, 'outgoing');
  await poll(env, account, T0 + 15 * MIN);

  const messageRequests = account.requests.filter((u) => u.pathname === '/v1/messages');
  assert.equal(messageRequests.length, 1);
  const createdAfter = Date.parse(messageRequests[0].searchParams.get('createdAfter')) / 1000;
  assert.ok(createdAfter <= T0 && createdAfter >= T0 - 10 * MIN, `reads from the cursor with a small overlap (${createdAfter})`);
  assert.equal((await source(env)).sync_cursor, String(T0 + 10 * MIN));
});

test('conversations with no activity since the cursor are not re-read', async () => {
  const { env, account } = setup();
  account.conversation('CN-OLD', { participants: ['+17375550198'], createdAt: T0 - 5 * 86400 });
  account.text('CN-OLD', T0 - 5 * 86400, 'incoming');
  account.text('CN1', T0, 'incoming');
  await poll(env, account, T0 + 5 * MIN);

  account.requests.length = 0;
  account.text('CN1', T0 + 10 * MIN, 'outgoing');
  await poll(env, account, T0 + 15 * MIN);

  const readOld = account.requests.some((u) => u.pathname !== '/v1/conversations'
    && u.searchParams.getAll('participants').includes('+17375550198'));
  assert.equal(readOld, false);
});

test('calls count: a missed incoming call is waiting, an answered one is answered', async () => {
  const { env, account } = setup();
  account.conversation('CN2', { participants: ['+17375550198'], name: 'Rosa Lim', createdAt: T0 - 60 * MIN });
  account.call('CN1', T0, 'incoming');                          // missed
  account.call('CN2', T0, 'incoming', { answeredAfter: 20 });   // picked up after 20s
  await poll(env, account, T0 + 5 * MIN);

  const missed = await thread(env, 'CN1');
  assert.equal(missed.status, 'waiting');
  assert.equal(missed.awaiting_since, T0);
  const answered = await thread(env, 'CN2');
  assert.equal(answered.status, 'answered');
  assert.equal(answered.awaiting_since, null);
});

test('one failing conversation: the others still sync, and the cursor does not advance past it', async () => {
  const { env, account } = setup();
  account.conversation('CN2', { participants: ['+17375550198'], createdAt: T0 - 60 * MIN });
  // CN1 has the newest activity, so it is read FIRST: a failure there must not stop CN2.
  account.text('CN1', T0 + MIN, 'incoming');
  account.text('CN2', T0, 'incoming');
  account.fail.add('CN1');

  const real = console.error; const errors = [];
  console.error = (...a) => errors.push(a.map(String).join(' '));
  try { await poll(env, account, T0 + 5 * MIN); } finally { console.error = real; }

  assert.equal(await thread(env, 'CN1'), null);
  assert.ok(await thread(env, 'CN2'), 'CN2 still synced');
  assert.equal((await source(env)).sync_cursor, null, 'cursor held so CN1 is retried');
  assert.ok(errors.some((e) => e.includes('CN1')), errors.join('\n'));

  account.fail.delete('CN1');
  await poll(env, account, T0 + 10 * MIN);
  assert.ok(await thread(env, 'CN1'), 'CN1 picked up on the next poll');
});

test('uses the documented v1 endpoints only', async () => {
  const { env, account } = setup();
  account.text('CN1', T0, 'incoming');
  await poll(env, account, T0 + 5 * MIN);
  const paths = new Set(account.requests.map((u) => u.pathname));
  assert.deepEqual([...paths].sort(), ['/v1/calls', '/v1/conversations', '/v1/messages']);
});

test('an undelivered outgoing text is not contact: the thread stays waiting', async () => {
  const { env, account } = setup();
  account.text('CN1', T0, 'incoming');
  account.text('CN1', T0 + 5 * MIN, 'outgoing', { status: 'undelivered' });
  await poll(env, account, T0 + 10 * MIN);

  const t = await thread(env);
  assert.equal(t.status, 'waiting');
  assert.equal(t.awaiting_since, T0);
});
