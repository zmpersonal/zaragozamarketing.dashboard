// A demoted message rescued into the queue keeps its original arrival time.
// Rescuing changes the triage verdict only; the response clock still runs
// from when the customer actually wrote, so the filter cannot launder a slow
// response into a fast one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestGmail } from '../src/ingest/gmail.ts';
import { rescueThread } from '../src/db/threads.ts';
import { responseMinutes } from '../src/lib/thread-state.ts';
import { businessMinutes } from '../src/lib/clock.ts';
import { makeEnv, withGmail, inbound, row, at } from './helpers/gmail.mjs';

const ARRIVED = '2026-09-15T09:00:00-05:00'; // Tue 09:00, filed as bulk
const RESCUED = '2026-09-17T15:00:00-05:00'; // Thu 15:00, agent spots it and rescues it

test('rescue keeps conversation_started_at and awaiting_since at original arrival', async () => {
  const env = makeEnv();
  const mailbox = { t1: [inbound(ARRIVED, 'Dana Reyes <dana@example.com>')] };
  await withGmail(mailbox, () => ingestGmail(env));
  // Demoted by triage.
  await env.DB.prepare(
    `UPDATE thread SET triage = 'bulk', triage_score = 2, triage_signals = '["list_unsubscribe"]' WHERE id = 'gmail:t1'`
  ).run();

  await rescueThread(env.DB, 'gmail:t1', 'dana.agent@inhousewellness.com', at(RESCUED));

  const t = await row(env, 't1');
  assert.equal(t.triage, 'customer');
  assert.equal(t.triage_by, 'dana.agent@inhousewellness.com');
  assert.equal(t.conversation_started_at, at(ARRIVED));
  assert.equal(t.awaiting_since, at(ARRIVED));

  // The clock measures from arrival: Tue 08h + Wed 9h + Thu 7h of business time.
  const expected = businessMinutes(at(ARRIVED), at(RESCUED));
  assert.equal(expected, 8 * 60 + 9 * 60 + 7 * 60);
  assert.equal(responseMinutes(t, at(RESCUED)), expected);

  // The rescue is in the audit log.
  const log = await env.DB.prepare(`SELECT actor, kind, created_at FROM action WHERE thread_id = 'gmail:t1'`).all();
  assert.deepEqual(log.results, [
    { actor: 'dana.agent@inhousewellness.com', kind: 'rescued', created_at: at(RESCUED) },
  ]);
});

test('the next ingest after a rescue moves neither timestamp nor the human verdict', async () => {
  const env = makeEnv();
  const mailbox = { t1: [inbound(ARRIVED, 'Dana Reyes <dana@example.com>')] };
  await withGmail(mailbox, () => ingestGmail(env));
  await env.DB.prepare(`UPDATE thread SET triage = 'bulk' WHERE id = 'gmail:t1'`).run();
  await rescueThread(env.DB, 'gmail:t1', 'dana.agent@inhousewellness.com', at(RESCUED));

  await withGmail(mailbox, () => ingestGmail(env));

  const t = await row(env, 't1');
  assert.equal(t.conversation_started_at, at(ARRIVED));
  assert.equal(t.awaiting_since, at(ARRIVED));
  assert.equal(t.triage, 'customer');
});

test('responseMinutes is null when caught up, and never falls back to conversation_started_at', () => {
  assert.equal(responseMinutes({ awaiting_since: null, conversation_started_at: at(ARRIVED) }, at(RESCUED)), null);
});
