// HTML builders for the thread panel, history, to-dos and the brand matrix.
// Every value that came from a user, a sender or the API goes through esc().
// Pure functions returning strings, so tests can run them without a DOM
// (tests/ui-escaping.test.mjs), which also checks index.html builds markup
// from nothing but literals and these functions.

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
export function matrixCellHtml({ count, oldest, fill, color }) {
  const width = Math.max(0, Math.min(100, Number(fill) || 0));
  const heat = /^var\(--[a-z]+\)$/.test(color) ? color : 'var(--steam)';
  return (
    '<div class="count num">' + esc(count) + '</div>' +
    '<div class="oldest">' + esc(oldest) + '</div>' +
    '<div class="heat"><span style="width:' + width + '%;background:' + heat + '"></span></div>'
  );
}
