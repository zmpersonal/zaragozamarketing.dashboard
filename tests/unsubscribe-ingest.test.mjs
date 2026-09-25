// The unsubscribe header has to survive ingest to be any use to the agent
// (round 15). Gmail already hands us every header on the first inbound message
// — triage reads List-Unsubscribe to decide bulk — but nothing was stored, so
// the console could tell you a thread was bulk without telling you how to stop it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestGmail } from '../src/ingest/gmail.ts';
import { makeEnv, withGmail, inbound, row, MAILBOX } from './helpers/gmail.mjs';

const CUSTOMER = 'Newsletter <news@example.com>';
const run = async (headers) => {
  const env = makeEnv();
  const threads = { t1: [inbound(new Date(Date.now() - 2 * 86400e3).toISOString(), CUSTOMER, 'Autumn offers', { headers })] };
  await withGmail(threads, () => ingestGmail(env));
  return await row(env, 't1');
};

test('the header is stored with the thread, as sent', async () => {
  const t = await run({
    'List-Unsubscribe': '<mailto:u@example.com>, <https://example.com/u/abc>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  });
  const stored = JSON.parse(t.unsubscribe);
  assert.equal(stored.h, '<mailto:u@example.com>, <https://example.com/u/abc>');
  assert.equal(stored.post, 'List-Unsubscribe=One-Click');
});

test('a thread without the header stores nothing', async () => {
  assert.equal((await run({})).unsubscribe, null);
});

test('one-click is stored only when the sender advertises it', async () => {
  const t = await run({ 'List-Unsubscribe': '<https://example.com/u/abc>' });
  assert.equal(JSON.parse(t.unsubscribe).post, undefined);
});

test('the header still decides bulk, as it always did', async () => {
  const t = await run({ 'List-Unsubscribe': '<https://example.com/u/abc>' });
  assert.equal(t.triage, 'bulk');
  assert.match(t.triage_signals, /list_unsubscribe/);
});
