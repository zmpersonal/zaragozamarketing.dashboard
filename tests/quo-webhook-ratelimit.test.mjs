// /hooks/quo is public and unauthenticated by design, and verifying a signature
// means reading the whole body and running an HMAC over it. Without a limit,
// anyone can make us do that as often as they like, and on a paid plan that is
// billed rather than capped. Cloudflare's WAF can't help: rate-limiting rules
// run on zones and workers.dev is not in one (round 12), so the limit runs
// inside the Worker, through the rate-limiting binding.
//
// It is a cost guard, not a security control: permissive, eventually consistent
// and counted per Cloudflare location. The signature is still the trust boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/hooks.ts';
import { makeD1 } from './helpers/d1.mjs';
import { WEBHOOK_SECRET } from './helpers/quo-webhook.mjs';
import { RATE_LIMIT_PERIOD_SECONDS } from '../src/webhook.ts';

const nowSec = () => Math.floor(Date.now() / 1000);
const BODY = JSON.stringify({ id: 'EV1', type: 'message.received', data: { resource: { id: 'AC1', direction: 'incoming', text: 'hello' }, context: { orgId: 'OR1' } } });

async function mac(content) {
  const raw = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(content))).toString('base64');
}

/** A request that records when its body is read, into the shared `events` array. */
async function request({ events = [], sign = true, ip = '203.0.113.7', method = 'POST', path = '/hooks/quo' } = {}) {
  const id = `msg_${Math.random().toString(36).slice(2)}`;
  const ts = String(nowSec());
  const headers = { 'content-type': 'application/json' };
  if (ip) headers['cf-connecting-ip'] = ip;
  if (method === 'POST') {
    headers['webhook-id'] = id;
    headers['webhook-timestamp'] = ts;
    headers['webhook-signature'] = sign ? `v1,${await mac(`${id}.${ts}.${BODY}`)}` : 'v1,bm90LWEtc2lnbmF0dXJl';
  }
  const req = new Request(`https://inhouse-ops-hooks.example.workers.dev${path}`, { method, headers, body: method === 'POST' ? BODY : undefined });
  const text = req.text.bind(req);
  req.text = async () => { events.push('read body'); return text(); };
  return { req, events };
}

/** The binding: env.HOOK_RATE_LIMIT.limit({ key }) -> { success }. */
function limiter(success, events = []) {
  const keys = [];
  return { keys, limit: async ({ key }) => { events.push('rate limit'); keys.push(key); return { success }; } };
}

const REFUSING_DB = { prepare: () => { throw new Error('the database was touched'); }, batch: () => { throw new Error('the database was touched'); } };

test('under the limit, a signed delivery is still verified and ingested', async () => {
  const rl = limiter(true);
  const { req } = await request();
  const res = await worker.fetch(req, { QUO_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: makeD1(), HOOK_RATE_LIMIT: rl });
  assert.equal(res.status, 200);
  assert.deepEqual(rl.keys, ['203.0.113.7'], 'keyed by the client IP');
});

test('under the limit, a bad signature is still a 401: the limit is not the trust boundary', async () => {
  const { req } = await request({ sign: false });
  const res = await worker.fetch(req, { QUO_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: REFUSING_DB, HOOK_RATE_LIMIT: limiter(true) });
  assert.equal(res.status, 401);
});

test('over the limit: 429, the body is never read, and the database is never touched', async () => {
  const events = [];
  const { req } = await request({ events });
  const res = await worker.fetch(req, { QUO_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: REFUSING_DB, HOOK_RATE_LIMIT: limiter(false, events) });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '10');
  assert.deepEqual(events, ['rate limit'], 'the expensive work (body read, HMAC) never happened');
});

test('the limit is checked before the body is read', async () => {
  const events = [];
  const { req } = await request({ events });
  await worker.fetch(req, { QUO_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: makeD1(), HOOK_RATE_LIMIT: limiter(true, events) });
  assert.deepEqual(events, ['rate limit', 'read body']);
});

test('path and method are checked before the limit, so junk traffic costs no quota', async () => {
  for (const [over, expected] of [[{ method: 'GET' }, 405], [{ path: '/' }, 404], [{ path: '/hooks/other' }, 404]]) {
    const rl = limiter(true);
    const { req } = await request(over);
    const res = await worker.fetch(req, { QUO_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: REFUSING_DB, HOOK_RATE_LIMIT: rl });
    assert.equal(res.status, expected, JSON.stringify(over));
    assert.deepEqual(rl.keys, [], JSON.stringify(over));
  }
});

test('a request with no client IP still gets counted, under one shared key', async () => {
  const rl = limiter(true);
  const { req } = await request({ ip: null });
  await worker.fetch(req, { QUO_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: makeD1(), HOOK_RATE_LIMIT: rl });
  assert.equal(rl.keys.length, 1);
  assert.equal(typeof rl.keys[0], 'string');
  assert.ok(rl.keys[0].length > 0);
});

test('no binding configured: deliveries still pass. A cost guard must not become an outage', async () => {
  const { req } = await request();
  const res = await worker.fetch(req, { QUO_WEBHOOK_SECRET: WEBHOOK_SECRET, DB: makeD1() });
  assert.equal(res.status, 200);
});

test('the binding is configured on the hooks Worker only, with a period the API allows', async () => {
  const { readFileSync } = await import('node:fs');
  const hooks = readFileSync(new URL('../wrangler.hooks.toml', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.match(hooks, /\[\[ratelimits\]\]/);
  assert.match(hooks, /name\s*=\s*"HOOK_RATE_LIMIT"/, "this wrangler wants name, not binding: npm run build is what caught it");
  assert.match(hooks, /namespace_id\s*=\s*"\d+"/);
  const simple = hooks.match(/simple\s*=\s*\{([^}]+)\}/)?.[1];
  assert.ok(simple, 'simple = { limit, period }');
  const period = Number(simple.match(/period\s*=\s*(\d+)/)?.[1]);
  const limit = Number(simple.match(/limit\s*=\s*(\d+)/)?.[1]);
  assert.ok([10, 60].includes(period), `period must be 10 or 60, got ${period}`);
  assert.equal(period, RATE_LIMIT_PERIOD_SECONDS, 'Retry-After promises the configured period');
  // Quo sends a few events a minute; the limit has to be far above that and still cap abuse.
  assert.ok(limit / period >= 5 && limit / period <= 20, `${limit} per ${period}s is ${limit / period}/s`);
  assert.doesNotMatch(main, /\[\[ratelimits\]\]/, 'the console Worker is behind Access; it needs no limiter');
});
