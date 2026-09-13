#!/usr/bin/env node
/**
 * PROVE THE CLASSIFIER
 *
 * Runs the triage rules over the last 30 days of support@ and prints every
 * message with the decision and the reasons behind it. Nothing is built on
 * this filter until you have read the output and agree with it.
 *
 * What to look for, in this order:
 *   1. Any REAL customer sitting in the DEMOTED list. That is the only
 *      failure that actually costs money. Should be zero.
 *   2. Newsletters sitting in KEPT. Annoying, not dangerous — this is the
 *      side we deliberately err toward.
 *   3. The reason codes. If something is demoted for a reason that looks
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

// --- the same rules the worker uses, inlined so this runs with no build ---
// Must equal NOREPLY in src/lib/triage.ts (tests/triage.test.mjs checks).
const NOREPLY = /(no[-_.]?reply|do[-_.]?not[-_.]?reply|bounce|mailer[-_.]?daemon|postmaster)/i;
const emailOf = (from) => (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();

function classify(msg, everRepliedTo) {
  const addr = emailOf(msg.from);
  if (everRepliedTo.has(addr))
    return { demote: false, score: 0, signals: [], exempt: 'we have replied to this sender before' };

  const signals = [];
  const h = (n) => msg.headers[n] ?? '';
  const labels = new Set(msg.labelIds);
  const push = (code, why, weight) => signals.push({ code, why, weight });

  if (h('list-unsubscribe')) push('list_unsubscribe', 'has a List-Unsubscribe header', 2);
  if (h('list-id')) push('list_id', 'sent to a mailing list', 1);
  if (labels.has('CATEGORY_PROMOTIONS')) push('gmail_promo', 'Gmail filed it under Promotions', 2);
  if (labels.has('CATEGORY_SOCIAL')) push('gmail_social', 'Gmail filed it under Social', 2);
  if (labels.has('SPAM')) push('gmail_spam', 'Gmail marked it as spam', 2);

  const prec = h('precedence').toLowerCase();
  if (['bulk', 'list', 'junk'].includes(prec)) push('precedence', `Precedence: ${prec}`, 1);
  const auto = h('auto-submitted').toLowerCase();
  if (auto && auto !== 'no') push('auto_submitted', 'machine-generated', 1);
  if (h('x-campaign-id') || /klaviyo|mailchimp|sendgrid|hubspot/i.test(h('x-mailer')))
    push('esp', 'sent through a bulk email platform', 1);
  if (NOREPLY.test(addr.split('@')[0]))
    push('noreply', 'sent from a no-reply address', 2);

  const score = signals.reduce((n, s) => n + s.weight, 0);
  return { demote: score >= 2, score, signals };
}

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

const kept = [], demoted = [];

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
  const v = classify(msg, everRepliedTo);
  (v.demote ? demoted : kept).push({ msg, v, at: Number(full.internalDate) });
});

// --- report ---------------------------------------------------------------
// One line per message: date | sender address | subject (50 chars) [| reason codes].
// Dates are America/Chicago, the support desk's zone.
const dateOf = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(ms));
const subjectOf = (s) => [...String(s).replace(/\s+/g, ' ')].slice(0, 50).join('');
const row = (r) => `${dateOf(r.at)} | ${emailOf(r.msg.from)} | ${subjectOf(r.msg.subject)}`;
const newestFirst = (a, b) => b.at - a.at;

console.log(`TOTAL: ${ids.length} messages, ${kept.length} kept, ${demoted.length} demoted`);
console.log(`QUERY: ${QUERY}`);
console.log('');
console.log('DEMOTED (all of them, one line each):');
for (const r of demoted.sort(newestFirst)) console.log(`${row(r)} | ${r.v.signals.map((s) => s.code).join(', ')}`);
console.log('');
console.log('KEPT (all of them, one line each):');
for (const r of kept.sort(newestFirst)) console.log(row(r));
console.log('');

const perDay = (n) => (n / DAYS).toFixed(1);
console.log('---');
console.log(`mailbox ${MAILBOX}, last ${DAYS} days; list params: includeSpamTrash=true`);
console.log(`${everRepliedTo.size} exempt senders from ${sentIds.length} sent messages (in:sent newer_than:180d)`);
console.log(`${kept.filter((r) => r.v.exempt).length} kept only because we have replied to the sender before`);
console.log(`${perDay(ids.length)} received/day, ${perDay(kept.length)} kept/day, ${perDay(demoted.length)} demoted/day`);
