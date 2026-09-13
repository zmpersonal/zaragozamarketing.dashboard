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
  if (/^(no-?reply|do-?not-?reply|donotreply|bounce|mailer-daemon|postmaster)@/i.test(addr))
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

// Build the exemption set first: everyone we have ever written to.
// This is what stops a repeat customer from being demoted because their
// company signature happens to carry an unsubscribe footer.
const sentList = await gm(token, 'messages', { q: 'in:sent newer_than:180d', maxResults: 200 });
const everRepliedTo = new Set();
for (const m of sentList.messages ?? []) {
  const full = await gm(token, 'messages/' + m.id, { format: 'metadata', metadataHeaders: 'To' });
  const to = (full.payload?.headers ?? []).find((x) => x.name.toLowerCase() === 'to')?.value ?? '';
  for (const part of to.split(',')) if (part.trim()) everRepliedTo.add(emailOf(part));
}

const list = await gm(token, 'messages', {
  q: `in:inbox newer_than:${DAYS}d`, maxResults: 400,
});
const ids = list.messages ?? [];
if (!ids.length) fail('No mail in the last ' + DAYS + ' days. Wrong mailbox?');

const kept = [], demoted = [];

for (const stub of ids) {
  const full = await gm(token, 'messages/' + stub.id, {
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
}

// --- report ---------------------------------------------------------------
const pad = (s, n) => String(s).slice(0, n).padEnd(n);
const line = (r) =>
  '    ' + pad(new Date(r.at).toISOString().slice(5, 10), 6) +
  pad(emailOf(r.msg.from), 34) + pad(r.msg.subject, 44);

console.log(`\n  ${MAILBOX} — last ${DAYS} days, ${ids.length} messages`);
console.log(`  ${everRepliedTo.size} exempt senders (we have written to them before)\n`);

console.log(`  KEPT — shown to the agent as needing a reply  (${kept.length})\n`);
for (const r of kept.sort((a, b) => b.at - a.at)) {
  console.log(line(r) + (r.v.exempt ? '  [exempt: ' + r.v.exempt + ']' : ''));
}

console.log(`\n  DEMOTED — shown greyed below the fold  (${demoted.length})\n`);
for (const r of demoted.sort((a, b) => b.at - a.at)) {
  console.log(line(r) + '  ' + r.v.signals.map((s) => s.code).join(', '));
}

const perDay = (n) => (n / DAYS).toFixed(1);
console.log(`\n  ${perDay(kept.length)} kept/day, ${perDay(demoted.length)} demoted/day.`);
console.log('  You said roughly 2 real a day out of 10-20.');
console.log('  If kept/day is far above 2, the rules are too loose — read the KEPT list.');
console.log('  If ANY real customer is in DEMOTED, stop and tell me which one.\n');
