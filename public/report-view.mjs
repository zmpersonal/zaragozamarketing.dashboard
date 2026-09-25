// The admin response-time view (round 15), as pure HTML builders.
//
// Every number here is BUSINESS time (America/Chicago, Mon-Fri 08:00-17:00),
// and the page says so in words: a median of "1h 35m" that quietly meant
// wall-clock would flatter a Friday evening email into a Monday morning reply.
//
// Medians, never means. Outstanding work is shown as buckets, because twelve
// threads at six business hours and one at sixty are different problems and a
// single number hides both.

import { esc as escapeHtml } from './render.mjs';

/** A business-minutes duration in words. 8 business hours is a working day. */
export function businessDuration(mins) {
  if (mins == null || Number.isNaN(mins)) return '—';
  const m = Math.max(0, Math.round(mins));
  if (m < 60) return `${m}m`;
  if (m < 480) return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
  const days = m / 480;
  const rounded = Math.round(days * 10) / 10;
  return `${rounded === 1 ? '1' : rounded} working day${rounded === 1 ? '' : 's'}`;
}

const CHANNEL = { email: 'Email', phone: 'Phone', chat: 'Chat', all: 'Everything' };
const BUCKETS = [
  ['under_2h', 'under 2h'],
  ['h2_8', '2–8h'],
  ['h8_24', '8–24h'],
  ['over_24h', 'over 24h'],
];

/** Only a real web link is ever rendered as one. */
const safeHref = (url) => (typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null);

const dateLabel = (unix) =>
  new Date(unix * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export function reportHtml(r, esc = escapeHtml) {
  const channels = r.channels ?? [];
  const cards = channels.map((c) => (
    '<div class="stat">' +
      `<div class="stat-label">${esc(CHANNEL[c.channel] ?? c.channel)}</div>` +
      `<div class="stat-value">${esc(businessDuration(c.median_business_minutes))}</div>` +
      `<div class="stat-sub">median first response · ${esc(String(c.answered))} answered</div>` +
    '</div>'
  )).join('');

  const rows = Object.entries(r.outstanding ?? {})
    .filter(([ch]) => ch !== 'all')
    .concat(r.outstanding?.all ? [['all', r.outstanding.all]] : [])
    .map(([ch, b]) => (
      '<tr>' +
        `<th>${esc(CHANNEL[ch] ?? ch)}</th>` +
        BUCKETS.map(([key]) => `<td class="${key === 'over_24h' && b[key] ? 'late' : ''}">${esc(String(b[key] ?? 0))}</td>`).join('') +
        `<td class="total">${esc(String(b.total ?? 0))}</td>` +
      '</tr>'
    )).join('');

  const recent = (r.recent ?? []).map((x) => {
    const href = safeHref(x.link);
    const who = String(x.actor ?? '').split('@')[0];
    const said = x.action_body
      ? esc(x.action_body)
      : x.via === 'message'
        ? '<span class="quiet">replied in Gmail; no note was logged</span>'
        : '<span class="quiet">no note was logged</span>';
    return (
      '<li class="answered">' +
        '<div class="answered-head">' +
          `<span class="answered-when">${esc(dateLabel(x.responded_at))}</span>` +
          `<span class="answered-subject">${esc(x.subject ?? '')}</span>` +
          `<span class="chip">${esc(businessDuration(x.business_minutes))}</span>` +
        '</div>' +
        `<div class="answered-who">${esc(x.customer_name ?? x.customer_handle ?? '')} · ${esc(CHANNEL[x.channel] ?? x.channel ?? '')} · answered by ${esc(who || 'system')}</div>` +
        `<div class="answered-said">${said}</div>` +
        (href ? `<a class="answered-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">Open the ${esc(x.channel === 'phone' ? 'conversation in Quo' : 'thread in Gmail')}</a>` : '') +
      '</li>'
    );
  }).join('');

  return (
    `<div class="label">Response times · last ${esc(String(r.days ?? 30))} days · business hours only (Mon–Fri 08:00–17:00 Central)</div>` +
    `<div class="stats">${cards}</div>` +
    '<div class="label">Still waiting on us, by how long they have been waiting</div>' +
    '<table class="buckets"><thead><tr><th></th>' +
      BUCKETS.map(([, label]) => `<th>${esc(label)}</th>`).join('') +
      '<th>all</th></tr></thead>' +
      `<tbody>${rows}</tbody></table>` +
    `<div class="label">Answered in the last ${esc(String(r.recent_days ?? 7))} days</div>` +
    (recent ? `<ul class="answered-list">${recent}</ul>` : '<div class="empty">Nothing was answered in this window.</div>')
  );
}
