// awaiting_since: the oldest inbound message with no outbound after it.
// NULL when we are caught up. The response clock runs from it; first_inbound_at
// is when the conversation began and never moves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestGmail } from '../src/ingest/gmail.ts';
import { ingestQuo } from '../src/ingest/quo.ts';
import { upsertChat } from '../src/ingest/chat.ts';
import { makeEnv, withGmail, inbound, outbound, row, at } from './helpers/gmail.mjs';

const DANA = 'Dana Reyes <dana@example.com>';
const T0 = '2026-09-15T09:00:00-05:00'; // Tue: Dana writes in
const T1 = '2026-09-15T10:00:00-05:00'; //       we reply
const T2 = '2026-09-15T11:00:00-05:00'; //       Dana follows up
const T3 = '2026-09-15T11:30:00-05:00'; //       and again
const T4 = '2026-09-17T14:00:00-05:00'; // Thu: Dana writes again, after the thread was closed

/** What POST /api/actions does when an agent closes a thread. */
const closeThread = (env, threadId, iso) =>
  env.DB.prepare(`UPDATE thread SET status = 'closed', closed_at = ?2 WHERE id = ?1`)
    .bind(threadId, at(iso)).run();

// --- normal first contact --------------------------------------------------

test('first contact: waiting, awaiting_since and first_inbound_at both = arrival', async () => {
  const env = makeEnv();
  await withGmail({ t1: [inbound(T0, DANA)] }, () => ingestGmail(env));

  const t = await row(env, 't1');
  assert.equal(t.status, 'waiting');
  assert.equal(t.first_inbound_at, at(T0));
  assert.equal(t.awaiting_since, at(T0));
});

test('after our reply: answered, awaiting_since NULL, first_inbound_at unchanged', async () => {
  const env = makeEnv();
  const mailbox = { t1: [inbound(T0, DANA)] };
  await withGmail(mailbox, () => ingestGmail(env));
  mailbox.t1.push(outbound(T1));
  await withGmail(mailbox, () => ingestGmail(env));

  const t = await row(env, 't1');
  assert.equal(t.status, 'answered');
  assert.equal(t.awaiting_since, null);
  assert.equal(t.first_inbound_at, at(T0));
});

test('follow-ups after our reply: awaiting_since = oldest unanswered, not first_inbound_at', async () => {
  const env = makeEnv();
  const mailbox = { t1: [inbound(T0, DANA), outbound(T1)] };
  await withGmail(mailbox, () => ingestGmail(env));
  mailbox.t1.push(inbound(T2, DANA), inbound(T3, DANA));
  await withGmail(mailbox, () => ingestGmail(env));

  const t = await row(env, 't1');
  assert.equal(t.status, 'waiting');
  assert.equal(t.awaiting_since, at(T2));
  assert.equal(t.first_inbound_at, at(T0));
});

// --- reopen ------------------------------------------------------------------

test('reopen: new inbound on a closed thread -> waiting, awaiting_since = that message', async () => {
  const env = makeEnv();
  const mailbox = { t1: [inbound(T0, DANA), outbound(T1)] };
  await withGmail(mailbox, () => ingestGmail(env));
  await closeThread(env, 'gmail:t1', T2);

  mailbox.t1.push(inbound(T4, DANA));
  await withGmail(mailbox, () => ingestGmail(env));

  const t = await row(env, 't1');
  assert.equal(t.status, 'waiting');
  assert.equal(t.awaiting_since, at(T4));
  assert.equal(t.first_inbound_at, at(T0));
});

test('reopen: a message that arrived before the close but was never synced still reopens', async () => {
  // Dana writes at T2, the agent closes at T3 before the next cron has seen it.
  const env = makeEnv();
  const mailbox = { t1: [inbound(T0, DANA), outbound(T1)] };
  await withGmail(mailbox, () => ingestGmail(env));
  await closeThread(env, 'gmail:t1', T3);

  mailbox.t1.push(inbound(T2, DANA));
  await withGmail(mailbox, () => ingestGmail(env));

  const t = await row(env, 't1');
  assert.equal(t.status, 'waiting');
  assert.equal(t.awaiting_since, at(T2));
});

test('reopen is logged, and the next sync does not slide back to a pre-close message', async () => {
  // Dana's "thanks" at T2 was never answered; the agent closed the thread; she writes again at T4.
  const env = makeEnv();
  const mailbox = { t1: [inbound(T0, DANA), outbound(T1), inbound(T2, DANA)] };
  await withGmail(mailbox, () => ingestGmail(env));
  await closeThread(env, 'gmail:t1', T3);

  mailbox.t1.push(inbound(T4, DANA));
  await withGmail(mailbox, () => ingestGmail(env));
  await withGmail(mailbox, () => ingestGmail(env)); // a second sync must hold T4

  const t = await row(env, 't1');
  assert.equal(t.status, 'waiting');
  assert.equal(t.awaiting_since, at(T4));
  assert.equal(t.first_inbound_at, at(T0));

  const log = await env.DB.prepare(`SELECT actor, kind FROM action WHERE thread_id = 'gmail:t1'`).all();
  assert.deepEqual(log.results, [{ actor: 'system', kind: 'reopened' }]);
});

test('guard: closed thread with nothing new stays closed and is not awaiting', async () => {
  // Dana's last "thanks" (T2) was never answered, and the agent closed it anyway.
  const env = makeEnv();
  const mailbox = { t1: [inbound(T0, DANA), outbound(T1), inbound(T2, DANA)] };
  await withGmail(mailbox, () => ingestGmail(env));
  await closeThread(env, 'gmail:t1', T3);

  await withGmail(mailbox, () => ingestGmail(env));
  await withGmail(mailbox, () => ingestGmail(env));

  const t = await row(env, 't1');
  assert.equal(t.status, 'closed');
  assert.equal(t.awaiting_since, null);
});

test('guard: new inbound on a BLOCKED thread keeps it blocked, but the clock starts', async () => {
  const env = makeEnv();
  const mailbox = { t1: [inbound(T0, DANA), outbound(T1)] };
  await withGmail(mailbox, () => ingestGmail(env));
  await env.DB.prepare(`UPDATE thread SET status = 'blocked', blocked_on = 'supplier' WHERE id = 'gmail:t1'`).run();

  mailbox.t1.push(inbound(T2, DANA));
  await withGmail(mailbox, () => ingestGmail(env));

  const t = await row(env, 't1');
  assert.equal(t.status, 'blocked');
  assert.equal(t.awaiting_since, at(T2));
});

// --- Quo and chat follow the same rules ---------------------------------------

async function withQuo(conversations, fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    if (url.origin + url.pathname === 'https://api.quo.com/conversations') {
      return new Response(JSON.stringify({ data: conversations }), { headers: { 'content-type': 'application/json' } });
    }
    throw new Error('unexpected fetch in test: ' + url.href);
  };
  try { return await fn(); } finally { globalThis.fetch = realFetch; }
}

function quoEnv() {
  const env = makeEnv();
  env.QUO_API_KEY = 'test-key';
  env.DB.raw.exec(`INSERT INTO source (id, brand_id, channel, provider, address)
                   VALUES ('quo:PN1', 'inhouse', 'phone', 'quo', 'PN1')`);
  return env;
}
const convo = (iso, direction) => ({
  id: 'CN1', name: 'Marcus Bell', participants: ['+15125550142'],
  lastActivityAt: iso, lastActivityDirection: direction, lastActivityType: 'message', previewText: 'hi',
});
const quoRow = (env) => env.DB.prepare(`SELECT * FROM thread WHERE id = 'quo:CN1'`).first();

test('Quo first contact: waiting, awaiting_since = arrival', async () => {
  const env = quoEnv();
  await withQuo([convo(T0, 'incoming')], () => ingestQuo(env));
  const t = await quoRow(env);
  assert.equal(t.status, 'waiting');
  assert.equal(t.awaiting_since, at(T0));
  assert.equal(t.first_inbound_at, at(T0));
});

test('Quo reopen: incoming activity after close -> waiting, awaiting_since = that activity', async () => {
  const env = quoEnv();
  await withQuo([convo(T0, 'incoming')], () => ingestQuo(env));
  await withQuo([convo(T1, 'outgoing')], () => ingestQuo(env));
  await closeThread(env, 'quo:CN1', T2);
  await withQuo([convo(T4, 'incoming')], () => ingestQuo(env));

  const t = await quoRow(env);
  assert.equal(t.status, 'waiting');
  assert.equal(t.awaiting_since, at(T4));
  assert.equal(t.first_inbound_at, at(T0));
});

test('chat first contact and reopen', async () => {
  const env = makeEnv();
  env.DB.raw.exec(`INSERT INTO source (id, brand_id, channel, provider, address)
                   VALUES ('chat:widget', 'inhouse', 'chat', 'tidio', 'widget')`);
  const chat = (iso, awaitingHuman) => ({
    externalId: 'C1', brandId: 'inhouse', visitorName: 'Visitor', preview: '220v wiring?',
    startedAt: at(T0), lastInboundAt: at(iso), awaitingHuman, handledByBot: false,
  });
  const chatRow = () => env.DB.prepare(`SELECT * FROM thread WHERE id = 'chat:C1'`).first();

  await upsertChat(env, 'chat:widget', chat(T0, true));
  let t = await chatRow();
  assert.equal(t.status, 'waiting');
  assert.equal(t.awaiting_since, at(T0));

  await closeThread(env, 'chat:C1', T2);
  await upsertChat(env, 'chat:widget', chat(T4, true));
  t = await chatRow();
  assert.equal(t.status, 'waiting');
  assert.equal(t.awaiting_since, at(T4));
  assert.equal(t.first_inbound_at, at(T0));
});
