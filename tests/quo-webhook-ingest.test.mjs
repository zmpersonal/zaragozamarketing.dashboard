// Phone is real-time: a verified Quo webhook event writes the thread straight
// away, through the same code as polling (syncQuoActivity -> toTimeline ->
// syncThread), so the two cannot drift. Repeat deliveries are deduplicated by
// webhook-id, and hourly polling afterwards changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestQuo } from '../src/ingest/quo.ts';
import { makeQuoEnv, makeQuoAccount, withQuo, CUSTOMER, SOURCE_ID } from './helpers/quo.mjs';
import { deliver, messageReceived, messageDelivered, messageUndelivered, callCompleted, callMissed, eventsFor } from './helpers/quo-webhook.mjs';

const T0 = Math.floor(Date.now() / 1000) - 2 * 3600;
const MIN = 60;
const thread = (env, cn = 'CN1') => env.DB.raw.prepare('SELECT * FROM thread WHERE id = ?').get(`quo:${cn}`);
const count = (env, table) => env.DB.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const quietly = async (fn) => {
  const real = { log: console.log, error: console.error, warn: console.warn };
  const lines = [];
  console.log = console.error = console.warn = (...a) => lines.push(a.map(String).join(' '));
  try { return { result: await fn(), lines }; } finally { Object.assign(console, real); }
};

function snapshot(raw) {
  const all = (sql) => raw.prepare(sql).all().map((r) => ({ ...r }));
  return {
    thread: all('SELECT * FROM thread ORDER BY id'),
    response: all('SELECT thread_id, awaiting_since, responded_at, business_minutes, via FROM response ORDER BY thread_id, awaiting_since'),
    action: all('SELECT thread_id, actor, kind FROM action ORDER BY id'),
  };
}

test('a new inbound text for a conversation we have never seen creates a waiting phone thread, immediately', async () => {
  const env = makeQuoEnv();
  const r = await deliver(env, messageReceived({ cn: 'CN1', at: T0, from: CUSTOMER, text: 'Is the chiller 220v?' }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, result: 'synced' });
  const t = thread(env);
  assert.equal(t.status, 'waiting');
  assert.equal(t.awaiting_since, T0);
  assert.equal(t.channel, 'phone');
  assert.equal(t.source_id, SOURCE_ID);
  assert.equal(t.customer_handle, CUSTOMER);
  assert.equal(t.triage, 'customer', 'classified the way polling classifies phone threads');
  assert.equal(t.preview, 'Is the chiller 220v?');
  assert.equal(t.last_inbound_at, T0);
});

test('our reply ends the wait, records the response time, and keeps the text preview', async () => {
  const env = makeQuoEnv();
  await deliver(env, messageReceived({ cn: 'CN1', at: T0, from: CUSTOMER, text: 'Is the chiller 220v?' }));
  const r = await deliver(env, messageDelivered({ cn: 'CN1', at: T0 + 10 * MIN, to: CUSTOMER, text: 'Yes, 220v.' }));
  assert.equal(r.status, 200);
  const t = thread(env);
  assert.equal(t.status, 'answered');
  assert.equal(t.awaiting_since, null);
  assert.equal(t.last_outbound_at, T0 + 10 * MIN);
  const resp = env.DB.raw.prepare('SELECT awaiting_since, responded_at, via FROM response').all().map((x) => ({ ...x }));
  assert.deepEqual(resp, [{ awaiting_since: T0, responded_at: T0 + 10 * MIN, via: 'message' }]);
  await deliver(env, callMissed({ cn: 'CN1', at: T0 + 30 * MIN, external: [CUSTOMER] }));
  assert.equal(thread(env).preview, 'Yes, 220v.', 'a call has no text, so the last text stays as the preview');
  assert.equal(thread(env).status, 'waiting', 'and the missed call is a new wait');
});

test('a failed or undelivered text is not a reply: the customer is still waiting', async () => {
  const env = makeQuoEnv();
  await deliver(env, messageReceived({ cn: 'CN1', at: T0, from: CUSTOMER }));
  const failed = messageUndelivered({ cn: 'CN1', at: T0 + MIN, to: CUSTOMER });
  failed.type = 'message.failed';
  failed.data.resource.status = 'failed';
  await deliver(env, failed);
  await deliver(env, messageUndelivered({ cn: 'CN1', at: T0 + 2 * MIN, to: CUSTOMER }));
  assert.equal(thread(env).status, 'waiting');
  assert.equal(thread(env).last_outbound_at, null);
  assert.equal(count(env, 'response'), 0);
});

test('calls: a missed call is waiting, and an answered incoming call is answered', async () => {
  const env = makeQuoEnv();
  await deliver(env, callMissed({ cn: 'CN1', at: T0, external: [CUSTOMER] }));
  assert.equal(thread(env).status, 'waiting');
  assert.equal(thread(env).awaiting_since, T0);
  await deliver(env, callCompleted({ cn: 'CN2', at: T0, direction: 'incoming', answeredAfter: 20, external: ['+17375550198'] }));
  assert.equal(thread(env, 'CN2').status, 'answered');
});

test('a repeat delivery (same webhook-id) is acknowledged and writes nothing', async () => {
  const env = makeQuoEnv();
  const event = messageReceived({ cn: 'CN1', at: T0, from: CUSTOMER });
  const first = await deliver(env, event, { webhookId: 'msg_dup_1' });
  await deliver(env, messageDelivered({ cn: 'CN1', at: T0 + 5 * MIN, to: CUSTOMER }));
  const before = snapshot(env.DB.raw);
  const again = await deliver(env, event, { webhookId: 'msg_dup_1' });
  assert.equal(first.status, 200);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, { ok: true, result: 'duplicate' });
  assert.deepEqual(snapshot(env.DB.raw), before, 'the old inbound was not replayed over the reply');
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM webhook_delivery WHERE webhook_id = 'msg_dup_1'").get().n, 1);
});

test('the same event delivered twice under different webhook-ids is still counted once', async () => {
  const env = makeQuoEnv();
  const inbound = messageReceived({ cn: 'CN1', at: T0, from: CUSTOMER });
  const reply = messageDelivered({ cn: 'CN1', at: T0 + 5 * MIN, to: CUSTOMER });
  for (const e of [inbound, reply, inbound, reply]) assert.equal((await deliver(env, e)).status, 200);
  assert.equal(count(env, 'response'), 1);
  assert.equal(thread(env).status, 'answered');
});

test('events we cannot place are acknowledged and ignored, not errors: unknown number, no conversation, other types', async () => {
  const env = makeQuoEnv();
  const { result, lines } = await quietly(async () => [
    await deliver(env, messageReceived({ cn: 'CN1', at: T0, from: CUSTOMER, phone: 'PN-not-ours' })),
    await deliver(env, messageReceived({ cn: null, at: T0, from: CUSTOMER })),
    await deliver(env, { ...messageReceived({ cn: 'CN1', at: T0, from: CUSTOMER }), type: 'call.ringing' }),
    await deliver(env, { id: 'EV', type: 'contact.updated', data: { resource: { id: 'CT1' }, context: { orgId: 'OR1' } } }),
  ]);
  assert.deepEqual(result.map((r) => [r.status, r.body.result]), [[200, 'ignored'], [200, 'ignored'], [200, 'ignored'], [200, 'ignored']]);
  assert.equal(count(env, 'thread'), 0);
  assert.ok(lines.some((l) => l.includes('PN-not-ours')), lines.join('\n'));
});

test('a malformed event of a type we ingest is a 400, so it shows as failed in Quo’s delivery log', async () => {
  const env = makeQuoEnv();
  const bad = messageReceived({ cn: 'CN1', at: T0, from: CUSTOMER });
  delete bad.data.resource.createdAt;
  const { result } = await quietly(() => deliver(env, bad));
  assert.equal(result.status, 400);
  assert.equal(count(env, 'thread'), 0);
  assert.equal(count(env, 'webhook_delivery'), 0);
});

test('a database failure is a 500 and the delivery is not marked seen, so Quo’s retry is processed', async () => {
  const env = makeQuoEnv();
  const event = messageReceived({ cn: 'CN1', at: T0, from: CUSTOMER });
  let fail = true;
  const db = { ...env.DB, prepare: (sql) => { if (fail && /INSERT INTO thread/.test(sql)) { fail = false; throw new Error('D1_ERROR: overloaded'); } return env.DB.prepare(sql); } };
  const { result: first } = await quietly(() => deliver({ ...env, DB: db }, event, { webhookId: 'msg_retry' }));
  assert.equal(first.status, 500);
  assert.equal(count(env, 'webhook_delivery'), 0);
  const retry = await deliver(env, event, { webhookId: 'msg_retry' });
  assert.equal(retry.status, 200);
  assert.equal(thread(env).status, 'waiting');
});

test('polling after the webhook changes nothing: no new rows, no double-counted response, no reopen', async () => {
  const env = makeQuoEnv();
  const account = makeQuoAccount();
  account.conversation('CN1', { participants: [CUSTOMER], createdAt: T0 - 3600 });
  account.text('CN1', T0, 'incoming');
  account.text('CN1', T0 + 10 * MIN, 'outgoing');
  account.call('CN1', T0 + 30 * MIN, 'incoming');                         // missed
  account.conversation('CN2', { participants: ['+17375550198'], createdAt: T0 - 3600 });
  account.call('CN2', T0 + 5 * MIN, 'incoming', { answeredAfter: 15 });
  for (const e of eventsFor(account)) assert.equal((await deliver(env, e)).status, 200);
  const afterWebhooks = snapshot(env.DB.raw);
  assert.equal(afterWebhooks.response.length, 2);

  await quietly(() => withQuo(account, () => ingestQuo(env)));
  await quietly(() => withQuo(account, () => ingestQuo(env)));
  const afterPolls = snapshot(env.DB.raw);
  // conversation_started_at is insert-only: the webhook saw the thread first.
  assert.deepEqual(afterPolls, afterWebhooks);
});

test('same code path: the webhook and polling produce the same threads and responses from the same activity', async () => {
  const account = makeQuoAccount();
  account.conversation('CN1', { participants: [CUSTOMER], createdAt: T0 });
  account.text('CN1', T0, 'incoming');
  account.text('CN1', T0 + 3 * MIN, 'incoming');
  account.text('CN1', T0 + 20 * MIN, 'outgoing');
  account.text('CN1', T0 + 25 * MIN, 'outgoing', { status: 'undelivered' });
  account.call('CN1', T0 + 40 * MIN, 'incoming');
  account.conversation('CN2', { participants: ['+17375550198'], createdAt: T0 + 50 * MIN });
  account.call('CN2', T0 + 50 * MIN, 'outgoing', { answeredAfter: 30 });

  const viaWebhook = makeQuoEnv();
  for (const e of eventsFor(account)) await deliver(viaWebhook, e);
  const viaPolling = makeQuoEnv();
  await quietly(() => withQuo(account, () => ingestQuo(viaPolling)));

  const shape = (raw) => {
    const s = snapshot(raw);
    // Polling knows the conversation's own createdAt and name; a webhook-first thread starts at its first event.
    s.thread = s.thread.map(({ conversation_started_at, customer_name, subject, preview, ...rest }) => rest);
    return s;
  };
  assert.deepEqual(shape(viaWebhook.DB.raw), shape(viaPolling.DB.raw));
});
