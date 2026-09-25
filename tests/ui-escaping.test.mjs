// Everything a user or a sender can type (thread subject, customer name,
// handle, preview, action kind and body, actor, to-do title, brand id) is
// escaped before it reaches the DOM. A signed-in user could otherwise store
// script in an action and run it in a colleague's session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { esc, threadHeaderHtml, historyHtml, todoRowHtml, matrixCellHtml } from '../public/render.mjs';
import { sectionThreads, renderSection } from '../public/queue-sections.mjs';

const TAG = '<img src=x onerror=alert(1)>';
const ATTR = '" autofocus onfocus="alert(1)';
const hostile = (label) => `${label}${TAG}${ATTR}`;
const noInjection = (html, where) => {
  assert.ok(!html.includes('<img'), `${where}: raw tag in ${html}`);
  assert.ok(!html.includes('" autofocus'), `${where}: attribute breakout in ${html}`);
};

test('esc covers &, <, >, " and \'', () => {
  assert.equal(esc(`<a href="x" title='y'>&</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  assert.equal(esc(null), '');
});

test('thread header: subject, customer name, handle, preview and brand are escaped', () => {
  const html = threadHeaderHtml(
    { subject: hostile('s'), customer_name: hostile('n'), customer_handle: hostile('h'), preview: hostile('p'), brand_id: hostile('b') },
    { brandName: (id) => id },
  );
  noInjection(html, 'thread header');
});

test('history: the action kind (the round-10 bug), the actor and the body are escaped', () => {
  const html = historyHtml([{ kind: hostile('kind'), actor: `${hostile('who')}@example.com`, body: hostile('body'), created_at: 0 }], { ageLabel: () => '1h' });
  noInjection(html, 'history');
  assert.ok(html.includes(esc(hostile('kind'))), 'the kind is still shown, as text');
});

test('to-do row: title and brand are escaped', () => {
  noInjection(todoRowHtml({ title: hostile('t'), brand_id: hostile('b') }, { brandName: (id) => id, dueText: '' }), 'todo');
});

test('matrix cell and queue sections escape what they show', () => {
  noInjection(matrixCellHtml({ count: hostile('c'), oldest: hostile('o'), fill: 10, color: 'var(--brass)' }), 'matrix');
  const t = { id: hostile('id'), triage: 'customer', subject: hostile('s'), customer_name: hostile('n'), customer_handle: hostile('h'), brand_id: 'inhouse', channel: hostile('ch'), status: 'blocked', blocked_on: hostile('bo'), assignee: hostile('a') };
  for (const tier of ['customer', 'bulk', 'spam']) {
    const section = sectionThreads([{ ...t, triage: tier, triage_signals: JSON.stringify([{ code: hostile('code') }]) }]).find((s) => s.tier === tier);
    noInjection(renderSection(section, esc, { ageText: () => hostile('age'), brandName: () => hostile('brand') }), tier);
    // A plain waiting row (no reasons, not blocked, not bot-handled) shows its channel instead.
    const plain = sectionThreads([{ ...t, status: 'waiting', triage: tier, triage_signals: null }]).find((s) => s.tier === tier);
    noInjection(renderSection(plain, esc, {}), `${tier} (plain row)`);
  }
});

/** Replace each allowed call name(...) (balanced parentheses) with CALL. */
function stripAllowedCalls(src, allowed) {
  let out = '';
  for (let i = 0; i < src.length;) {
    const m = src.slice(i).match(/^([A-Za-z_$][\w$]*)\s*\(/);
    if (m && allowed.includes(m[1]) && !/[\w$.]/.test(src[i - 1] ?? '')) {
      let depth = 0, j = i + m[0].length - 1;
      for (; j < src.length; j++) { if (src[j] === '(') depth++; else if (src[j] === ')' && --depth === 0) break; }
      out += 'CALL'; i = j + 1; continue;
    }
    if (m) { out += m[0]; i += m[0].length; continue; }
    out += src[i++];
  }
  return out;
}

test('index.html builds markup only from literals and the tested render functions', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const script = html.slice(html.indexOf('<script type="module">'));
  const sinks = [...script.matchAll(/(?:\.innerHTML\s*=|insertAdjacentHTML\(\s*'[a-z]+'\s*,)\s*([\s\S]*?);\s*\n/g)];
  assert.ok(sinks.length >= 8, `found ${sinks.length} sinks`);
  const ALLOWED = ['threadHeaderHtml', 'historyHtml', 'todoRowHtml', 'matrixCellHtml', 'renderSection', 'sectionThreads', 'freshnessBadgeHtml', 'emptyQueueHtml', 'todoListStatusHtml', 'reportHtml', 'unsubscribeHtml', 'assigneeHtml'];
  for (const [statement, rhs] of sinks) {
    const noLiterals = rhs.replace(/'(?:[^'\\]|\\.)*'/g, 'LIT').replace(/`(?:[^`\\]|\\.)*`/g, 'LIT');
    const rest = stripAllowedCalls(noLiterals, ALLOWED)
      .replace(/(?:\b[A-Za-z_$][\w$]*)?\.map\(\(\w+\)\s*=>\s*CALL\)/g, '')   // list.map((s) => renderSection(...))
      .replace(/\.join\(LIT\)/g, '')
      .replace(/^\s*[\w$.!]+\s*\?\s*(CALL|LIT)\s*:\s*(CALL|LIT)\s*$/, '$1');   // cond ? renderer(...) : '' (the condition never reaches the markup)
    assert.match(rest, /^(\s|LIT|CALL|\+|\(|\))*$/, `raw value in markup: ${statement.trim()}\n  -> ${rest}`);
  }
});
