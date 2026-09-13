#!/usr/bin/env node
/**
 * OAUTH BOOTSTRAP — get a Gmail refresh token for ONE mailbox
 *
 * Runs Google's installed-app ("Desktop app") OAuth flow on this machine:
 * a throwaway loopback server on 127.0.0.1 catches the redirect, the code is
 * exchanged with PKCE, and the refresh token is printed once. Scope is
 * gmail.readonly and nothing else — this console never sends or edits mail.
 *
 * Run:  node prove/oauth-bootstrap.mjs
 *       node prove/oauth-bootstrap.mjs support@inhousewellness.com   (checks you signed in as that mailbox)
 *
 * Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET from a Google Cloud OAuth
 * client of type "Desktop app", either in the shell or in .dev.vars (gitignored).
 *
 * The refresh token is a long-lived credential for that mailbox. It is
 * printed to this terminal only. Do not paste it into chat, a commit, or a
 * file that is not gitignored.
 */

import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TIMEOUT_MS = 5 * 60 * 1000;
const EXPECTED = process.argv[2]?.toLowerCase();

const step = (n, text) => console.log(`\n  [${n}] ${text}`);
const note = (text) => console.log('      ' + text);

function fail(msg) {
  console.error('\n  FAILED: ' + msg + '\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
step(1, 'Loading the OAuth client credentials');
if (existsSync('.dev.vars') && !(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)) {
  process.loadEnvFile('.dev.vars');
  note('Read .dev.vars (values already in the shell take precedence).');
}
const { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET } = process.env;
if (!CLIENT_ID || !CLIENT_SECRET) {
  fail('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.\n' +
       '  Create them in Google Cloud Console -> APIs & Services -> Credentials ->\n' +
       '  Create credentials -> OAuth client ID -> Application type "Desktop app".\n' +
       '  Put both in .dev.vars (gitignored) or export them in this shell.\n' +
       '  Check for a trailing "=" or whitespace lost when copying.');
}
if (!CLIENT_ID.endsWith('.apps.googleusercontent.com')) {
  fail('GOOGLE_CLIENT_ID does not end in .apps.googleusercontent.com — wrong value copied?');
}
note('Client ID: ' + CLIENT_ID.slice(0, 12) + '…  (secret loaded, not printed)');

// ---------------------------------------------------------------------------
step(2, 'Starting a one-shot listener on 127.0.0.1 to catch Google\'s redirect');
// PKCE: a random verifier stays on this machine; Google only ever sees its
// hash, so an intercepted code is useless without it. `state` ties the
// redirect back to this exact run.
const verifier = randomBytes(48).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(16).toString('base64url');

let finish;
const codePromise = new Promise((resolve, reject) => { finish = { resolve, reject }; });

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/') { res.writeHead(404).end(); return; }

  const reply = (status, text) => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(text + '\n\nYou can close this tab and return to the terminal.');
  };

  if (url.searchParams.get('state') !== state) {
    reply(400, 'State mismatch — this redirect is not from the current run. Ignored.');
    return;
  }
  const error = url.searchParams.get('error');
  if (error) {
    reply(400, 'Google returned an error: ' + error);
    finish.reject(new Error('Consent was not granted: ' + error));
    return;
  }
  const code = url.searchParams.get('code');
  if (!code) { reply(400, 'No authorization code in the redirect.'); return; }

  reply(200, 'Authorization received.');
  finish.resolve(code);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const redirectUri = `http://127.0.0.1:${server.address().port}`;
note('Listening at ' + redirectUri + ' (Desktop-app clients accept any loopback port).');

// ---------------------------------------------------------------------------
step(3, 'Open this URL in a browser and sign in as the mailbox you want to connect');
const auth = new URL(AUTH_URL);
auth.search = new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: SCOPE,
  // offline + consent is what makes Google issue a refresh token. Without
  // prompt=consent a mailbox that authorized before gets no refresh token.
  access_type: 'offline',
  prompt: 'consent',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state,
  ...(EXPECTED ? { login_hint: EXPECTED } : {}),
}).toString();

console.log('\n      ' + auth.toString() + '\n');
note('Google will show the permission "Read your email messages and settings".');
note('That is gmail.readonly. If it asks for anything more, stop — the client is misconfigured.');
note('Waiting up to 5 minutes…');

const timer = setTimeout(() => finish.reject(new Error('Timed out waiting for the browser redirect.')), TIMEOUT_MS);
let code;
try {
  code = await codePromise;
} catch (err) {
  fail(err.message);
} finally {
  clearTimeout(timer);
  server.close();
}

// ---------------------------------------------------------------------------
step(4, 'Exchanging the one-time code for tokens');
const tokenRes = await fetch(TOKEN_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  }),
});
const tokens = await tokenRes.json();
if (!tokenRes.ok) fail('Token exchange returned ' + tokenRes.status + ': ' + JSON.stringify(tokens));
if (!tokens.refresh_token) {
  fail('Google returned no refresh_token. Remove this app at https://myaccount.google.com/permissions\n' +
       '  for that account and run again.');
}
const granted = String(tokens.scope ?? '').split(' ');
if (granted.length !== 1 || granted[0] !== SCOPE) {
  fail('Granted scopes are not exactly gmail.readonly: ' + tokens.scope + '\n' +
       '  Refusing to print a token broader than this console needs.');
}
note('Got an access token and a refresh token. Scope confirmed: gmail.readonly only.');

// ---------------------------------------------------------------------------
step(5, 'Confirming which mailbox this token actually reads');
const profileRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
  headers: { Authorization: 'Bearer ' + tokens.access_token },
});
const profile = await profileRes.json();
if (!profileRes.ok) fail('Gmail profile returned ' + profileRes.status + ': ' + JSON.stringify(profile));
const mailbox = String(profile.emailAddress).toLowerCase();
note('Token reads: ' + mailbox + '  (' + profile.messagesTotal + ' messages)');
if (EXPECTED && mailbox !== EXPECTED) {
  fail(`You signed in as ${mailbox}, not ${EXPECTED}. Nothing to store — run again and pick the right account.`);
}

// ---------------------------------------------------------------------------
step(6, 'Refresh token — store it, then clear this terminal');
console.log('\n      ' + tokens.refresh_token + '\n');
note('For the prove scripts, in .dev.vars (gitignored):');
note('  GOOGLE_REFRESH_TOKEN=<the token above>');
note('For the Worker, all mailboxes live in one JSON secret, keyed by address:');
note(`  npx wrangler secret put GOOGLE_REFRESH_TOKENS   ->  {"${mailbox}":"<token>", ...}`);
note('');
note('Watch out: if the OAuth consent screen is External and in "Testing" status,');
note('Google expires this refresh token after 7 days. For a Workspace mailbox, set');
note('the consent screen to Internal so the token stays valid.');
console.log('');
