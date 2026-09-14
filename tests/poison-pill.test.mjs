// A record that keeps failing must not hold the Quo cursor back forever
// (that silently stops all phone ingest). After repeated failures it is
// skipped, recorded somewhere visible, and ingest continues.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { ingestQuo } from '../src/ingest/quo.ts';
import { ingestGmail } from '../src/ingest/gmail.ts';
import { makeQuoEnv, makeQuoAccount, withQuo, SOURCE_ID } from './helpers/quo.mjs';
import { makeEnv, withGmail, inbound, row, SOURCE_ID as GMAIL_SOURCE } from './helpers/gmail.mjs';
import { withAccess, mintToken, apiRequest, AUD, TEAM, OWNER } from './helpers/access.mjs';

const T0 = 1789480800;
const MIN = 60;

const quiet = async (fn) => {
  const real = console.error; const lines = [];
  console.error = (...a) => lines.push(a.map(String).join(' '));
  try { await fn(); } finally { console.error = real; }
  return lines;
};
const pollAt = (env, account, nowSec) => quiet(async () => {
  const real = Date.now; Date.now = () => nowSec * 1000;
  try { await withQuo(account, () => ingestQuo(env)); } finally { Date.now = real; }
});
// The cursor's high-water mark: when the last fully-read scan started (null = never completed).
const cursor = async (env) => JSON.parse((await env.DB.prepare('SELECT sync_cursor FROM source WHERE id = ?1').bind(SOURCE_ID).first()).sync_cursor ?? '{"highWater":null}').highWater;
const failures = async (env) => (await env.DB.prepare('SELECT * FROM ingest_failure ORDER BY item_id').all()).results;
const thread = (env, cn) => env.DB.prepare('SELECT * FROM thread WHERE id = ?1').bind(`quo:${cn}`).first();

function setup() {
  const env = makeQuoEnv();
  const account = makeQuoAccount();
  account.conversation('CN-BAD', { participants: ['+15125550111'], createdAt: T0 - 3600 });
  account.conversation('CN-OK', { participants: ['+15125550222'], createdAt: T0 - 3600 });
  account.text('CN-BAD', T0, 'incoming');
  account.fail.add('CN-BAD');
  return { env, account };
}

test('a conversation that keeps failing is skipped after 3 polls and the cursor moves on', async () => {
  const { env, account } = setup();

  for (let poll = 1; poll <= 2; poll++) {
    account.text('CN-OK', T0 + poll * 10 * MIN, 'incoming');
    await pollAt(env, account, T0 + poll * 10 * MIN + MIN);
    assert.equal(await cursor(env), null, `poll ${poll}: cursor held so CN-BAD is retried`);
    const [f] = await failures(env);
    assert.equal(f.failures, poll);
    assert.equal(f.skipped_at, null);
  }

  account.text('CN-OK', T0 + 30 * MIN, 'incoming');
  const logs = await pollAt(env, account, T0 + 31 * MIN);
  assert.equal(await cursor(env), T0 + 31 * MIN, 'poll 3: skipped past the poison record');
  const [f] = await failures(env);
  assert.equal(f.source_id, SOURCE_ID);
  assert.equal(f.item_id, 'quo:CN-BAD');
  assert.equal(f.failures, 3);
  assert.equal(f.skipped_at, T0 + 31 * MIN);
  assert.match(f.last_error, /500/);
  assert.ok(logs.some((l) => /skip/i.test(l) && l.includes('CN-BAD')), logs.join('\n'));

  // Ingest carries on: new activity is picked up and the cursor keeps advancing.
  account.text('CN-OK', T0 + 40 * MIN, 'incoming');
  await pollAt(env, account, T0 + 41 * MIN);
  assert.equal(await cursor(env), T0 + 41 * MIN);
  assert.equal((await thread(env, 'CN-OK')).last_inbound_at, T0 + 40 * MIN);
});

test('a conversation that recovers before the limit is cleared from the failure record', async () => {
  const { env, account } = setup();
  await pollAt(env, account, T0 + MIN);
  assert.equal((await failures(env)).length, 1);

  account.fail.delete('CN-BAD');
  await pollAt(env, account, T0 + 2 * MIN);
  assert.deepEqual(await failures(env), []);
  assert.ok(await thread(env, 'CN-BAD'));
  assert.equal(await cursor(env), T0 + 2 * MIN);
});

test('skipped and failing records are visible on the board', async () => {
  const { env, account } = setup();
  for (let i = 1; i <= 3; i++) await pollAt(env, account, T0 + i * MIN);

  Object.assign(env, { ACCESS_TEAM: TEAM, ACCESS_AUD: AUD, OWNERS: OWNER });
  const res = await withAccess(async () => worker.fetch(apiRequest('board', { token: await mintToken({ email: OWNER }) }), env));
  const body = await res.json();
  assert.equal(body.ingest_failures.length, 1);
  assert.equal(body.ingest_failures[0].item_id, 'quo:CN-BAD');
  assert.equal(body.ingest_failures[0].failures, 3);
  assert.notEqual(body.ingest_failures[0].skipped_at, null);
});

test('Gmail: a thread that fails is recorded (visible) and cleared once it syncs', async () => {
  const env = makeEnv();
  const mailbox = {
    t1: { raw: { snippet: 'x', messages: [{ id: 'm', internalDate: String(T0 * 1000), labelIds: ['INBOX'] }] } },
  };
  await quiet(() => withGmail(mailbox, () => ingestGmail(env)));
  let [f] = await failures(env);
  assert.equal(f.source_id, GMAIL_SOURCE);
  assert.equal(f.item_id, 'gmail:t1');
  assert.equal(f.failures, 1);

  mailbox.t1 = [inbound(new Date(T0 * 1000).toISOString(), 'Dana <dana@example.com>')];
  await quiet(() => withGmail(mailbox, () => ingestGmail(env)));
  assert.deepEqual(await failures(env), []);
  assert.ok(await row(env, 't1'));
});
