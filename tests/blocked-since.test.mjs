// blocked_since: when a thread moved to 'blocked'. Blocked threads are a
// different kind of waiting, not ageless: the queue shows "blocked 6d" from
// it, and they sort by it in their own group below the waiting threads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { ingestGmail } from '../src/ingest/gmail.ts';
import { withGmail, inbound, MAILBOX, row } from './helpers/gmail.mjs';
import { makeApiEnv, withAccess, mintToken, apiRequest, insertThread, OWNER } from './helpers/access.mjs';

const nowSec = () => Math.floor(Date.now() / 1000);
const DAY = 86400, HOUR = 3600;

const send = async (env, path, { method = 'GET', body, email } = {}) =>
  withAccess(async () => worker.fetch(apiRequest(path, { method, body, token: await mintToken(email ? { email } : {}) }), env));

const act = async (env, body) => {
  const res = await send(env, 'actions', { method: 'POST', body });
  assert.equal(res.status, 200, await res.clone().text());
};

test('moving to blocked sets blocked_since; staying blocked keeps it; leaving clears it', async () => {
  const env = makeApiEnv();
  insertThread(env, { id: 'gmail:t1' });

  const before = nowSec();
  await act(env, { thread_id: 'gmail:t1', kind: 'note', status: 'blocked', blocked_on: 'supplier' });
  let t = await row(env, 't1');
  assert.ok(t.blocked_since >= before && t.blocked_since <= nowSec(), 'blocked_since set to now');
  const first = t.blocked_since;

  // Pretend it has been blocked for 6 days, then the agent saves it as blocked again.
  env.DB.raw.prepare(`UPDATE thread SET blocked_since = ? WHERE id = 'gmail:t1'`).run(first - 6 * DAY);
  await act(env, { thread_id: 'gmail:t1', kind: 'note', body: 'Chased supplier.', status: 'blocked', blocked_on: 'supplier' });
  t = await row(env, 't1');
  assert.equal(t.blocked_since, first - 6 * DAY, 're-saving blocked keeps the original start');

  await act(env, { thread_id: 'gmail:t1', kind: 'replied', status: 'answered' });
  t = await row(env, 't1');
  assert.equal(t.blocked_since, null, 'leaving blocked clears it');
});

test('a sync on a blocked thread leaves blocked_since alone', async () => {
  const env = makeApiEnv();
  env.GOOGLE_CLIENT_ID = 'x.apps.googleusercontent.com';
  env.GOOGLE_CLIENT_SECRET = 's';
  env.GOOGLE_REFRESH_TOKENS = JSON.stringify({ [MAILBOX]: 'r' });
  const mailbox = { t1: [inbound(new Date((nowSec() - 2 * HOUR) * 1000).toISOString(), 'Dana <dana@example.com>')] };
  await withGmail(mailbox, () => ingestGmail(env));
  await act(env, { thread_id: 'gmail:t1', kind: 'note', status: 'blocked', blocked_on: 'shipping' });
  const { blocked_since } = await row(env, 't1');

  await withGmail(mailbox, () => ingestGmail(env));
  const t = await row(env, 't1');
  assert.equal(t.status, 'blocked');
  assert.equal(t.blocked_since, blocked_since);
});

test('queue: waiting threads first by awaiting_since, then blocked by blocked_since', async () => {
  const env = makeApiEnv();
  const n = nowSec();
  insertThread(env, { id: 'gmail:waiting-1h', awaiting_since: n - 1 * HOUR });
  insertThread(env, { id: 'gmail:blocked-1d', status: 'blocked', awaiting_since: n - 10 * DAY, blocked_since: n - 1 * DAY });
  insertThread(env, { id: 'gmail:waiting-5h', awaiting_since: n - 5 * HOUR });
  insertThread(env, { id: 'gmail:blocked-6d', status: 'blocked', awaiting_since: null, blocked_since: n - 6 * DAY });

  const res = await send(env, 'queue', { email: OWNER });
  const threads = (await res.json()).threads;
  assert.deepEqual(threads.map((t) => t.id), [
    'gmail:waiting-5h', 'gmail:waiting-1h', 'gmail:blocked-6d', 'gmail:blocked-1d',
  ]);
  assert.equal(threads.find((t) => t.id === 'gmail:blocked-6d').blocked_since, n - 6 * DAY);
});

test('a customer chasing a blocked thread moves it out of the blocked group in the queue', async () => {
  const env = makeApiEnv();
  env.GOOGLE_CLIENT_ID = 'x.apps.googleusercontent.com';
  env.GOOGLE_CLIENT_SECRET = 's';
  env.GOOGLE_REFRESH_TOKENS = JSON.stringify({ [MAILBOX]: 'r' });
  const n = nowSec();
  insertThread(env, { id: 'gmail:waiting-1h', awaiting_since: n - 1 * HOUR });
  insertThread(env, { id: 'gmail:blocked-6d', status: 'blocked', awaiting_since: null, blocked_since: n - 6 * DAY });
  const mailbox = { t1: [inbound(new Date((n - 30 * HOUR) * 1000).toISOString(), 'Dana <dana@example.com>')] };
  await withGmail(mailbox, () => ingestGmail(env));
  await act(env, { thread_id: 'gmail:t1', kind: 'replied', status: 'answered' });
  await act(env, { thread_id: 'gmail:t1', kind: 'note', status: 'blocked', blocked_on: 'shipping' });

  // Dana chases AFTER the agent's reply and block (dated 1 minute ahead, whole seconds like Gmail).
  mailbox.t1.push(inbound(new Date((nowSec() + 60) * 1000).toISOString(), 'Dana <dana@example.com>'));
  await withGmail(mailbox, () => ingestGmail(env));

  const threads = (await (await send(env, 'queue', { email: OWNER })).json()).threads;
  const t1 = threads.find((t) => t.id === 'gmail:t1');
  assert.equal(t1.status, 'waiting');
  assert.equal(t1.blocked_on, 'shipping');
  assert.deepEqual(threads.map((t) => t.id), ['gmail:waiting-1h', 'gmail:t1', 'gmail:blocked-6d'],
    'Dana is in the waiting group (by awaiting_since), above every blocked thread');
});
