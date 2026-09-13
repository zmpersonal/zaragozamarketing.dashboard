// prove/triage.mjs and prove/gmail.mjs authenticate with the service account
// named by GOOGLE_SERVICE_ACCOUNT_FILE (a path; the key never enters the repo),
// impersonating the mailbox, gmail.readonly only, and never print the key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVICE_ACCOUNT, SERVICE_ACCOUNT_JSON, PUBLIC_JWK, CLIENT_EMAIL, GMAIL_READONLY } from './helpers/google-sa.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const MAILBOX = 'support@inhousewellness.com';

function run(script, { keyFile, extraEnv = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'prove-google-'));
  const tokenLog = join(dir, 'tokens.log');
  if (keyFile === undefined) {
    keyFile = join(dir, 'key.json');
    writeFileSync(keyFile, SERVICE_ACCOUNT_JSON, { mode: 0o600 });
  }
  const env = { ...process.env, PROVE_SA_PUBLIC_JWK: JSON.stringify(PUBLIC_JWK), PROVE_TOKEN_LOG: tokenLog, ...extraEnv };
  if (keyFile === null) delete env.GOOGLE_SERVICE_ACCOUNT_FILE; else env.GOOGLE_SERVICE_ACCOUNT_FILE = keyFile;
  delete env.GOOGLE_CLIENT_ID; delete env.GOOGLE_CLIENT_SECRET; delete env.GOOGLE_REFRESH_TOKEN;
  const r = spawnSync(process.execPath, ['--import', './tests/helpers/google-preload.mjs', script, MAILBOX], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000, env,
  });
  let tokens = [];
  try { tokens = readFileSync(tokenLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch {}
  return { ...r, tokens };
}

const noSecrets = (r) => {
  const out = r.stdout + r.stderr;
  assert.doesNotMatch(out, /PRIVATE KEY|MII[A-Za-z0-9+/]{20}/, 'no key material printed');
  assert.ok(!out.includes(CLIENT_EMAIL), 'service-account email not printed');
  assert.ok(!out.includes(SERVICE_ACCOUNT.private_key_id), 'key id not printed');
};

test('prove/triage.mjs runs on service-account auth and prints both verdict lists', () => {
  const r = run('prove/triage.mjs');
  assert.equal(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.equal(r.tokens.length > 0, true, 'requested a token');
  assert.ok(r.tokens.every((t) => t.ok && t.claims.sub === MAILBOX && t.claims.scope === GMAIL_READONLY), JSON.stringify(r.tokens));
  assert.match(r.stdout, /KEPT[^\n]*\(2\)/);
  assert.match(r.stdout, /DEMOTED[^\n]*\(1\)/);
  assert.match(r.stdout, /dana@example\.com/);
  assert.match(r.stdout, /news@brand\.example.*list_unsubscribe/);
  assert.match(r.stdout, /priya@acme\.example.*exempt/);
  noSecrets(r);
});

test('prove/gmail.mjs runs on service-account auth', () => {
  const r = run('prove/gmail.mjs');
  assert.equal(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.ok(r.tokens.length > 0 && r.tokens.every((t) => t.ok && t.claims.sub === MAILBOX));
  assert.match(r.stdout, /WAITING/);
  noSecrets(r);
});

test('without GOOGLE_SERVICE_ACCOUNT_FILE, or with a missing file, both fail clearly and print no secrets', () => {
  for (const script of ['prove/triage.mjs', 'prove/gmail.mjs']) {
    for (const keyFile of [null, '/nonexistent/key.json']) {
      const r = run(script, { keyFile });
      assert.notEqual(r.status, 0, script);
      assert.match(r.stderr, /GOOGLE_SERVICE_ACCOUNT_FILE/, script);
      noSecrets(r);
    }
  }
});
