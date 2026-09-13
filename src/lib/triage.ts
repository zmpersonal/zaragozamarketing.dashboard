/**
 * Triage — is this a real person writing to us, bulk mail, or spam?
 *
 * Three tiers, and nothing is ever hidden in any of them:
 *   customer  needs a reply
 *   bulk      probably not a customer (structural bulk-mail signals)
 *   spam      Gmail (or an agent) judged it spam. Kept visible and scannable:
 *             Gmail's spam label is wrong about some real customers, and a
 *             terse real customer can't be told from phishing by rule.
 * Gmail's SPAM label routes to 'spam' and ONLY there; it adds nothing to the
 * bulk score. Our own reply history and verified customers beat it.
 *
 * Tuned for recall: we would rather show the agent a newsletter than
 * hide a customer. Nothing here deletes or hides anything; a demoted
 * message still appears, just below the fold and greyed, with the
 * reasons printed so a bad rule is visible instead of silent.
 *
 * No model in this path. These are structural facts about the message,
 * they cost nothing to evaluate, and they keep working if every
 * subscription lapses.
 */

export type Tier = 'customer' | 'bulk' | 'spam';

export interface Signal {
  code: string;
  why: string;
  weight: number;   // bulk weight: 1 = suggestive, 2 = on its own enough; 0 = spam, not bulk
}

export interface Verdict {
  tier: Tier;
  /** tier !== 'customer' */
  demote: boolean;
  /** bulk score only; the spam label never counts */
  score: number;
  signals: Signal[];
  exemptReason?: string;
}

interface Msg {
  from: string;                         // raw From header
  subject: string;
  headers: Record<string, string>;      // lowercased keys
  labelIds: string[];                   // Gmail labelIds
}

/** Senders we have ever replied to, or the agent has marked as real. */
export interface Exemptions {
  everRepliedTo: Set<string>;
  markedReal: Set<string>;
  markedSpam: Set<string>;
  /** owner-verified customers (lib/known-customers.ts), lowercased */
  knownCustomers?: Set<string>;
}

/**
 * Automated-sender words, matched anywhere in the local part (never the domain).
 * Multi-word forms allow a hyphen, underscore, dot, or nothing between words:
 * noreply, no-reply, no_reply, no.reply, do_not_reply, mailer-daemon.
 */
export const NOREPLY = /(no[-_.]?reply|do[-_.]?not[-_.]?reply|bounce|mailer[-_.]?daemon|postmaster)/i;

export const emailOf = (from: string) =>
  (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();

export const domainOf = (from: string) => emailOf(from).split('@')[1] ?? '';

export function classify(msg: Msg, ex: Exemptions): Verdict {
  const addr = emailOf(msg.from);
  const signals: Signal[] = [];

  const customer = (exemptReason: string): Verdict =>
    ({ tier: 'customer', demote: false, score: 0, signals: [], exemptReason });

  // --- exemptions win outright, over every signal including Gmail spam --
  if (ex.markedSpam.has(addr)) {
    return { tier: 'spam', demote: true, score: 0, signals: [
      { code: 'marked_spam', why: 'agent marked this sender as spam', weight: 0 },
    ] };
  }
  if (ex.knownCustomers?.has(addr)) return customer('owner verified this sender as a customer');
  if (ex.markedReal.has(addr)) return customer('agent marked this sender as a real customer');
  if (ex.everRepliedTo.has(addr)) return customer('we have replied to this sender before');

  const h = (name: string) => msg.headers[name.toLowerCase()] ?? '';
  const labels = new Set(msg.labelIds);

  // --- the strong ones ---------------------------------------------
  // Bulk senders must include List-Unsubscribe to land in Gmail at all.
  // A person's mail client never adds it.
  if (h('list-unsubscribe')) {
    signals.push({ code: 'list_unsubscribe', why: 'has a List-Unsubscribe header', weight: 2 });
  }
  if (h('list-id')) {
    signals.push({ code: 'list_id', why: 'sent to a mailing list', weight: 1 });
  }

  // Google has already classified this mail. Promotions and Social are
  // confident. Updates is NOT — order confirmations and shipping notices
  // live there and some of those need a human.
  if (labels.has('CATEGORY_PROMOTIONS')) {
    signals.push({ code: 'gmail_promo', why: 'Gmail filed it under Promotions', weight: 2 });
  }
  if (labels.has('CATEGORY_SOCIAL')) {
    signals.push({ code: 'gmail_social', why: 'Gmail filed it under Social', weight: 2 });
  }
  // Spam is its own tier, not a heavier bulk signal: weight 0, and see below.
  const gmailSpam = labels.has('SPAM');
  if (gmailSpam) {
    signals.push({ code: 'gmail_spam', why: 'Gmail marked it as spam', weight: 0 });
  }

  // --- automated mail that isn't marketing --------------------------
  const precedence = h('precedence').toLowerCase();
  if (['bulk', 'list', 'junk'].includes(precedence)) {
    signals.push({ code: 'precedence', why: `Precedence: ${precedence}`, weight: 1 });
  }
  const autoSub = h('auto-submitted').toLowerCase();
  if (autoSub && autoSub !== 'no') {
    signals.push({ code: 'auto_submitted', why: 'machine-generated (Auto-Submitted)', weight: 1 });
  }
  if (h('x-campaign-id') || h('x-mailer')?.match(/klaviyo|mailchimp|sendgrid|hubspot/i)) {
    signals.push({ code: 'esp', why: 'sent through a bulk email platform', weight: 1 });
  }

  // --- sender shape --------------------------------------------------
  // Anywhere in the local part: no-reply-calendar@, notifications-noreply@.
  if (NOREPLY.test(addr.split('@')[0])) {
    signals.push({ code: 'noreply', why: 'sent from a no-reply address', weight: 2 });
  }

  const score = signals.reduce((n, s) => n + s.weight, 0);

  // Spam wins over bulk; otherwise two suggestive bulk signals, or one decisive one.
  const tier: Tier = gmailSpam ? 'spam' : score >= 2 ? 'bulk' : 'customer';
  return { tier, demote: tier !== 'customer', score, signals };
}
