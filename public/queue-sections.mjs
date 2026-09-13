// Queue sections: needs reply, probably not customers, and spam at the bottom.
//
// Nothing is ever hidden: every thread lands in exactly one section, and any
// tier we don't recognise is shown as needing a reply. The spam section is
// always expanded and plain: sender and the full subject on every row, so a
// human can scan it. Gmail's spam label is wrong about some real customers,
// and a terse real customer can't be told from phishing by rule.
//
// Pure functions returning HTML strings, so tests can run them without a DOM.

export const SECTIONS = [
  { tier: 'customer', title: 'Needs reply' },
  { tier: 'bulk', title: 'Probably not customers' },
  { tier: 'spam', title: 'Spam' },
];

const tierOf = (t) => (t.triage === 'bulk' || t.triage === 'spam' ? t.triage : 'customer');

export function sectionThreads(threads) {
  return SECTIONS.map((s) => ({ ...s, threads: threads.filter((t) => tierOf(t) === s.tier) }));
}

export function reasonCodes(t) {
  try {
    const signals = JSON.parse(t.triage_signals ?? '[]');
    return Array.isArray(signals) ? signals.map((s) => s.code).filter(Boolean) : [];
  } catch {
    return [];
  }
}

const defaults = {
  ageText: () => '',
  color: () => 'var(--steam)',
  brandName: () => '',
  selected: null,
};

/** A clickable queue row for needs-reply and bulk threads. */
function row(t, esc, o, reasons) {
  const color = o.color(t);
  return (
    `<button class="row" data-thread="${esc(t.id)}" aria-selected="${o.selected === t.id}">` +
      `<span class="edge" style="background:${color}"></span>` +
      `<span class="age num" style="color:${color}">${esc(o.ageText(t))}</span>` +
      '<span class="body">' +
        `<span class="subject">${esc(t.subject)}</span><br>` +
        `<span class="from">${esc(t.customer_name ?? t.customer_handle ?? '')} · ${esc(o.brandName(t.brand_id))}</span>` +
      '</span>' +
      '<span class="meta">' +
        (reasons.length
          ? reasons.map((c) => `<span class="chip reason">${esc(c)}</span>`).join(' ')
          : t.status === 'blocked'
            ? `<span class="chip" style="color:var(--ember)">blocked: ${esc(t.blocked_on)}</span>`
            : t.is_automated
              ? '<span class="chip" style="color:var(--plunge)">bot handled</span>'
              : esc(t.channel ?? '')) +
      '</span>' +
      `<span class="who">${t.assignee ? esc(String(t.assignee).split('@')[0]) : 'unassigned'}</span>` +
    '</button>'
  );
}

/** A plain spam line: sender address and the whole subject, nothing to expand. */
function spamRow(t, esc, o) {
  return (
    `<li class="spam-row" data-thread="${esc(t.id)}" tabindex="0" role="link">` +
      `<span class="spam-age num">${esc(o.ageText(t))}</span>` +
      `<span class="spam-from">${esc(t.customer_handle ?? '')}</span>` +
      `<span class="spam-subject">${esc(t.subject ?? '')}</span>` +
    '</li>'
  );
}

export function renderSection(section, esc, opts = {}) {
  const o = { ...defaults, ...opts };
  const n = section.threads.length;
  const title = `<h3 class="section-title section-${section.tier}">${esc(section.title)} (${n})</h3>`;

  if (section.tier === 'spam') {
    return (
      `<section class="queue-section spam-section">${title}` +
        (n ? `<ul class="spam-list">${section.threads.map((t) => spamRow(t, esc, o)).join('')}</ul>`
           : '<p class="section-empty">Nothing Gmail marked as spam.</p>') +
      '</section>'
    );
  }
  const reasons = (t) => (section.tier === 'bulk' ? reasonCodes(t) : []);
  return (
    `<section class="queue-section">${title}` +
      (n ? `<div class="queue">${section.threads.map((t) => row(t, esc, o, reasons(t))).join('')}</div>`
         : '<p class="section-empty">Nothing here.</p>') +
    '</section>'
  );
}

// Header counts: the numbers at the top of the page and in each brand cell
// count Needs-reply threads only. Bulk and spam are counted in their own
// section headers (renderSection), never in these.
const needsReply = (threads) => threads.filter((t) => tierOf(t) === 'customer');

/** { open, over24h } for the page header. `now` is unix seconds. */
export function headerCounts(threads, now) {
  const mine = needsReply(threads);
  return {
    open: mine.length,
    over24h: mine.filter((t) => t.awaiting_since != null && now - t.awaiting_since > 24 * 3600).length,
  };
}

/** { count, oldest } for one brand × channel cell. oldest is the earliest awaiting_since, or null. */
export function brandCell(threads, brandId, channel) {
  const cell = needsReply(threads).filter((t) => t.brand_id === brandId && t.channel === channel);
  const since = cell.map((t) => t.awaiting_since).filter((x) => x != null);
  return { count: cell.length, oldest: since.length ? Math.min(...since) : null };
}
