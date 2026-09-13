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

test('prove/triage.mjs samples ALL received mail in the window and prints the requested shape', () => {
  const r = run('prove/triage.mjs');
  assert.equal(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.ok(r.tokens.length > 0 && r.tokens.every((t) => t.ok && t.claims.sub === MAILBOX && t.claims.scope === GMAIL_READONLY), JSON.stringify(r.tokens));

  const lines = r.stdout.split('\n');
  // Population first, so it can be sanity-checked before any verdict.
  assert.equal(lines.find((l) => l.startsWith('TOTAL:')), 'TOTAL: 6 messages, 3 kept, 3 demoted');
  assert.equal(lines.find((l) => l.startsWith('QUERY:')), 'QUERY: in:anywhere newer_than:30d -in:sent -in:drafts -in:chats');
  assert.ok(lines.indexOf(lines.find((l) => l.startsWith('TOTAL:'))) < lines.findIndex((l) => l.startsWith('DEMOTED')), 'TOTAL before the lists');

  const section = (title) => {
    const start = lines.findIndex((l) => l.startsWith(title));
    assert.ok(start >= 0, title);
    const out = [];
    for (const l of lines.slice(start + 1)) { if (!l.trim()) break; out.push(l); }
    return out;
  };
  const day = (msAgo) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(Date.now() - msAgo));
  const D = 86400_000;

  // Spam, trash and a filtered label are part of the stream; one line each: date | sender | subject | reasons.
  assert.deepEqual(section('DEMOTED'), [
    `${day(3 * D)} | news@brand.example | This week only | list_unsubscribe, gmail_promo`,
    `${day(4 * D)} | win@prize.example | You have won | gmail_spam`,
    `${day(5 * D)} | no-reply-calendar@google.com | Invitation: supplier call | noreply`,
  ]);
  // Archived mail counts; Priya is exempt because a reply to her is on the second page of sent mail.
  assert.deepEqual(section('KEPT'), [
    `${day(1 * D)} | dana@example.com | Sauna heater tripping the breaker`,
    `${day(2 * D)} | sam@example.com | Re: chiller warranty question and the 220v wiring `,
    `${day(6 * D)} | priya@acme.example | Invoice 2214`,
  ]);
  assert.doesNotMatch(r.stdout, /old@example\.com|support@inhousewellness\.com \||team@inhousewellness\.com/, 'outside the window, sent, drafts and chats are excluded');
  noSecrets(r);
});

test('prove/triage.mjs truncates subjects to 50 characters', () => {
  const r = run('prove/triage.mjs');
  const rows = r.stdout.split('\n').filter((x) => / \| /.test(x));
  assert.ok(rows.length >= 6, 'one row per message');
  assert.ok(rows.some((l) => l.includes('Re: chiller warranty question')), 'the long subject is present');
  for (const l of rows) {
    const subject = l.split(' | ')[2];
    assert.ok([...subject].length <= 50, l);
  }
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
