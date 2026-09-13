// awaiting_since: the oldest inbound message with no outbound after it.
// NULL when we are caught up. The response clock runs from it; conversation_started_at
// is when the conversation began and never moves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestGmail } from '../src/ingest/gmail.ts';
import { ingestQuo } from '../src/ingest/quo.ts';
import { upsertChat } from '../src/ingest/chat.ts';
import { makeEnv, withGmail, inbound, outbound, row, at } from './helpers/gmail.mjs';
import { makeQuoEnv, makeQuoAccount, withQuo as withQuoApi } from './helpers/quo.mjs';

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

test('first contact: waiting, awaiting_since and conversation_started_at both = arrival', async () => {
  const env = makeEnv();
  await withGmail({ t1: [inbound(T0, DANA)] }, () => ingestGmail(env));

  const t = await row(env, 't1');
  assert.equal(t.status, 'waiting');
  assert.equal(t.conversation_started_at, at(T0));
  assert.equal(t.awaiting_since, at(T0));
});

test('after our reply: answered, awaiting_since NULL, conversation_started_at unchanged', async () => {
  const env = makeEnv();
  const mailbox = { t1: [inbound(T0, DANA)] };
  await withGmail(mailbox, () => ingestGmail(env));
  mailbox.t1.push(outbound(T1));
  await withGmail(mailbox, () => ingestGmail(env));

  const t = await row(env, 't1');
  assert.equal(t.status, 'answered');
  assert.equal(t.awaiting_since, null);
  assert.equal(t.conversation_started_at, at(T0));
});

test('follow-ups after our reply: awaiting_since = oldest unanswered, not conversation_started_at', async () => {
  const env = makeEnv();
  const mailbox = { t1: [inbound(T0, DANA), outbound(T1)] };
  await withGmail(mailbox, () => ingestGmail(env));
  mailbox.t1.push(inbound(T2, DANA), inbound(T3, DANA));
  await withGmail(mailbox, () => ingestGmail(env));

  const t = await row(env, 't1');
  assert.equal(t.status, 'waiting');
  assert.equal(t.awaiting_since, at(T2));
  assert.equal(t.conversation_started_at, at(T0));
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
  assert.equal(t.conversation_started_at, at(T0));
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
  assert.equal(t.conversation_started_at, at(T0));

  const log = await env.DB.prepare(`SELECT actor, kind FROM action WHERE thread_id = 'gmail:t1'`).all();
  assert.deepEqual(log.results, [{ actor: 'system', kind: 'reopened' }]);
});

test('guard: closed thread with nothing new stays closed and is not awaiting', async () => {
  // Dana's last "thanks" (T2) was never answered, and the agent closed it anyway.
  const env = makeEnv();
  const mailbox = { t1: [inbound(T0, DANA), outbound(T1), inbound(T2, DANA)] };
  await withGmail(mailbox, () => ingestGmail(env));
  await closeThread(env, 'gmail:t1', T3);

  // A Gmail change with no new inbound (archiving it) makes ingest re-read the thread.
  mailbox.t1[2].labelIds = [];
  await withGmail(mailbox, () => ingestGmail(env));
  await withGmail(mailbox, () => ingestGmail(env));

  const t = await row(env, 't1');
  assert.equal(t.status, 'closed');
  assert.equal(t.awaiting_since, null);
});

test('new inbound on a BLOCKED thread: back to waiting, clock from that message, blocked_on kept as context', async () => {
  const env = makeEnv();
  const mailbox = { t1: [inbound(T0, DANA), outbound(T1)] };
  await withGmail(mailbox, () => ingestGmail(env));
  await env.DB.prepare(`UPDATE thread SET status = 'blocked', blocked_on = 'supplier',
    blocked_note = 'Waiting on replacement heater', blocked_since = ?1 WHERE id = 'gmail:t1'`).bind(at(T1) + 60).run();

  mailbox.t1.push(inbound(T2, DANA));
  await withGmail(mailbox, () => ingestGmail(env));

  const t = await row(env, 't1');
  assert.equal(t.status, 'waiting');
  assert.equal(t.awaiting_since, at(T2));
  assert.equal(t.blocked_on, 'supplier', 'kept so the agent sees what it was stuck on');
  assert.equal(t.blocked_note, 'Waiting on replacement heater');
  assert.equal(t.blocked_since, null, 'no longer blocked, so no blocked age');
  const log = await env.DB.prepare(`SELECT actor, kind, body FROM action WHERE thread_id = 'gmail:t1'`).all();
  assert.equal(log.results.length, 1);
  assert.equal(log.results[0].actor, 'system');
  assert.equal(log.results[0].kind, 'unblocked');
  assert.match(log.results[0].body, /supplier/);
});

test('guard: a BLOCKED thread with nothing new stays blocked, even with an older unanswered message', async () => {
  const env = makeEnv();
  const mailbox = { t1: [inbound(T0, DANA)] };
  await withGmail(mailbox, () => ingestGmail(env));
  await env.DB.prepare(`UPDATE thread SET status = 'blocked', blocked_on = 'refund', blocked_since = ?1 WHERE id = 'gmail:t1'`).bind(at(T1)).run();

  await withGmail(mailbox, () => ingestGmail(env));
  await withGmail(mailbox, () => ingestGmail(env));

  const t = await row(env, 't1');
  assert.equal(t.status, 'blocked');
  assert.equal(t.blocked_since, at(T1));
  assert.equal(t.awaiting_since, at(T0));
});

// Quo polls messages since a cursor (tests/quo-ingest.test.mjs covers the
// interleaving cases); these check it applies the same first-contact and
// reopen rules as Gmail.
const quoAt = async (env, account, iso) => {
  const realNow = Date.now;
  Date.now = () => Date.parse(iso) + 5 * 60_000;
  try { await withQuoApi(account, () => ingestQuo(env)); } finally { Date.now = realNow; }
};
const quoRow = (env) => env.DB.prepare(`SELECT * FROM thread WHERE id = 'quo:CN1'`).first();

test('Quo first contact: waiting, awaiting_since = arrival', async () => {
  const env = makeQuoEnv();
  const account = makeQuoAccount();
  account.conversation('CN1', { createdAt: at(T0) });
  account.text('CN1', at(T0), 'incoming');
  await quoAt(env, account, T0);

  const t = await quoRow(env);
  assert.equal(t.status, 'waiting');
  assert.equal(t.awaiting_since, at(T0));
  assert.equal(t.conversation_started_at, at(T0));
});

test('Quo reopen: incoming text after close -> waiting, awaiting_since = that text', async () => {
  const env = makeQuoEnv();
  const account = makeQuoAccount();
  account.conversation('CN1', { createdAt: at(T0) });
  account.text('CN1', at(T0), 'incoming');
  await quoAt(env, account, T0);
  account.text('CN1', at(T1), 'outgoing');
  await quoAt(env, account, T1);
  await closeThread(env, 'quo:CN1', T2);

  account.text('CN1', at(T4), 'incoming');
  await quoAt(env, account, T4);

  const t = await quoRow(env);
  assert.equal(t.status, 'waiting');
  assert.equal(t.awaiting_since, at(T4));
  assert.equal(t.conversation_started_at, at(T0));
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
  assert.equal(t.conversation_started_at, at(T0));
});
