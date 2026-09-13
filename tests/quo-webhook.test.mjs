// /hooks/quo is public. It must only trust a body whose Quo signature verifies.
//
// Quo's scheme (support.quo.com/core-concepts/integrations/webhooks):
//   header  openphone-signature: hmac;1;<timestamp ms>;<base64 signature>
//   signed  timestamp + "." + payload (JSON with whitespace removed)
//   key     the webhook's signing secret, base64-decoded to raw bytes
//   mac     HMAC-SHA256, base64-encoded
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';

// Includes bytes >= 0x80 on purpose: the key must be used as raw bytes, not a UTF-8 string.
const KEY_BYTES = Uint8Array.from([0xff, 0x00, 0x80, 0x7f, 0x10, 0xc3, 0xa9, 0x42, 0x99, 0xfe, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
const SECRET = Buffer.from(KEY_BYTES).toString('base64');
const OTHER_SECRET = Buffer.from(KEY_BYTES.map((b) => b ^ 0x55)).toString('base64');

const EVENT = { id: 'EV1', object: 'event', type: 'message.received', data: { object: { id: 'AC1', direction: 'incoming', body: 'Is the chiller 220v?' } } };

async function sign(secret, timestamp, payload) {
  const key = await crypto.subtle.importKey('raw', Buffer.from(secret, 'base64'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${payload}`));
  return `hmac;1;${timestamp};${Buffer.from(mac).toString('base64')}`;
}

const env = (over = {}) => ({ QUO_WEBHOOK_SECRET: SECRET, ...over });

const post = (body, headers = {}) =>
  new Request('https://console.example/hooks/quo', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });

test('valid signature -> 200', async () => {
  const body = JSON.stringify(EVENT);
  const res = await worker.fetch(post(body, { 'openphone-signature': await sign(SECRET, Date.now(), body) }), env());
  assert.equal(res.status, 200);
});

test('valid signature over whitespace-stripped JSON, body sent pretty-printed -> 200', async () => {
  const ts = Date.now();
  const header = await sign(SECRET, ts, JSON.stringify(EVENT));
  const res = await worker.fetch(post(JSON.stringify(EVENT, null, 2), { 'openphone-signature': header }), env());
  assert.equal(res.status, 200);
});

test('signed with the wrong secret -> 401', async () => {
  const body = JSON.stringify(EVENT);
  const res = await worker.fetch(post(body, { 'openphone-signature': await sign(OTHER_SECRET, Date.now(), body) }), env());
  assert.equal(res.status, 401);
});

test('no signature header -> 401', async () => {
  const res = await worker.fetch(post(JSON.stringify(EVENT)), env());
  assert.equal(res.status, 401);
});

test('body tampered after signing -> 401', async () => {
  const header = await sign(SECRET, Date.now(), JSON.stringify(EVENT));
  const forged = JSON.stringify({ ...EVENT, type: 'call.completed' });
  const res = await worker.fetch(post(forged, { 'openphone-signature': header }), env());
  assert.equal(res.status, 401);
});

test('correctly signed but 10 minutes old (replay) -> 401', async () => {
  const body = JSON.stringify(EVENT);
  const ts = Date.now() - 10 * 60 * 1000;
  const res = await worker.fetch(post(body, { 'openphone-signature': await sign(SECRET, ts, body) }), env());
  assert.equal(res.status, 401);
});

test('timestamp in the header changed after signing -> 401', async () => {
  const body = JSON.stringify(EVENT);
  const ts = Date.now();
  const [, , , mac] = (await sign(SECRET, ts, body)).split(';');
  const res = await worker.fetch(post(body, { 'openphone-signature': `hmac;1;${ts + 1000};${mac}` }), env());
  assert.equal(res.status, 401);
});

test('malformed header -> 401', async () => {
  for (const header of ['garbage', 'hmac;1;notanumber;abc=', 'hmac;2;' + Date.now() + ';abc=', 'sha1;1;' + Date.now() + ';abc=']) {
    const res = await worker.fetch(post(JSON.stringify(EVENT), { 'openphone-signature': header }), env());
    assert.equal(res.status, 401, header);
  }
});

test('webhook secret not configured -> 401 (fail closed)', async () => {
  const body = JSON.stringify(EVENT);
  const res = await worker.fetch(
    post(body, { 'openphone-signature': await sign(SECRET, Date.now(), body) }),
    env({ QUO_WEBHOOK_SECRET: undefined }),
  );
  assert.equal(res.status, 401);
});
