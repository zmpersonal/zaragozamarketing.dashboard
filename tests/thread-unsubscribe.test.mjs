// The thread detail carries what the agent can act on (round 15): the parsed
// List-Unsubscribe, and a deep link into Gmail or Quo. Parsed on read, so the
// rules can change without re-ingesting, and nothing but http(s) and mailto
// survives the parse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { makeApiEnv, withAccess, mintToken, apiRequest, insertThread, OWNER } from './helpers/access.mjs';

async function detail(env, id) {
  const token = await mintToken({ email: OWNER });
  const res = await withAccess(() => worker.fetch(apiRequest(`threads/${encodeURIComponent(id)}`, { token }), env));
  return { status: res.status, body: await res.json() };
}

test('a bulk thread carries the link its sender offered, and says whether one-click exists', async () => {
  const env = makeApiEnv();
  insertThread(env, { id: 'gmail:b1', triage: 'bulk', unsubscribe: JSON.stringify({ h: '<mailto:u@example.com>, <https://example.com/u/abc>', post: 'List-Unsubscribe=One-Click' }) });
  const { body } = await detail(env, 'gmail:b1');
  assert.deepEqual(body.unsubscribe, { url: 'https://example.com/u/abc', mailto: 'mailto:u@example.com', one_click: true });
});

test('a thread with no header says so, rather than saying nothing', async () => {
  const env = makeApiEnv();
  insertThread(env, { id: 'gmail:t1' });
  assert.equal((await detail(env, 'gmail:t1')).body.unsubscribe, null);
});

test('a hostile header yields no link at all', async () => {
  const env = makeApiEnv();
  insertThread(env, { id: 'gmail:x', unsubscribe: JSON.stringify({ h: '<javascript:alert(1)>' }) });
  const { body } = await detail(env, 'gmail:x');
  assert.deepEqual(body.unsubscribe, { url: null, mailto: null, one_click: false });
});

test('stored nonsense is not a 500', async () => {
  const env = makeApiEnv();
  insertThread(env, { id: 'gmail:y', unsubscribe: 'not json' });
  const r = await detail(env, 'gmail:y');
  assert.equal(r.status, 200);
  assert.equal(r.body.unsubscribe, null);
});

test('the thread carries a deep link into the provider it came from', async () => {
  const env = makeApiEnv();
  insertThread(env, { id: 'gmail:18f2c1a9b' });
  insertThread(env, { id: 'quo:CN9', channel: 'phone' });
  assert.equal((await detail(env, 'gmail:18f2c1a9b')).body.link, 'https://mail.google.com/mail/u/support@inhousewellness.com/#all/18f2c1a9b');
  assert.equal((await detail(env, 'quo:CN9')).body.link, 'https://my.quo.com/inbox/PN1/c/CN9');
});
