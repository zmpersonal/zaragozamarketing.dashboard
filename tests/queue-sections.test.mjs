// The queue renders three sections: needs reply, probably not customers, and
// spam at the bottom with a count. Nothing is hidden in any of them, and the
// spam list is plain enough to scan: sender and full subject, no click needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sectionThreads, renderSection, reasonCodes } from '../public/queue-sections.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const t = (id, triage, extra = {}) => ({
  id, triage, subject: `Subject ${id}`, customer_name: `Name ${id}`, customer_handle: `${id}@example.com`,
  triage_signals: null, awaiting_since: 1789480800, conversation_started_at: 1789480800, status: 'waiting', ...extra,
});

test('three sections in order: needs reply, probably not customers, spam last', () => {
  const s = sectionThreads([t('a', 'spam'), t('b', 'bulk'), t('c', 'customer')]);
  assert.deepEqual(s.map((x) => [x.tier, x.title]), [
    ['customer', 'Needs reply'], ['bulk', 'Probably not customers'], ['spam', 'Spam'],
  ]);
});

test('nothing is hidden: every thread appears in exactly one section, unknown tiers count as needs reply', () => {
  const input = [t('a', 'spam'), t('b', 'bulk'), t('c', 'customer'), t('d', undefined), t('e', 'not_customer_legacy')];
  const s = sectionThreads(input);
  const ids = s.flatMap((x) => x.threads.map((y) => y.id)).sort();
  assert.deepEqual(ids, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(s[0].threads.map((y) => y.id).sort(), ['c', 'd', 'e']);
});

test('spam section: header shows the count, every row shows sender and the FULL subject, escaped', () => {
  const long = 'Refund Request – Order #467740987 for the chiller I bought last month <urgent>';
  assert.ok(long.length > 50);
  const spam = [
    t('s1', 'spam', { customer_name: 'Maybe Real', customer_handle: 'admin@refund-desk.example', subject: long }),
    t('s2', 'spam', { customer_name: 'Prize Desk', customer_handle: 'win@prize.example', subject: 'You have won' }),
  ];
  const html = renderSection(sectionThreads(spam).find((x) => x.tier === 'spam'), esc);
  assert.match(html, /Spam[^<]*\(2\)|Spam<\/[^>]+>\s*<[^>]+>2</);
  assert.ok(html.includes('admin@refund-desk.example'));
  assert.ok(html.includes(esc(long)), 'subject shown in full, never truncated');
  assert.ok(!html.includes('<urgent>'), 'subject is escaped');
  assert.ok(html.includes('win@prize.example') && html.includes('You have won'));
});

test('spam section is never collapsed or obscured: no click needed to see the list', () => {
  const html = renderSection(sectionThreads([t('s1', 'spam')]).find((x) => x.tier === 'spam'), esc);
  assert.doesNotMatch(html, /<details|hidden|display:\s*none|aria-expanded="false"|visibility:\s*hidden|<button/i);
  assert.ok(html.includes('s1@example.com') && html.includes('Subject s1'));
});

test('an empty spam section still renders its header with a zero count', () => {
  const html = renderSection(sectionThreads([t('c', 'customer')]).find((x) => x.tier === 'spam'), esc);
  assert.match(html, /Spam/);
  assert.match(html, /\(0\)|>0</);
});

test('bulk rows carry their reason codes', () => {
  const b = t('b1', 'bulk', { triage_signals: JSON.stringify([{ code: 'list_unsubscribe', why: 'has a List-Unsubscribe header' }, { code: 'gmail_promo', why: 'Gmail filed it under Promotions' }]) });
  assert.deepEqual(reasonCodes(b), ['list_unsubscribe', 'gmail_promo']);
  const html = renderSection(sectionThreads([b]).find((x) => x.tier === 'bulk'), esc);
  assert.ok(html.includes('list_unsubscribe') && html.includes('gmail_promo'));
});

test('reasonCodes tolerates missing or malformed signals', () => {
  assert.deepEqual(reasonCodes({ triage_signals: null }), []);
  assert.deepEqual(reasonCodes({ triage_signals: 'not json' }), []);
});

test('/api/queue returns triage and its reasons for every open thread, spam included', async () => {
  const { default: worker } = await import('../src/index.ts');
  const { makeApiEnv, withAccess, mintToken, apiRequest, insertThread, OWNER } = await import('./helpers/access.mjs');
  const env = makeApiEnv();
  insertThread(env, { id: 'gmail:c' });
  insertThread(env, { id: 'gmail:s' });
  env.DB.raw.prepare(`UPDATE thread SET triage = 'spam', triage_signals = ? WHERE id = 'gmail:s'`)
    .run(JSON.stringify([{ code: 'gmail_spam', why: 'Gmail marked it as spam' }]));
  const res = await withAccess(async () => worker.fetch(apiRequest('queue', { token: await mintToken({ email: OWNER }) }), env));
  const threads = (await res.json()).threads;
  const byId = Object.fromEntries(threads.map((x) => [x.id, x]));
  assert.equal(byId['gmail:c'].triage, 'customer');
  assert.equal(byId['gmail:s'].triage, 'spam');
  assert.deepEqual(reasonCodes(byId['gmail:s']), ['gmail_spam']);
});
