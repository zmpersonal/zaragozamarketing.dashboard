// /hooks/quo is public. It only trusts a body whose signature verifies under
// the scheme in Quo's current versioned docs (API 2026-03-30,
// www.quo.com/docs/2026-03-30/webhooks-overview), which is Standard Webhooks:
//   headers  webhook-id, webhook-timestamp (unix SECONDS), webhook-signature
//   signed   `${webhook-id}.${webhook-timestamp}.${raw body}`
//   secret   whsec_<base64>; HMAC key = base64-decoded bytes after the prefix
//   mac      HMAC-SHA256, header lists "v1,<base64>" entries, space-separated
//   replay   reject timestamps more than 5 minutes from our clock
// Anything else, including the legacy openphone-signature header, is a 401.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { makeD1 } from './helpers/d1.mjs';

// Includes bytes >= 0x80: the key must be used as raw bytes.
const KEY_BYTES = Uint8Array.from([0xff, 0x00, 0x80, 0x7f, 0x10, 0xc3, 0xa9, 0x42, 0x99, 0xfe, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
  0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]);
const SECRET = 'whsec_' + Buffer.from(KEY_BYTES).toString('base64');
const OTHER_SECRET = 'whsec_' + Buffer.from(KEY_BYTES.map((b) => b ^ 0x55)).toString('base64');

const BODY = JSON.stringify({ id: 'EV1', type: 'message.received', data: { resource: { id: 'AC1', direction: 'incoming', text: 'Is the chiller 220v?' }, context: { orgId: 'OR1' } } });
const nowSec = () => Math.floor(Date.now() / 1000);

async function mac(secret, content) {
  const raw = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(content))).toString('base64');
}

async function signed({ secret = SECRET, id = 'msg_2x9', ts = nowSec(), body = BODY } = {}) {
  return {
    'webhook-id': id,
    'webhook-timestamp': String(ts),
    'webhook-signature': `v1,${await mac(secret, `${id}.${ts}.${body}`)}`,
  };
}

// A database, since a verified delivery is now recorded (round 10). This BODY has no
// context, so it is acknowledged and ignored; tests/quo-webhook-ingest covers real events.
const DB = makeD1();
const env = (over = {}) => ({ QUO_WEBHOOK_SECRET: SECRET, DB, ...over });
const post = (headers, body = BODY) =>
  new Request('https://console.example/hooks/quo', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
const status = async (headers, { body = BODY, envOver } = {}) => (await worker.fetch(post(headers, body), env(envOver))).status;

// --- accepted ---------------------------------------------------------------

test('valid Standard Webhooks signature -> 200', async () => {
  assert.equal(await status(await signed()), 200);
});

test('secret configured without the whsec_ prefix also verifies', async () => {
  assert.equal(await status(await signed(), { envOver: { QUO_WEBHOOK_SECRET: SECRET.slice('whsec_'.length) } }), 200);
});

test('key rotation: any one matching v1 entry among several -> 200', async () => {
  const h = await signed();
  h['webhook-signature'] = `v1,${await mac(OTHER_SECRET, 'x')} ${h['webhook-signature']}`;
  assert.equal(await status(h), 200);
});

// --- rejected ---------------------------------------------------------------

test('signed with the wrong secret -> 401', async () => {
  assert.equal(await status(await signed({ secret: OTHER_SECRET })), 401);
});

test('any of the three headers missing -> 401', async () => {
  for (const name of ['webhook-id', 'webhook-timestamp', 'webhook-signature']) {
    const h = await signed();
    delete h[name];
    assert.equal(await status(h), 401, name);
  }
});

test('body tampered after signing -> 401', async () => {
  assert.equal(await status(await signed(), { body: BODY.replace('220v', '110v') }), 401);
});

test('body re-serialized (whitespace changed) -> 401: the signature covers the raw bytes', async () => {
  assert.equal(await status(await signed(), { body: JSON.stringify(JSON.parse(BODY), null, 2) }), 401);
});

test('webhook-id changed after signing -> 401', async () => {
  const h = await signed();
  h['webhook-id'] = 'msg_other';
  assert.equal(await status(h), 401);
});

test('webhook-timestamp changed after signing -> 401', async () => {
  const h = await signed();
  h['webhook-timestamp'] = String(Number(h['webhook-timestamp']) - 1);
  assert.equal(await status(h), 401);
});

test('correctly signed but 10 minutes old, or 10 minutes in the future -> 401', async () => {
  assert.equal(await status(await signed({ ts: nowSec() - 600 })), 401);
  assert.equal(await status(await signed({ ts: nowSec() + 600 })), 401);
});

test('timestamp in milliseconds (the legacy unit) -> 401', async () => {
  assert.equal(await status(await signed({ ts: Date.now() })), 401);
});

test('only non-v1 entries (e.g. asymmetric v1a) -> 401', async () => {
  const h = await signed();
  h['webhook-signature'] = h['webhook-signature'].replace(/^v1,/, 'v1a,');
  assert.equal(await status(h), 401);
});

test('legacy openphone-signature header, correctly signed the legacy way -> 401 (fail closed)', async () => {
  const ts = Date.now();
  const legacy = `hmac;1;${ts};${await mac(SECRET, `${ts}.${BODY}`)}`;
  assert.equal(await status({ 'openphone-signature': legacy }), 401);
  assert.equal(await status({ 'openphone-signature': legacy }, { envOver: { QUO_WEBHOOK_SECRET: SECRET.slice(6) } }), 401);
});

test('webhook secret not configured, or not base64 -> 401 (fail closed)', async () => {
  const h = await signed();
  assert.equal(await status(h, { envOver: { QUO_WEBHOOK_SECRET: undefined } }), 401);
  assert.equal(await status(h, { envOver: { QUO_WEBHOOK_SECRET: 'whsec_!!!not base64!!!' } }), 401);
});

test('a rejected delivery writes nothing: no thread, no delivery record', async () => {
  const before = DB.raw.prepare('SELECT COUNT(*) AS n FROM webhook_delivery').get().n;
  assert.equal(await status(await signed({ secret: OTHER_SECRET, id: 'msg_rejected' })), 401);
  assert.equal(await status(await signed({ ts: nowSec() - 600, id: 'msg_rejected' })), 401);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM webhook_delivery').get().n, before);
  assert.equal(DB.raw.prepare("SELECT COUNT(*) AS n FROM webhook_delivery WHERE webhook_id = 'msg_rejected'").get().n, 0);
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM thread').get().n, 0);
});
