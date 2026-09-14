// HTML builders for the thread panel, history, to-dos and the brand matrix.
// Every value that came from a user, a sender or the API goes through esc().
// Pure functions returning strings, so tests can run them without a DOM
// (tests/ui-escaping.test.mjs), which also checks index.html builds markup
// from nothing but literals and these functions.

import { sourceFreshness } from './freshness.mjs';

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);

/** Subject, customer and preview at the top of the thread panel. */
export function threadHeaderHtml(t, { brandName }) {
  return (
    '<h3>' + esc(t.subject) + '</h3>' +
    '<div class="sub">' + esc(t.customer_name) + ' · ' + esc(t.customer_handle) + ' · ' + esc(brandName(t.brand_id)) + '</div>' +
    '<p style="font-size:13px;color:var(--steam);margin:10px 0 0">' + esc(t.preview) + '</p>'
  );
}

/** A thread's logged actions, newest first. */
export function historyHtml(log, { ageLabel }) {
  return '<div class="label">History</div>' +
    (log.length
      ? '<div class="log">' + log.map((a) =>
          '<article><div class="when">' + esc(String(a.actor ?? '').split('@')[0]) + ' · ' +
            esc(a.kind) + ' · ' + esc(ageLabel(a.created_at)) + ' ago</div>' +
          '<p>' + esc(a.body) + '</p></article>').join('') + '</div>'
      : '<p class="sub">Nothing logged yet.</p>');
}

/** One to-do row (the checkbox is wired up by the caller). */
export function todoRowHtml(td, { brandName, dueText }) {
  return (
    '<input type="checkbox" aria-label="Mark done">' +
    '<div><div class="t">' + esc(td.title) + '</div>' +
    '<div class="d">' + esc(brandName(td.brand_id)) + esc(dueText) + '</div></div>'
  );
}

/** One brand × channel cell: Needs-reply count, oldest wait, heat bar. */
export function matrixCellHtml({ count, oldest, fill, color, tone = 'fresh' }) {
  const width = Math.max(0, Math.min(100, Number(fill) || 0));
  const heat = /^var\(--[a-z]+\)$/.test(color) ? color : 'var(--steam)';
  return (
    '<div class="count num">' + esc(count) + '</div>' +
    '<div class="oldest ' + (['fresh', 'warning', 'error', 'none'].includes(tone) ? tone : 'none') + '">' + esc(oldest) + '</div>' +
    '<div class="heat"><span style="width:' + width + '%;background:' + heat + '"></span></div>'
  );
}

/**
 * What one brand × channel cell says. "clear" is only said when the board
 * loaded and every source for that channel synced recently; otherwise the cell
 * says it can't vouch for the number (round 11: it used to say "clear" while
 * the API was failing, the sync was 13 hours stale, or no source existed).
 */
export function matrixCellView({ brand, count, oldestLabel, channel, sources, now, loaded }) {
  if (!loaded) return { count: '?', note: 'not loaded', tone: 'error' };
  const mine = sources.filter((s) => s.channel === channel && s.brand_id === brand).map((s) => sourceFreshness(s, now));
  if (!mine.length) return { count: count ? String(count) : '—', note: 'not connected', tone: 'none' };
  const worst = mine.find((s) => s.state === 'error') ?? mine.find((s) => s.state === 'warning');
  if (worst) {
    const when = worst.age === null ? 'never synced' : `synced ${worst.text.split(' synced ')[1]}`;
    return { count: count ? String(count) : '—', note: `not verified: ${when}`, tone: worst.state };
  }
  return { count: count ? String(count) : '—', note: count ? (oldestLabel ? `oldest ${oldestLabel}` : 'none awaiting us') : 'clear', tone: 'fresh' };
}

/** The line under the to-do list: an error, "nothing on the list", or "N of M" with a control for more. */
export function todoListStatusHtml({ loaded, error, shown, total }) {
  if (error || !loaded) return `<p class="sub error" role="alert">Could not load to-dos${error ? ` (${esc(error)})` : ''}. This is not an empty list.</p>`;
  if (!total) return '<p class="sub">Nothing on the list. Add the next thing.</p>';
  if (shown < total) return `<p class="sub">Showing ${shown} of ${total}. <button class="more" data-more-todos="1">Show more</button></p>`;
  return '';
}
