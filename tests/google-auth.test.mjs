// Gmail auth is a service account with domain-wide delegation: sign a JWT as
// the service account, impersonating the mailbox (sub), scope gmail.readonly
// only, and exchange it for an access token. No refresh tokens anywhere.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { serviceAccountToken, parseServiceAccount, clearTokenCache } from '../src/lib/google-auth.ts';
import { ingestGmail } from '../src/ingest/gmail.ts';
import { SERVICE_ACCOUNT, SERVICE_ACCOUNT_JSON, CLIENT_EMAIL, TOKEN_URI, GMAIL_READONLY, tokenResponse } from './helpers/google-sa.mjs';
import { makeEnv, withGmail, inbound, row, MAILBOX } from './helpers/gmail.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
beforeEach(() => clearTokenCache());

async function withTokenEndpoint(fn, respond = tokenResponse) {
  const real = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url ?? String(input);
    if (url !== TOKEN_URI) throw new Error('unexpected fetch: ' + url);
    assert.equal(init?.method, 'POST');
    return respond(String(init.body), requests);
  };
  try { return { result: await fn(), requests }; } finally { globalThis.fetch = real; }
}

test('signs an RS256 JWT as the service account, impersonating the mailbox, gmail.readonly only', async () => {
  const now = 1789480800;
  const { result, requests } = await withTokenEndpoint(() =>
    serviceAccountToken(SERVICE_ACCOUNT, MAILBOX, GMAIL_READONLY, now));

  assert.equal(result, `sa-token-for-${MAILBOX}`);
  assert.equal(requests.length, 1);
  const [{ ok, header, claims }] = requests;
  assert.equal(ok, true, 'signature verifies with the service account key');
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT', kid: 'test-key-id-1' });
  assert.deepEqual(claims, {
    iss: CLIENT_EMAIL, sub: MAILBOX, scope: GMAIL_READONLY, aud: TOKEN_URI, iat: now, exp: now + 3600,
  });
});

test('caches the token per subject until shortly before it expires', async () => {
  const now = 1789480800;
  const { requests } = await withTokenEndpoint(async () => {
    await serviceAccountToken(SERVICE_ACCOUNT, MAILBOX, GMAIL_READONLY, now);
    await serviceAccountToken(SERVICE_ACCOUNT, MAILBOX, GMAIL_READONLY, now + 1800);
    await serviceAccountToken(SERVICE_ACCOUNT, 'orders@inhousewellness.com', GMAIL_READONLY, now + 1800);
    await serviceAccountToken(SERVICE_ACCOUNT, MAILBOX, GMAIL_READONLY, now + 3590);
  });
  assert.deepEqual(requests.map((r) => [r.claims.sub, r.claims.iat]), [
    [MAILBOX, now], ['orders@inhousewellness.com', now + 1800], [MAILBOX, now + 3590],
  ]);
});

test('a refused exchange throws with Google\'s error, and never echoes the key or the assertion', async () => {
  const refuse = async () => new Response(JSON.stringify({ error: 'unauthorized_client', error_description: 'Client is unauthorized to retrieve access tokens using this method.' }), { status: 401 });
  await assert.rejects(
    withTokenEndpoint(() => serviceAccountToken(SERVICE_ACCOUNT, MAILBOX, GMAIL_READONLY, 1789480800), refuse),
    (err) => {
      assert.match(err.message, /401/);
      assert.match(err.message, /unauthorized_client/);
      assert.match(err.message, new RegExp(MAILBOX));
      assert.doesNotMatch(err.message, /PRIVATE KEY|eyJ/, 'no key material or JWT in the error');
      return true;
    },
  );
});

test('parseServiceAccount rejects anything that is not a service-account key, without echoing it', () => {
  for (const bad of ['', 'not json', '{"type":"authorized_user","refresh_token":"1//0secret"}',
    JSON.stringify({ ...SERVICE_ACCOUNT, private_key: 'nope' }),
    JSON.stringify({ ...SERVICE_ACCOUNT, type: 'authorized_user' })]) {
    assert.throws(() => parseServiceAccount(bad), (err) => {
      assert.doesNotMatch(err.message, /1\/\/0secret|nope|not json/);
      return true;
    }, bad.slice(0, 20));
  }
  assert.equal(parseServiceAccount(SERVICE_ACCOUNT_JSON).client_email, CLIENT_EMAIL);
});

test('Gmail ingest authenticates with the service account as the mailbox, never a refresh token', async () => {
  const env = makeEnv();
  const tokenCalls = [];
  const gmailAuth = [];
  await withGmail({ t1: [inbound('2026-09-15T09:00:00-05:00', 'Dana <dana@example.com>')] }, () => ingestGmail(env), {
    onToken: (v) => tokenCalls.push(v),
    onGmail: (headers) => gmailAuth.push(headers.get('authorization')),
  });

  assert.ok(await row(env, 't1'), 'mailbox synced');
  assert.equal(tokenCalls.length, 1);
  assert.equal(tokenCalls[0].ok, true);
  assert.equal(tokenCalls[0].claims.sub, MAILBOX);
  assert.equal(tokenCalls[0].claims.scope, GMAIL_READONLY);
  assert.ok(gmailAuth.length > 0 && gmailAuth.every((h) => h === `Bearer sa-token-for-${MAILBOX}`), gmailAuth.join());
  assert.equal('GOOGLE_REFRESH_TOKENS' in env, false);
});

test('a missing or broken GOOGLE_SERVICE_ACCOUNT_JSON skips Gmail with a clear log and no crash', async () => {
  for (const value of [undefined, '{"type":"authorized_user"}']) {
    const env = makeEnv();
    env.GOOGLE_SERVICE_ACCOUNT_JSON = value;
    const real = console.error; const logs = [];
    console.error = (...a) => logs.push(a.map(String).join(' '));
    try {
      await withGmail({ t1: [inbound('2026-09-15T09:00:00-05:00', 'Dana <dana@example.com>')] }, () => ingestGmail(env));
    } finally { console.error = real; }
    assert.equal(await row(env, 't1'), null);
    assert.ok(logs.some((l) => l.includes('GOOGLE_SERVICE_ACCOUNT_JSON')), logs.join('\n'));
  }
});

test('secret hygiene: no tracked file holds a private key or service-account JSON; key files are gitignored', () => {
  // Real key material: a PEM header followed by a base64 body, or service-account JSON.
  // (Code that builds or strips a PEM header is fine; a key is not.)
  const KEY_MATERIAL = /-----BEGIN (RSA )?PRIVATE KEY-----\s*[A-Za-z0-9+/]{64}/;
  const SA_JSON = /"type"\s*:\s*"service_account"/;
  assert.match(SERVICE_ACCOUNT.private_key, KEY_MATERIAL, 'detector recognises a real PEM key');
  assert.match(SERVICE_ACCOUNT_JSON, SA_JSON, 'detector recognises service-account JSON');

  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  const offenders = tracked.filter((f) => {
    let text;
    try { text = readFileSync(ROOT + f, 'utf8'); } catch { return false; }
    return KEY_MATERIAL.test(text) || SA_JSON.test(text);
  });
  assert.deepEqual(offenders, []);

  const ignored = execFileSync('git', ['check-ignore', '--no-index', 'secrets/inhouse-ops-3bd30d8e136e.json', 'inhouse-ops-3bd30d8e136e.json', '.dev.vars'], { cwd: ROOT, encoding: 'utf8' });
  assert.deepEqual(ignored.trim().split('\n'), ['secrets/inhouse-ops-3bd30d8e136e.json', 'inhouse-ops-3bd30d8e136e.json', '.dev.vars']);
});
