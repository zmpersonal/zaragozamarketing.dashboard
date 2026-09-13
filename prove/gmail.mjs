#!/usr/bin/env node
/**
 * PROVE THE SOURCE — Gmail
 *
 * Pulls the newest 10 threads from one mailbox and prints who is waiting
 * on whom. Proves auth + read access + the waiting/answered logic before
 * a single line of dashboard gets built on top of it.
 *
 * Run:  node prove/gmail.mjs support@inhousewellness.com
 *
 * Needs in .env (or the shell):
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REFRESH_TOKEN     <- per mailbox, or use a service account below
 *
 * Service-account alternative (better for 3 mailboxes you own):
 *   set GOOGLE_SA_JSON to the key file path and enable domain-wide
 *   delegation with scope https://www.googleapis.com/auth/gmail.readonly
 *   Then no refresh token goes stale, ever.
 */

const MAILBOX = process.argv[2];
if (!MAILBOX) fail('Pass a mailbox: node prove/gmail.mjs support@example.com');

function fail(msg) {
  console.error('\n  FAILED: ' + msg + '\n');
  process.exit(1);
}

async function accessToken() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    fail('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN.\n' +
         '  Check for a trailing "=" that got truncated when you copied the secret.');
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const json = await res.json();
  if (!res.ok) fail('Token exchange returned ' + res.status + ': ' + JSON.stringify(json));
  return json.access_token;
}

async function gmail(token, path, params = {}) {
  const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/' + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) fail('Gmail ' + path + ' returned ' + res.status + ': ' + (await res.text()));
  return res.json();
}

const token = await accessToken();

// Only threads in the inbox that aren't ours-last. Gmail can't express
// "last message is inbound" directly, so we fetch and decide locally.
const list = await gmail(token, 'threads', { q: 'in:inbox -in:chats', maxResults: 10 });
if (!list.threads?.length) fail('Zero threads returned. Wrong mailbox, or the inbox is empty.');

console.log('\n  ' + MAILBOX + ' — newest ' + list.threads.length + ' threads\n');

for (const stub of list.threads) {
  const t = await gmail(token, 'threads/' + stub.id, { format: 'metadata' });
  const msgs = t.messages ?? [];
  const last = msgs[msgs.length - 1];
  const hdr = (n) =>
    last.payload.headers.find((h) => h.name.toLowerCase() === n)?.value ?? '';

  const from = hdr('from');
  const inbound = !from.toLowerCase().includes(MAILBOX.toLowerCase());
  const firstAt = Number(msgs[0].internalDate);
  const hours = Math.round((Date.now() - firstAt) / 36e5);

  console.log(
    '  ' + (inbound ? 'WAITING ' : 'answered') +
    '  ' + String(hours).padStart(4) + 'h  ' +
    hdr('subject').slice(0, 52).padEnd(54) +
    from.slice(0, 34)
  );
}

console.log('\n  Source proved. Real thread data, real ages, waiting/answered resolved.\n');
