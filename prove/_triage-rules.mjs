/**
 * The triage rules as a plain-JS copy for prove/triage.mjs.
 *
 * src/lib/triage.ts is the source of truth. This copy exists only until the
 * owner approves importing it directly. tests/triage.test.mjs runs both over
 * a matrix of messages and requires identical tier, score and reason codes.
 * Sender rules (markedReal = verified customers, markedSpam) come from a seed
 * file kept outside the repo (see prove/triage.mjs, SENDER_RULES_FILE).
 */
export const NOREPLY = /(no[-_.]?reply|do[-_.]?not[-_.]?reply|bounce|mailer[-_.]?daemon|postmaster)/i;
export const emailOf = (from) => (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();

/** ex: { everRepliedTo: Set, markedReal?: Set, markedSpam?: Set } */
export function classify(msg, ex) {
  const addr = emailOf(msg.from);
  const customer = (exempt) => ({ tier: 'customer', demote: false, score: 0, signals: [], exempt });
  // Exemptions beat every signal, including Gmail spam.
  if (ex.markedSpam?.has(addr)) {
    return { tier: 'spam', demote: true, score: 0, signals: [{ code: 'marked_spam', why: 'agent marked this sender as spam', weight: 0 }] };
  }
  if (ex.markedReal?.has(addr)) return customer('verified customer (sender rule)');
  if (ex.everRepliedTo.has(addr)) return customer('we have replied to this sender before');

  const signals = [];
  const h = (n) => msg.headers[n] ?? '';
  const labels = new Set(msg.labelIds);
  const push = (code, why, weight) => signals.push({ code, why, weight });

  if (h('list-unsubscribe')) push('list_unsubscribe', 'has a List-Unsubscribe header', 2);
  if (h('list-id')) push('list_id', 'sent to a mailing list', 1);
  if (labels.has('CATEGORY_PROMOTIONS')) push('gmail_promo', 'Gmail filed it under Promotions', 2);
  if (labels.has('CATEGORY_SOCIAL')) push('gmail_social', 'Gmail filed it under Social', 2);
  // Spam is its own tier: weight 0, never part of the bulk score.
  const gmailSpam = labels.has('SPAM');
  if (gmailSpam) push('gmail_spam', 'Gmail marked it as spam', 0);

  const prec = h('precedence').toLowerCase();
  if (['bulk', 'list', 'junk'].includes(prec)) push('precedence', `Precedence: ${prec}`, 1);
  const auto = h('auto-submitted').toLowerCase();
  if (auto && auto !== 'no') push('auto_submitted', 'machine-generated', 1);
  if (h('x-campaign-id') || /klaviyo|mailchimp|sendgrid|hubspot/i.test(h('x-mailer')))
    push('esp', 'sent through a bulk email platform', 1);
  if (NOREPLY.test(addr.split('@')[0]))
    push('noreply', 'sent from a no-reply address', 2);

  const score = signals.reduce((n, s) => n + s.weight, 0);
  const tier = gmailSpam ? 'spam' : score >= 2 ? 'bulk' : 'customer';
  return { tier, demote: tier !== 'customer', score, signals };
}
