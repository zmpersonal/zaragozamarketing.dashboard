#!/usr/bin/env node
/**
 * ONE-OFF: SEED known_sender FROM SENT MAIL
 *
 * Reads every message the mailbox has sent, as far back as Gmail keeps it
 * (no date bound; --max caps the scan), and writes each To/Cc/Bcc recipient
 * as a known_sender row with replied_at = the first time we wrote to them.
 * Ingest treats those senders as customers, so someone we answered years
 * ago is never demoted when they write again.
 *
 * Not in cron. Run by hand once per mailbox:
 *   node prove/backfill-known-senders.mjs support@inhousewellness.com \
 *     --out ~/Code/secrets/inhouse-ops-known-senders.sql [--max 50000]
 *
 * The output file is customer contact data. It is written owner-only (600)
 * and must be OUTSIDE the repo; this script refuses a path inside it. Only
 * counts are printed. A human applies it:
 *   wrangler d1 execute inhouse-ops --file=<out> --remote
 * Applying it twice, or over rows ingest already wrote, is safe.
 *
 * Auth: GOOGLE_SERVICE_ACCOUNT_FILE (service account, domain-wide
 * delegation, gmail.readonly, impersonating the mailbox).
 */
import { writeFileSync, chmodSync, realpathSync, existsSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { gmailAccessToken } from './_google.mjs';

const args = process.argv.slice(2);
const MAILBOX = args[0]?.startsWith('--') ? undefined : args[0];
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const OUT = flag('--out');
const MAX = Number(flag('--max')) || 50_000;
const QUERY = 'in:sent';

function fail(msg) {
  console.error('\n  FAILED: ' + msg + '\n');
  process.exit(1);
}

if (!MAILBOX) fail('Pass a mailbox: node prove/backfill-known-senders.mjs support@inhousewellness.com --out <file outside the repo>');
if (!OUT) fail('Pass --out <file>: a path outside the repo (the file holds customer addresses).');

const repo = realpathSync(new URL('..', import.meta.url).pathname);
const outPath = resolve(OUT);
const outDir = existsSync(dirname(outPath)) ? realpathSync(dirname(outPath)) : dirname(outPath);
const rel = relative(repo, outDir);
if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) fail('--out must be outside the repo; customer addresses never go in it.');

const token = await gmailAccessToken(MAILBOX, fail);
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me/';

async function gm(path, params = {}) {
  const url = new URL(GMAIL + path);
  for (const [k, v] of Object.entries(params)) for (const item of [].concat(v)) url.searchParams.append(k, item);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (res.ok) return res.json();
    // Rate limits and transient errors: back off and retry. Other errors stop the run.
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    fail('Gmail ' + path + ' -> ' + res.status);
  }
}

// Every sent message id, newest first, up to MAX.
const ids = [];
let pageToken;
let capped = false;
do {
  const page = await gm('messages', { q: QUERY, maxResults: 500, ...(pageToken ? { pageToken } : {}) });
  for (const m of page.messages ?? []) {
    if (ids.length === MAX) { capped = true; break; }
    ids.push(m.id);
  }
  pageToken = page.nextPageToken;
} while (pageToken && !capped);

async function mapLimit(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

// Addresses only. Display names can hold commas ("Ortiz, Sam"), so the header
// is not split on commas; each address token is matched directly.
const ADDRESS = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const self = MAILBOX.toLowerCase();
const firstWritten = new Map(); // address -> earliest send, unix seconds
let oldest = Infinity;

await mapLimit(ids, 8, async (id) => {
  const msg = await gm('messages/' + id, { format: 'metadata', metadataHeaders: ['To', 'Cc', 'Bcc'] });
  const at = Math.floor(Number(msg.internalDate) / 1000);
  if (at < oldest) oldest = at;
  for (const h of msg.payload?.headers ?? []) {
    for (const raw of h.value.match(ADDRESS) ?? []) {
      const addr = raw.toLowerCase();
      if (addr === self) continue;
      const prev = firstWritten.get(addr);
      if (prev === undefined || at < prev) firstWritten.set(addr, at);
    }
  }
});

const q = (s) => `'${s.replace(/'/g, "''")}'`;
const rows = [...firstWritten].sort(([a], [b]) => (a < b ? -1 : 1));
const statements = [];
for (let i = 0; i < rows.length; i += 200) {
  const values = rows.slice(i, i + 200).map(([addr, at]) => `(${q(addr)}, ${at}, ${at})`).join(',\n  ');
  statements.push(
    `INSERT INTO known_sender (address, first_seen_at, replied_at) VALUES\n  ${values}\n` +
    `ON CONFLICT (address) DO UPDATE SET replied_at = MIN(COALESCE(known_sender.replied_at, excluded.replied_at), excluded.replied_at);`,
  );
}
const header = `-- known_sender backfill from sent mail. Customer contact data: keep outside the repo.\n` +
  `-- ${rows.length} addresses from ${ids.length} sent messages.\n`;
writeFileSync(outPath, header + statements.join('\n') + '\n', { mode: 0o600 });
chmodSync(outPath, 0o600);

const day = (s) => (Number.isFinite(s) ? new Date(s * 1000).toISOString().slice(0, 10) : 'none');
console.log(`QUERY: ${QUERY}`);
console.log(`SENT MESSAGES SCANNED: ${ids.length}${capped ? ` (capped at --max ${MAX}; older sent mail not scanned)` : ''}`);
console.log(`OLDEST SENT MESSAGE SCANNED: ${day(oldest)}`);
console.log(`KNOWN SENDERS: ${rows.length}`);
console.log(`WROTE: ${outPath} (mode 600). Apply by hand: wrangler d1 execute inhouse-ops --file=<that file> --remote`);
