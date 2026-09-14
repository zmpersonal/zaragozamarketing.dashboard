// POST routes accept only same-origin JSON (a cross-site form or fetch riding
// the Access cookie is refused before anything is read or written), unknown
// threads and to-dos are 404s rather than 500s, and an action's status and
// kind must be ones the console knows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { makeApiEnv, withAccess, mintToken, insertThread } from './helpers/access.mjs';

const ORIGIN = 'https://console.example';

async function post(env, path, { body = {}, headers = {}, raw } = {}) {
  const token = await mintToken();
  const req = new Request(`${ORIGIN}/api/${path}`, {
    method: 'POST',
    headers: { 'Cf-Access-Jwt-Assertion': token, 'content-type': 'application/json', origin: ORIGIN, ...headers },
    body: raw ?? JSON.stringify(body),
  });
  const res = await withAccess(() => worker.fetch(req, env));
  return { status: res.status, body: await res.json().catch(() => null) };
}
const rows = (env, table) => env.DB.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const ACTION = { thread_id: 'gmail:t1', kind: 'note', body: 'hi', status: 'waiting' };

function env() {
  const e = makeApiEnv();
  insertThread(e, { id: 'gmail:t1' });
  return e;
}

// --- content type and origin ------------------------------------------------------------

test('same-origin JSON is accepted', async () => {
  const e = env();
  assert.equal((await post(e, 'actions', { body: ACTION })).status, 200);
  assert.equal(rows(e, 'action'), 1);
});

test('a POST that is not application/json is refused with 415 and writes nothing', async () => {
  const e = env();
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', null]) {
    const headers = type === null ? { 'content-type': '' } : { 'content-type': type };
    const r = await post(e, 'actions', { body: ACTION, headers });
    assert.equal(r.status, 415, String(type));
  }
  assert.equal((await post(e, 'actions', { body: ACTION, headers: { 'content-type': 'application/json; charset=utf-8' } })).status, 200, 'a charset parameter is fine');
  assert.equal(rows(e, 'action'), 1);
});

test('a cross-site or origin-less POST is refused with 403 and writes nothing', async () => {
  const e = env();
  const cases = [
    { origin: 'https://evil.example' },
    { origin: 'https://console.example.evil.example' },
    { origin: 'http://console.example' },
    { origin: 'null' },
    { origin: '' },
    { 'sec-fetch-site': 'cross-site' },
  ];
  for (const headers of cases) {
    const r = await post(e, 'actions', { body: ACTION, headers });
    assert.equal(r.status, 403, JSON.stringify(headers));
  }
  for (const path of ['todos', 'todos/1/done', 'threads/gmail:t1/rescue']) {
    assert.equal((await post(e, path, { body: { title: 'x' }, headers: { origin: 'https://evil.example' } })).status, 403, path);
  }
  assert.equal(rows(e, 'action'), 0);
  assert.equal(rows(e, 'todo'), 0);
});

test('reads are not affected, and the Quo webhook is signature-checked, not origin-checked', async () => {
  const e = env();
  const token = await mintToken();
  const res = await withAccess(() => worker.fetch(new Request(`${ORIGIN}/api/queue`, { headers: { 'Cf-Access-Jwt-Assertion': token } }), e));
  assert.equal(res.status, 200);
  const hook = await worker.fetch(new Request(`${ORIGIN}/hooks/quo`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }), { ...e, QUO_WEBHOOK_SECRET: 'whsec_AAAA' });
  assert.equal(hook.status, 401, 'webhook rejects for its signature, not a 403/415');
});

// --- unknown ids -----------------------------------------------------------------------------

test('an action on an unknown thread is 404, not 500, and writes nothing', async () => {
  const e = env();
  const r = await post(e, 'actions', { body: { ...ACTION, thread_id: 'gmail:nope' } });
  assert.equal(r.status, 404);
  assert.equal(rows(e, 'action'), 0);
});

test('marking an unknown to-do done is 404; a to-do linked to an unknown thread is 404', async () => {
  const e = env();
  assert.equal((await post(e, 'todos/999/done')).status, 404);
  assert.equal((await post(e, 'todos', { body: { title: 'x', thread_id: 'gmail:nope' } })).status, 404);
  assert.equal(rows(e, 'todo'), 0);
});

test('GET threads/:id URL-decodes the id, and an unknown one is 404', async () => {
  const e = env();
  const token = await mintToken();
  const get = (path) => withAccess(() => worker.fetch(new Request(`${ORIGIN}/api/${path}`, { headers: { 'Cf-Access-Jwt-Assertion': token } }), e));
  assert.equal((await get('threads/gmail%3At1')).status, 200);
  assert.equal((await get('threads/gmail:nope')).status, 404);
});

// --- validation --------------------------------------------------------------------------------

test('an action with an unknown kind, status or blocked_on is 400 and writes nothing', async () => {
  const e = env();
  for (const bad of [{ kind: '<img src=x onerror=alert(1)>' }, { status: 'deleted' }, { status: 'blocked', blocked_on: 'nonsense' }, { kind: '' }]) {
    const r = await post(e, 'actions', { body: { ...ACTION, ...bad } });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal(rows(e, 'action'), 0);
});

test('a body that is not JSON is 400, not 500', async () => {
  const e = env();
  assert.equal((await post(e, 'actions', { raw: '{"thread_id":' })).status, 400);
  assert.equal((await post(e, 'todos', { raw: 'null' })).status, 400);
});
