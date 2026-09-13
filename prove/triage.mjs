#!/usr/bin/env node
/**
 * PROVE THE CLASSIFIER
 *
 * Runs the triage rules over every message received in the last 30 days
 * (archived, filtered, spam and trash included) and prints each one in its
 * tier: SPAM, BULK (with reasons) and CUSTOMER. Rules change only after the
 * owner has read this output.
 *
 * What to look for, in this order:
 *   1. A real customer in SPAM or BULK. That is the failure that costs money.
 *      SPAM is where Gmail misfiles real people; scan it by eye.
 *   2. Newsletters in CUSTOMER. Annoying, not dangerous.
 *   3. The reason codes. If something is in BULK for a reason that looks
 *      wrong, the rule is wrong, not the email.
 *
 * Run:  node prove/triage.mjs support@inhousewellness.com
 *       node prove/triage.mjs support@inhousewellness.com --days 60
 *
 * Auth: a service account with domain-wide delegation (gmail.readonly),
 * impersonating the mailbox. GOOGLE_SERVICE_ACCOUNT_FILE = path to the key.
 */
import { gmailAccessToken } from './_google.mjs';

const MAILBOX = process.argv[2];
const DAYS = Number(process.argv[process.argv.indexOf('--days') + 1]) || 30;

if (!MAILBOX) fail('Pass a mailbox: node prove/triage.mjs support@inhousewellness.com');

function fail(msg) {
  console.error('\n  FAILED: ' + msg + '\n');
  process.exit(1);
}

// --- the triage rules (a checked copy of src/lib/triage.ts) and verified customers ---
import { classify, emailOf } from './_triage-rules.mjs';
import { loadSenderRules } from './_sender-rules.mjs';

// --- Gmail ---------------------------------------------------------------
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me/';
async function gm(token, path, params = {}) {
  const url = new URL(GMAIL + path);
  // Arrays are sent as repeated parameters. Gmail reads metadataHeaders=From,Subject
  // as a single header name and returns no headers at all.
  for (const [k, v] of Object.entries(params)) {
    for (const item of [].concat(v)) url.searchParams.append(k, item);
  }
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) fail('Gmail ' + path + ' -> ' + res.status + ': ' + (await res.text()));
  return res.json();
}

const token = await gmailAccessToken(MAILBOX, fail);

/** Every id for a query, following nextPageToken to the end. */
async function listAll(params) {
  const ids = [];
  let pageToken;
  do {
    const page = await gm(token, 'messages', { ...params, maxResults: 500, ...(pageToken ? { pageToken } : {}) });
    for (const m of page.messages ?? []) ids.push(m.id);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return ids;
}

/** Map with at most `limit` requests in flight (Gmail allows ~50 messages.get per second). */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

// Build the exemption set first: everyone we have ever written to.
// This is what stops a repeat customer from being demoted because their
// company signature happens to carry an unsubscribe footer.
// Every page of sent mail: a reply beyond the first page still exempts.
const sentIds = await listAll({ q: 'in:sent newer_than:180d' });
const everRepliedTo = new Set();
await mapLimit(sentIds, 8, async (id) => {
  const full = await gm(token, 'messages/' + id, { format: 'metadata', metadataHeaders: 'To' });
  const to = (full.payload?.headers ?? []).find((x) => x.name.toLowerCase() === 'to')?.value ?? '';
  for (const part of to.split(',')) if (part.trim()) everRepliedTo.add(emailOf(part));
});

// The population is the whole received stream, not what is left in the inbox:
// archived, auto-filtered, spam and trash included. Only our own sent mail,
// drafts and chats are excluded. messages.list drops SPAM/TRASH unless
// includeSpamTrash=true, so that is sent alongside in:anywhere.
const QUERY = `in:anywhere newer_than:${DAYS}d -in:sent -in:drafts -in:chats`;
const ids = await listAll({ q: QUERY, includeSpamTrash: 'true' });
if (!ids.length) fail('No mail in the last ' + DAYS + ' days. Wrong mailbox?');

// Verified customers and spam senders: sender_rule rows from the setup seed,
// kept OUTSIDE the repo (it is customer contact data). Optional.
const { markedReal, markedSpam, source: rulesSource } = loadSenderRules(process.env.SENDER_RULES_FILE, fail);
const byTier = { customer: [], bulk: [], spam: [] };

await mapLimit(ids, 8, async (id) => {
  const full = await gm(token, 'messages/' + id, {
    format: 'metadata',
    metadataHeaders: [
      'From', 'Subject', 'List-Unsubscribe', 'List-Id', 'Precedence',
      'Auto-Submitted', 'X-Campaign-Id', 'X-Mailer',
    ],
  });
  const headers = {};
  for (const h of full.payload?.headers ?? []) headers[h.name.toLowerCase()] = h.value;

  const msg = {
    from: headers.from ?? '',
    subject: headers.subject ?? '(no subject)',
    headers,
    labelIds: full.labelIds ?? [],
  };
  const v = classify(msg, { everRepliedTo, markedReal, markedSpam });
  byTier[v.tier].push({ msg, v, at: Number(full.internalDate) });
});

// --- report ---------------------------------------------------------------
// One line per message: date | sender address | subject (50 chars) [| reason codes].
// Dates are America/Chicago, the support desk's zone.
const dateOf = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(ms));
const subjectOf = (s) => [...String(s).replace(/\s+/g, ' ')].slice(0, 50).join('');
const row = (r) => `${dateOf(r.at)} | ${emailOf(r.msg.from)} | ${subjectOf(r.msg.subject)}`;
const newestFirst = (a, b) => b.at - a.at;

console.log(`TOTAL: ${ids.length} messages, ${byTier.customer.length} customer, ${byTier.bulk.length} bulk, ${byTier.spam.length} spam`);
console.log(`QUERY: ${QUERY}`);
console.log('');
console.log('SPAM (all, one line each):');
for (const r of byTier.spam.sort(newestFirst)) console.log(row(r));
console.log('');
console.log('BULK (all, one line each):');
for (const r of byTier.bulk.sort(newestFirst)) console.log(`${row(r)} | ${r.v.signals.map((s) => s.code).join(', ')}`);
console.log('');
console.log('CUSTOMER (all, one line each):');
for (const r of byTier.customer.sort(newestFirst)) console.log(row(r));
console.log('');

const perDay = (n) => (n / DAYS).toFixed(1);
const exemptBy = (reason) => byTier.customer.filter((r) => r.v.exempt === reason).length;
console.log('---');
console.log(`mailbox ${MAILBOX}, last ${DAYS} days; list params: includeSpamTrash=true`);
console.log(`${everRepliedTo.size} exempt senders from ${sentIds.length} sent messages (in:sent newer_than:180d); sender rules: ${markedReal.size} verified customers, ${markedSpam.size} spam senders (${rulesSource})`);
console.log(`customer only because of an exemption: ${exemptBy('we have replied to this sender before')} replied-to, ${exemptBy('verified customer (sender rule)')} verified`);
console.log(`spam with bulk signals too: ${byTier.spam.filter((r) => r.v.score >= 2).length}; spam on Gmail's label alone: ${byTier.spam.filter((r) => r.v.score < 2).length}`);
console.log(`${perDay(ids.length)} received/day, ${perDay(byTier.customer.length)} customer/day, ${perDay(byTier.bulk.length)} bulk/day, ${perDay(byTier.spam.length)} spam/day`);
