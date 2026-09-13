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
 * Auth: a service account with domain-wide delegation (gmail.readonly),
 * impersonating the mailbox. GOOGLE_SERVICE_ACCOUNT_FILE = path to the key.
 */
import { gmailAccessToken } from './_google.mjs';

const MAILBOX = process.argv[2];
if (!MAILBOX) fail('Pass a mailbox: node prove/gmail.mjs support@example.com');

function fail(msg) {
  console.error('\n  FAILED: ' + msg + '\n');
  process.exit(1);
}

async function gmail(token, path, params = {}) {
  const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/' + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) fail('Gmail ' + path + ' returned ' + res.status + ': ' + (await res.text()));
  return res.json();
}

const token = await gmailAccessToken(MAILBOX, fail);

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
