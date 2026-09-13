// Authenticated routes: identity comes only from a Cloudflare Access JWT whose
// signature, expiry and audience all verify. Role is owner iff the email is in OWNERS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import {
  makeApiEnv, withAccess, mintToken, expiredAt, apiRequest, insertThread,
  AUD, OWNER, strangerKeys,
} from './helpers/access.mjs';

const call = (env, req) => withAccess(() => worker.fetch(req, env));

test('helper sanity: null really omits exp and email from the token', async () => {
  const claims = async (opts) => JSON.parse(Buffer.from((await mintToken(opts)).split('.')[1], 'base64url'));
  assert.equal('exp' in (await claims({ exp: null })), false);
  assert.equal('email' in (await claims({ email: null })), false);
  assert.equal(typeof (await claims({})).exp, 'number');
});

// --- rejections -------------------------------------------------------------

test('no token -> 401', async () => {
  const res = await call(makeApiEnv(), apiRequest('board'));
  assert.equal(res.status, 401);
});

test('expired token -> 401', async () => {
  const res = await call(makeApiEnv(), apiRequest('board', { token: await mintToken({ exp: expiredAt() }) }));
  assert.equal(res.status, 401);
});

test('token with no exp claim -> 401', async () => {
  const res = await call(makeApiEnv(), apiRequest('board', { token: await mintToken({ exp: null }) }));
  assert.equal(res.status, 401);
});

test('wrong audience -> 401', async () => {
  const res = await call(makeApiEnv(), apiRequest('board', { token: await mintToken({ aud: ['some-other-app'] }) }));
  assert.equal(res.status, 401);
});

test('audience given as a string that merely contains ours -> 401', async () => {
  const res = await call(makeApiEnv(), apiRequest('board', { token: await mintToken({ aud: `x-${AUD}-y` }) }));
  assert.equal(res.status, 401);
});

test('signed by a key Access did not publish -> 401', async () => {
  const res = await call(makeApiEnv(), apiRequest('board', { token: await mintToken({ key: strangerKeys.privateKey }) }));
  assert.equal(res.status, 401);
});

test('malformed token -> 401, not a server error', async () => {
  for (const token of ['not-a-jwt', 'a.b.c', '!!!.@@@.###']) {
    const res = await call(makeApiEnv(), apiRequest('board', { token }));
    assert.equal(res.status, 401, token);
  }
});

test('validly signed token with no email claim -> 401', async () => {
  const res = await call(makeApiEnv(), apiRequest('board', { token: await mintToken({ email: null }) }));
  assert.equal(res.status, 401);
});

// --- identity ---------------------------------------------------------------

test('valid token resolves to the token email, lowercased, as an agent', async () => {
  const res = await call(makeApiEnv(), apiRequest('board', { token: await mintToken({ email: 'Dana.Agent@InHouseWellness.com' }) }));
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).user, { email: 'dana.agent@inhousewellness.com', role: 'agent' });
});

test('valid token in the CF_Authorization cookie also works', async () => {
  const res = await call(makeApiEnv(), apiRequest('board', { cookie: await mintToken() }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).user.email, 'dana.agent@inhousewellness.com');
});

// --- role split -------------------------------------------------------------

test('an email listed in OWNERS (any case, any position) is an owner', async () => {
  const res = await call(makeApiEnv(), apiRequest('board', { token: await mintToken({ email: OWNER.toLowerCase() }) }));
  assert.deepEqual((await res.json()).user, { email: OWNER.toLowerCase(), role: 'owner' });
});

test('agent queue: own + unassigned only; owner queue: everything', async () => {
  const env = makeApiEnv();
  insertThread(env, { id: 'gmail:mine', assignee: 'dana.agent@inhousewellness.com' });
  insertThread(env, { id: 'gmail:unassigned' });
  insertThread(env, { id: 'gmail:theirs', assignee: 'sam.agent@inhousewellness.com' });
  const ids = async (res) => (await res.json()).threads.map((t) => t.id).sort();

  const agent = await call(env, apiRequest('queue', { token: await mintToken() }));
  assert.deepEqual(await ids(agent), ['gmail:mine', 'gmail:unassigned']);

  const owner = await call(env, apiRequest('queue', { token: await mintToken({ email: OWNER }) }));
  assert.deepEqual(await ids(owner), ['gmail:mine', 'gmail:theirs', 'gmail:unassigned']);
});
