// The D1 REST client: the same prepare/bind/first/all/run/batch surface as the
// Worker binding, over Cloudflare's D1 REST API, so ingest runs unchanged on
// GitHub Actions. Tested against a stubbed API, including errors and retries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D1HttpClient } from '../src/db/d1-http.ts';
import { makeD1Rest, ACCOUNT, DATABASE, TOKEN } from './helpers/d1-rest.mjs';

function client(api, opts = {}) {
  const sleeps = [];
  const c = new D1HttpClient({ accountId: ACCOUNT, databaseId: DATABASE, token: TOKEN, fetch: api.fetch, sleep: async (ms) => { sleeps.push(ms); }, ...opts });
  return { c, sleeps };
}
const seedSource = (c) => c.prepare(`INSERT INTO source (id, brand_id, channel, provider, address) VALUES (?1, 'inhouse', 'email', 'gmail', ?2)`).bind('gmail:a@example.com', 'a@example.com').run();

test('all, first and run go to the query endpoint with the bearer token and map results and changes', async () => {
  const api = makeD1Rest();
  const { c } = client(api);
  const r = await seedSource(c);
  assert.equal(r.meta.changes, 1);
  assert.deepEqual(api.requests[0].body, { sql: `INSERT INTO source (id, brand_id, channel, provider, address) VALUES (?1, 'inhouse', 'email', 'gmail', ?2)`, params: ['gmail:a@example.com', 'a@example.com'] });
  assert.equal(api.requests[0].auth, `Bearer ${TOKEN}`);
  const all = await c.prepare('SELECT id, address FROM source WHERE provider = ?1').bind('gmail').all();
  assert.deepEqual(all.results, [{ id: 'gmail:a@example.com', address: 'a@example.com' }]);
  assert.deepEqual(await c.prepare('SELECT address FROM source WHERE id = ?1').bind('gmail:a@example.com').first(), { address: 'a@example.com' });
  assert.equal(await c.prepare('SELECT address FROM source WHERE id = ?1').bind('nope').first(), null);
});

test('numbers and null keep their types (numbered ?NNN params, reused); undefined is refused like the binding', async () => {
  const api = makeD1Rest();
  const { c } = client(api);
  const row = await c.prepare("SELECT ?1 AS i, ?2 AS s, ?3 AS z, typeof(?1) IN ('integer','real') AS numeric, typeof(?2) AS ts, ?1 + 1 AS j").bind(7, 'x', null).first();
  assert.deepEqual(row, { i: 7, s: 'x', z: null, numeric: 1, ts: 'text', j: 8 });
  assert.throws(() => c.prepare('SELECT ?1').bind(undefined), /undefined/);
});

test('batch is ONE request and one transaction: a failing statement rolls back the others', async () => {
  const api = makeD1Rest();
  const { c } = client(api);
  await seedSource(c);
  const before = api.requests.length;
  await c.batch([
    c.prepare(`UPDATE source SET last_synced_at = ?1 WHERE id = ?2`).bind(5, 'gmail:a@example.com'),
    c.prepare(`UPDATE source SET sync_cursor = ?1 WHERE id = ?2`).bind('c', 'gmail:a@example.com'),
  ]);
  assert.equal(api.requests.length, before + 1);
  assert.equal(api.requests.at(-1).body.batch.length, 2);
  await assert.rejects(c.batch([
    c.prepare(`UPDATE source SET last_synced_at = 99 WHERE id = ?1`).bind('gmail:a@example.com'),
    c.prepare(`INSERT INTO nope VALUES (1)`),
  ]), /no such table/);
  assert.equal((await c.prepare('SELECT last_synced_at FROM source').first()).last_synced_at, 5, 'rolled back');
});

test('429 is retried, honouring Retry-After (capped), for reads and writes alike', async () => {
  const api = makeD1Rest();
  const { c, sleeps } = client(api);
  api.failures.push({ status: 429, retryAfter: '3' }, { status: 429, retryAfter: '9999' });
  const r = await seedSource(c);
  assert.equal(r.meta.changes, 1);
  assert.deepEqual(sleeps, [3000, 30000], 'Retry-After honoured, capped at 30 s');
  assert.equal(api.requests.length, 3);
});

test('a 5xx or network error on a read is retried with backoff', async () => {
  const api = makeD1Rest();
  const { c, sleeps } = client(api);
  api.failures.push({ status: 503 }, { network: true });
  assert.deepEqual((await c.prepare('SELECT 1 AS one').all()).results, [{ one: 1 }]);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps[1] > sleeps[0], 'backoff grows');
});

test('a 5xx or network error on a write is NOT retried: it may have been applied, so it fails instead', async () => {
  for (const failure of [{ status: 502 }, { network: true }]) {
    const api = makeD1Rest();
    const { c, sleeps } = client(api);
    api.failures.push(failure);
    await assert.rejects(seedSource(c), /D1 API/);
    assert.equal(api.requests.length, 1, JSON.stringify(failure));
    assert.deepEqual(sleeps, []);
  }
});

test('retries are bounded; the error names the status and never contains the token', async () => {
  const api = makeD1Rest();
  const { c } = client(api, { maxRetries: 3 });
  for (let i = 0; i < 10; i++) api.failures.push({ status: 503 });
  const err = await c.prepare('SELECT 1').all().catch((e) => e);
  assert.match(err.message, /503/);
  assert.equal(api.requests.length, 4, '1 try + 3 retries');
  assert.ok(!err.message.includes(TOKEN) && !String(err.stack).includes(TOKEN));
});

test('a 4xx (bad SQL, bad token) is not retried and reports Cloudflare\'s message without the token', async () => {
  const api = makeD1Rest();
  const { c } = client(api);
  const bad = await c.prepare('SELEKT 1').all().catch((e) => e);
  assert.match(bad.message, /400.*syntax error/i);
  assert.equal(api.requests.length, 1);
  const { c: wrong } = client(api, { token: 'wrong-token' });
  const unauth = await wrong.prepare('SELECT 1').all().catch((e) => e);
  assert.match(unauth.message, /401.*Authentication error/);
  assert.ok(!bad.message.includes(TOKEN) && !unauth.message.includes('wrong-token'));
});

test('selfCheck passes against a faithful API and fails loudly if params come back as strings', async () => {
  const ok = makeD1Rest();
  await client(ok).c.selfCheck();
  const lossy = makeD1Rest();
  lossy.stringifyParams = true;
  await assert.rejects(client(lossy).c.selfCheck(), /self-check/);
});

test('first() is the first row of a multi-row result, as with the binding', async () => {
  const { c } = client(makeD1Rest());
  assert.deepEqual(await c.prepare('SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3').first(), { n: 1 });
});

test('an HTTP 200 whose statement reports success: false is an error, not an empty result', async () => {
  const api = makeD1Rest();
  const { c } = client(api);
  api.failures.push({ statementFailed: true });
  await assert.rejects(c.prepare('SELECT 1').all(), /statement failed/);
});
