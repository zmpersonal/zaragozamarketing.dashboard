/**
 * Triage — is this a real person writing to us, or bulk mail?
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

export interface Signal {
  code: string;
  why: string;
  weight: number;   // 1 = suggestive, 2 = on its own enough
}

export interface Verdict {
  demote: boolean;
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
}

/** Automated-sender words, matched anywhere in the local part (never the domain). */
export const NOREPLY = /(no-?reply|do-?not-?reply|donotreply|bounce|mailer-daemon|postmaster)/i;

export const emailOf = (from: string) =>
  (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();

export const domainOf = (from: string) => emailOf(from).split('@')[1] ?? '';

export function classify(msg: Msg, ex: Exemptions): Verdict {
  const addr = emailOf(msg.from);
  const signals: Signal[] = [];

  // --- exemptions win outright -------------------------------------
  if (ex.markedSpam.has(addr)) {
    return { demote: true, score: 99, signals: [
      { code: 'marked_spam', why: 'agent marked this sender as spam', weight: 2 },
    ] };
  }
  if (ex.markedReal.has(addr)) {
    return { demote: false, score: 0, signals: [], exemptReason: 'agent marked this sender as a real customer' };
  }
  if (ex.everRepliedTo.has(addr)) {
    return { demote: false, score: 0, signals: [], exemptReason: 'we have replied to this sender before' };
  }

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
  if (labels.has('SPAM')) {
    signals.push({ code: 'gmail_spam', why: 'Gmail marked it as spam', weight: 2 });
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

  // Two suggestive signals, or one decisive one.
  return { demote: score >= 2, score, signals };
}
