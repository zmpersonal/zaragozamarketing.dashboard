// How fresh is each source? Ingest runs hourly on GitHub Actions, and that can
// stop without anyone noticing: a disabled schedule, an expired token, a quota,
// an API change. So the console shows the last successful sync per source, from
// /api/board, and never lets an empty queue look healthy when it might not be.
//
// Pure functions, so tests run without a DOM (tests/sync-freshness.test.mjs).

import { esc as escapeHtml } from './render.mjs';

/** Seconds since the last successful sync: more than this is a warning, then an error. */
export const WARN_AFTER = 3 * 3600;
export const ERROR_AFTER = 12 * 3600;

const LABEL = { email: 'Email', phone: 'Phone', chat: 'Chat' };
const RANK = { fresh: 0, warning: 1, error: 2 };

function ago(seconds) {
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 48 * 3600) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
}

/** { label, state: 'fresh' | 'warning' | 'error', age, text } for one source row from /api/board. `now` is the server's unix seconds. */
export function sourceFreshness(source, now) {
  const label = `${LABEL[source.channel] ?? source.channel} (${source.address})`;
  if (source.last_synced_at == null) {
    return { label, state: 'error', age: null, text: `${label} has never synced` };
  }
  const age = Math.max(0, now - source.last_synced_at);
  const state = age > ERROR_AFTER ? 'error' : age > WARN_AFTER ? 'warning' : 'fresh';
  return { label, state, age, text: `${label} synced ${ago(age)}` };
}

/** The worst state across sources. No sources at all is an error: nothing can arrive. */
export function overallFreshness(sources, now) {
  const each = sources.map((s) => sourceFreshness(s, now));
  const state = each.length ? each.reduce((worst, s) => (RANK[s.state] > RANK[worst] ? s.state : worst), 'fresh') : 'error';
  return { state, sources: each };
}

/** One line per source for the header. Warnings are role="status", errors role="alert". */
export function freshnessBadgeHtml(sources, now, esc = escapeHtml) {
  return overallFreshness(sources, now).sources.map((s) => {
    const role = s.state === 'error' ? ' role="alert"' : s.state === 'warning' ? ' role="status"' : '';
    const hint = s.state === 'fresh' ? '' : s.state === 'error' ? ' — ingest may have stopped' : ' — later than usual';
    return `<span class="sync ${s.state}"${role}>${esc(s.text + hint)}</span>`;
  }).join('');
}

/**
 * What to show where the queue would be when it's empty. "Nothing waiting" is
 * only said when the API answered and every source synced recently.
 */
export function emptyQueueHtml({ sources, now, apiError }, esc = escapeHtml) {
  if (apiError) {
    return `<div class="empty error" role="alert">Could not load the queue (${esc(apiError)}). This is not an empty queue; reload, and if it keeps failing, check the Worker.</div>`;
  }
  const overall = overallFreshness(sources, now);
  if (!overall.sources.length) {
    return '<div class="empty error" role="alert">No sources are set up, so no mail or calls can arrive. Nothing here means nothing is connected.</div>';
  }
  if (overall.state === 'fresh') {
    return `<div class="empty">Nothing waiting. ${esc(overall.sources.map((s) => s.text).join('; '))}.</div>`;
  }
  const stale = overall.sources.filter((s) => s.state !== 'fresh').map((s) => s.text).join('; ');
  return `<div class="empty ${overall.state}" role="alert">Nothing is showing, but this list may be out of date: ${esc(stale)}.</div>`;
}
