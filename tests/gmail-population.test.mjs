// Live Gmail ingest reads the same population as prove/triage.mjs: everything
// received in the window (archived, filtered, spam, trash), excluding only
// sent, drafts and chats, paged to the end. Each thread gets a triage tier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestGmail } from '../src/ingest/gmail.ts';
import { rescueThread } from '../src/db/threads.ts';
import { makeEnv, withGmail, inbound, outbound, row, MAILBOX, PAGE_SIZE } from './helpers/gmail.mjs';

const DAY = 86400_000;
const ago = (days) => new Date(Math.floor((Date.now() - days * DAY) / 1000) * 1000).toISOString();
const QUERY = 'in:anywhere newer_than:30d -in:sent -in:drafts -in:chats';
const BULK = { 'List-Unsubscribe': '<mailto:u@brand.example>' };

async function run(env, threads, opts = {}) {
  const logs = [];
  const real = { log: console.log, error: console.error };
  console.log = (...a) => logs.push(a.map(String).join(' '));
  console.error = (...a) => logs.push('ERROR ' + a.map(String).join(' '));
  const requests = [];
  try { await withGmail(threads, () => ingestGmail(env), { requests, ...opts }); }
  finally { Object.assign(console, real); }
  return { logs, requests };
}

const triage = async (env, id) => {
  const t = await row(env, id);
  return t && { tier: t.triage, codes: JSON.parse(t.triage_signals ?? '[]').map((s) => s.code).sort(), by: t.triage_by };
};

test('an archived message and a spam-filed message are both ingested', async () => {
  const env = makeEnv();
  await run(env, {
    archived: [inbound(ago(2), 'Sam Ortiz <sam@example.com>', 'Re: chiller warranty', { labelIds: [] })],
    spamfiled: [inbound(ago(3), 'Prize Desk <win@prize.example>', 'You have won', { labelIds: ['SPAM'] })],
  });
  assert.ok(await row(env, 'archived'), 'archived message ingested');
  assert.ok(await row(env, 'spamfiled'), 'spam-filed message ingested');
  assert.equal((await row(env, 'archived')).status, 'waiting');
});

test('ingest logs the exact query, and lists messages with includeSpamTrash, paged to the end', async () => {
  const env = makeEnv();
  const threads = {};
  for (let i = 0; i < PAGE_SIZE * 2 + 1; i++) threads[`t${i}`] = [inbound(ago(1 + i), `C${i} <c${i}@example.com>`)];
  const { logs, requests } = await run(env, threads);

  assert.ok(logs.some((l) => l.includes(`query "${QUERY}"`) && l.includes('includeSpamTrash=true')), logs.join('\n'));
  const lists = requests.filter((u) => u.pathname.endsWith('/messages'));
  assert.ok(lists.length >= 3, 'followed nextPageToken');
  assert.ok(lists.every((u) => u.searchParams.get('q') === QUERY && u.searchParams.get('includeSpamTrash') === 'true'));
  for (const id of Object.keys(threads)) assert.ok(await row(env, id), `${id} ingested (incl. the last page)`);
});

test('sent-only, draft-only and chat-only threads are not ingested; a thread we replied to is', async () => {
  const env = makeEnv();
  await run(env, {
    sentonly: [outbound(ago(1))],
    draft: [{ ...outbound(ago(1)), labelIds: ['DRAFT'] }],
    chat: [{ ...inbound(ago(1), 'Team <team@inhousewellness.com>'), labelIds: ['CHAT'] }],
    replied: [inbound(ago(2), 'Dana <dana@example.com>'), outbound(ago(1))],
  });
  assert.equal(await row(env, 'sentonly'), null);
  assert.equal(await row(env, 'draft'), null);
  assert.equal(await row(env, 'chat'), null);
  assert.equal((await row(env, 'replied')).status, 'answered');
});

test('each thread gets its tier and reasons: customer, bulk, spam', async () => {
  const env = makeEnv();
  await run(env, {
    cust: [inbound(ago(1), 'Dana <dana@example.com>')],
    bulk: [inbound(ago(1), 'Brand <news@brand.example>', 'Sale', { labelIds: ['CATEGORY_PROMOTIONS'], headers: BULK })],
    spam: [inbound(ago(1), 'Prize <win@prize.example>', 'You have won', { labelIds: ['SPAM'] })],
    both: [inbound(ago(1), 'Brand <news@brand.example>', 'Sale', { labelIds: ['SPAM', 'CATEGORY_PROMOTIONS'], headers: BULK })],
  });
  assert.deepEqual(await triage(env, 'cust'), { tier: 'customer', codes: [], by: null });
  assert.deepEqual(await triage(env, 'bulk'), { tier: 'bulk', codes: ['gmail_promo', 'list_unsubscribe'], by: null });
  assert.deepEqual(await triage(env, 'spam'), { tier: 'spam', codes: ['gmail_spam'], by: null });
  assert.deepEqual(await triage(env, 'both'), { tier: 'spam', codes: ['gmail_promo', 'gmail_spam', 'list_unsubscribe'], by: null });
});

test('a sender we replied to in another thread is customer even when Gmail files the new thread as spam', async () => {
  const env = makeEnv();
  const threads = { first: [inbound(ago(10), 'Priya <priya@acme.example>'), outbound(ago(9))] };
  await run(env, threads);
  threads.second = [inbound(ago(1), 'Priya <priya@acme.example>', 'Invoice 2214', { labelIds: ['SPAM'] })];
  await run(env, threads);
  assert.equal((await triage(env, 'second')).tier, 'customer');
});

test('a verified customer (sender_rule row in the database) filed as spam is ingested as customer', async () => {
  const env = makeEnv();
  env.DB.raw.prepare(`INSERT INTO sender_rule (address, verdict, set_by, created_at) VALUES (?, 'customer', 'owner', 0)`)
    .run('verified.customer@example.com');
  await run(env, { v: [inbound(ago(3), 'A Customer <verified.customer@example.com>', 'Track a shipment for my order', { labelIds: ['SPAM'] })] });
  assert.equal((await triage(env, 'v')).tier, 'customer');
  assert.equal((await row(env, 'v')).status, 'waiting');
});

test('a triage verdict a human set is never overwritten by ingest', async () => {
  const env = makeEnv();
  const threads = { s: [inbound(ago(2), 'Maybe Real <maybe@real.example>', 'Problem with my order', { labelIds: ['SPAM'] })] };
  await run(env, threads);
  assert.equal((await triage(env, 's')).tier, 'spam');
  await rescueThread(env.DB, 'gmail:s', 'agent@inhousewellness.com', Math.floor(Date.now() / 1000));
  await run(env, threads);
  assert.deepEqual(await triage(env, 's'), { tier: 'customer', codes: ['gmail_spam'], by: 'agent@inhousewellness.com' });
});
