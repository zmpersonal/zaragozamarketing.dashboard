// A phone row has to say what it is (round 14). Before this, every phone thread
// in the queue was titled "Call": 52 of 52 on the live line, which reads as
// noise whatever is in it. Now the row carries the kind (missed call,
// voicemail, text) and, for a voicemail, the transcript the way an email row
// carries its subject line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderSection, sectionThreads } from '../public/queue-sections.mjs';
import { esc } from '../public/render.mjs';

const INDEX = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const SRC = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

const phone = (over = {}) => ({
  id: 'quo:CN1', brand_id: 'inhouse', channel: 'phone', subject: 'Voicemail',
  customer_name: 'Rosa Lim', customer_handle: '+15125550142', status: 'waiting',
  triage: 'customer', preview: 'Hi, this is Rosa, the pump is leaking again.', ...over,
});
const render = (threads) => renderSection(sectionThreads(threads)[0], esc, { total: threads.length });

test('a voicemail row shows the kind and the transcript', () => {
  const html = render([phone()]);
  assert.match(html, /Voicemail/);
  assert.match(html, /the pump is leaking again/);
});

test('a missed call with no voicemail shows the kind and no empty snippet', () => {
  const html = render([phone({ subject: 'Missed call', preview: null })]);
  assert.match(html, /Missed call/);
  assert.doesNotMatch(html, /class="snippet"/);
});

test('an email row is unchanged: its subject line is already the snippet', () => {
  const html = render([{
    id: 'gmail:c1', brand_id: 'inhouse', channel: 'email', subject: 'Where is my order?',
    customer_name: 'A Person', customer_handle: 'a.person@example.com', status: 'waiting',
    triage: 'customer', preview: 'body text that the list does not show',
  }]);
  assert.match(html, /Where is my order\?/);
  assert.doesNotMatch(html, /body text that the list does not show/);
});

test('a hostile transcript cannot reach the DOM as markup', () => {
  const html = render([phone({ preview: '<img src=x onerror=alert(1)>', customer_name: '<script>bad()</script>' })]);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>bad/);
  assert.match(html, /&lt;img src=x/);
});

test('the queue query sends a bounded preview, so a row stays small', () => {
  const columns = SRC.match(/const LIST_COLUMNS = `([^`]+)`/)[1];
  assert.match(columns, /substr\(t\.preview\s*,\s*1\s*,\s*\d+\)\s+AS preview/, 'truncated in SQL, not in the browser');
  const limit = Number(columns.match(/substr\(t\.preview\s*,\s*1\s*,\s*(\d+)\)/)[1]);
  assert.ok(limit <= 200, `${limit} characters a row is too much for a 50-row page`);
  assert.doesNotMatch(columns, /blocked_note/, 'still only what the list renders');
});

// --- the left nav (round 14, item 5) ---------------------------------------

test('the nav lists InHouse Wellness and Caliza Group only', () => {
  const brands = INDEX.match(/const BRANDS = \[([\s\S]*?)\];/)[1];
  const ids = [...brands.matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['inhouse', 'caliza']);
  assert.match(brands, /InHouse Wellness/);
  assert.match(brands, /Caliza Group/);
});

test('THI and Reach Julian keep their rows in the database: THI is a real future tab', () => {
  const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  assert.match(schema, /\('thi',\s*'THI'\)/);
  assert.match(schema, /\('reachjulian',\s*'Reach Julian'\)/);
});
