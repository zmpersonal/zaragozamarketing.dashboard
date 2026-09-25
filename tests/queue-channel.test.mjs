// Email and phone have to be readable apart (round 15). 52 phone threads buried
// a two-a-day email queue, and a client-side filter over a 50-row page would
// have shown an empty Email list while 40 email threads sat on page 2. So
// channel and brand are filters the database applies, and the totals the UI
// prints are the totals of what it is showing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { makeApiEnv, withAccess, mintToken, insertThread, OWNER } from './helpers/access.mjs';

const NOW = 1789480800;
const H = 3600;

function seed(env) {
  const add = (hoursAgo, over) => insertThread(env, { awaiting_since: NOW - hoursAgo * H, started: NOW - hoursAgo * H, ...over });
  // The phone threads are the oldest, as they were on the live line: 10 days of
  // missed calls sort to the top and fill the page.
  for (let i = 0; i < 60; i++) add(100 + i, { channel: 'phone', id: `quo:p${i}` });
  for (let i = 0; i < 12; i++) add(1 + i, { channel: 'email', id: `gmail:e${i}` });
  for (let i = 0; i < 5; i++) add(90 + i, { channel: 'phone', id: `quo:cal${i}`, brand_id: 'caliza' });
  for (let i = 0; i < 4; i++) add(80 + i, { channel: 'phone', id: `quo:b${i}`, triage: 'bulk' });
  for (let i = 0; i < 7; i++) add(70 + i, { channel: 'phone', id: `quo:s${i}`, triage: 'spam' });
}

async function get(env, query = '', email = OWNER) {
  const token = await mintToken({ email });
  const res = await withAccess(() => worker.fetch(new Request(`https://console.example/api/queue${query}`, { headers: { 'Cf-Access-Jwt-Assertion': token } }), env));
  return { status: res.status, body: await res.json() };
}

test('the email queue is not on page 2 of the phone queue', async () => {
  const env = makeApiEnv();
  seed(env);
  const all = await get(env, '?tier=customer');
  assert.equal(all.body.total, 77, 'everything open and not demoted');
  assert.equal(all.body.threads.filter((t) => t.channel === 'email').length, 0, 'the 50-row page is all phone: this was the bug');

  const email = await get(env, '?tier=customer&channel=email');
  assert.equal(email.body.total, 12);
  assert.equal(email.body.threads.length, 12);
  assert.ok(email.body.threads.every((t) => t.channel === 'email'));
});

test('the totals are the totals of what is shown, per tier', async () => {
  const env = makeApiEnv();
  seed(env);
  const phone = await get(env, '?tier=customer&channel=phone');
  assert.equal(phone.body.total, 65, '60 inhouse + 5 caliza');
  for (const [tier, total] of [['bulk', 4], ['spam', 7]]) {
    const r = await get(env, `?tier=${tier}&channel=phone`);
    assert.equal(r.body.total, total, tier);
    const none = await get(env, `?tier=${tier}&channel=email`);
    assert.equal(none.body.total, 0, `${tier} email`);
  }
});

test('channel composes with brand', async () => {
  const env = makeApiEnv();
  seed(env);
  const r = await get(env, '?tier=customer&channel=phone&brand=caliza');
  assert.equal(r.body.total, 5);
  assert.ok(r.body.threads.every((t) => t.brand_id === 'caliza' && t.channel === 'phone'));
  const email = await get(env, '?tier=customer&channel=email&brand=caliza');
  assert.equal(email.body.total, 0);
});

test('paging inside a filter is still per tier and still exact', async () => {
  const env = makeApiEnv();
  seed(env);
  const first = await get(env, '?tier=customer&channel=phone');
  const second = await get(env, '?tier=customer&channel=phone&offset=50');
  assert.equal(first.body.threads.length, 50);
  assert.equal(second.body.threads.length, 15);
  assert.equal(second.body.total, 65);
  const ids = new Set([...first.body.threads, ...second.body.threads].map((t) => t.id));
  assert.equal(ids.size, 65, 'no repeats, no gaps');
});

test('the single-call queue takes the filters too, so the first paint is filtered', async () => {
  const env = makeApiEnv();
  seed(env);
  const r = await get(env, '?channel=email');
  assert.equal(r.body.tiers.customer.total, 12);
  assert.ok(r.body.threads.every((t) => t.channel === 'email'));
});

test('an unknown channel or a silly brand is a 400, never a silently empty queue', async () => {
  const env = makeApiEnv();
  seed(env);
  for (const q of ['?channel=fax', '?channel=', '?tier=customer&channel=EMAIL', `?brand=${'x'.repeat(65)}`]) {
    assert.equal((await get(env, q)).status, 400, q);
  }
  assert.equal((await get(env, '?channel=chat')).status, 200, 'chat is a real channel, just not in the nav yet');
});

test('an agent still only sees their own and unassigned, filter or no filter', async () => {
  const env = makeApiEnv();
  insertThread(env, { id: 'gmail:mine', channel: 'email', assignee: 'dana.agent@inhousewellness.com' });
  insertThread(env, { id: 'gmail:theirs', channel: 'email', assignee: 'someone@else.com' });
  const r = await get(env, '?tier=customer&channel=email', 'dana.agent@inhousewellness.com');
  assert.deepEqual(r.body.threads.map((t) => t.id), ['gmail:mine']);
  assert.equal(r.body.total, 1);
});
