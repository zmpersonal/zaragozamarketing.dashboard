// The admin view's HTML (round 15). Pure builders, so the numbers can be tested
// without a DOM, and every value that came from a customer or a provider goes
// through esc (invariant 9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportHtml, businessDuration } from '../public/report-view.mjs';
import { esc } from '../public/render.mjs';

const base = {
  days: 30, recent_days: 7, bucket_minutes: [120, 480, 1440],
  channels: [
    { channel: 'email', median_business_minutes: 95, answered: 12 },
    { channel: 'phone', median_business_minutes: 6, answered: 40 },
    { channel: 'all', median_business_minutes: 20, answered: 52 },
  ],
  outstanding: {
    email: { under_2h: 2, h2_8: 1, h8_24: 0, over_24h: 3, total: 6 },
    all: { under_2h: 2, h2_8: 1, h8_24: 0, over_24h: 3, total: 6 },
  },
  recent: [{
    thread_id: 'gmail:abc', channel: 'email', subject: 'Heater tripping the breaker',
    customer_name: 'A Person', customer_handle: 'a.person@example.com',
    responded_at: 1789480800, business_minutes: 95, via: 'replied', actor: 'dana@inhousewellness.com',
    action_kind: 'replied', action_body: 'Sent the replacement gasket.', link: 'https://mail.google.com/mail/u/support@inhousewellness.com/#all/abc',
  }],
};

test('business durations read as time, not as a number of minutes', () => {
  assert.equal(businessDuration(0), '0m');
  assert.equal(businessDuration(6), '6m');
  assert.equal(businessDuration(95), '1h 35m');
  assert.equal(businessDuration(480), '1 working day');
  assert.equal(businessDuration(1440), '3 working days');
  assert.equal(businessDuration(null), '—');
});

test('the medians and counts are shown per channel, and labelled business time', () => {
  const html = reportHtml(base, esc);
  assert.match(html, /1h 35m/);
  assert.match(html, /6m/);
  assert.match(html, /12/);
  assert.match(html, /business/i, 'never leaves the reader thinking it is wall-clock');
  assert.match(html, /median/i);
});

test('outstanding is shown as buckets, with the oldest called out', () => {
  const html = reportHtml(base, esc);
  assert.match(html, /over 24/i);
  assert.match(html, /3/);
  assert.doesNotMatch(html, /Outstanding: 6<\/div>/, 'not a single number');
});

test('the recent list carries the agent, what they said, and a link to the real thread', () => {
  const html = reportHtml(base, esc);
  assert.match(html, /Sent the replacement gasket\./);
  assert.match(html, /dana/);
  assert.match(html, /href="https:\/\/mail\.google\.com\/mail\/u\/support@inhousewellness\.com\/#all\/abc"/);
  assert.match(html, /rel="noopener noreferrer"/, 'a provider link opens without handing over this page');
});

test('a wait ingest measured, with nothing logged, says so instead of showing a blank', () => {
  const html = reportHtml({ ...base, recent: [{ ...base.recent[0], action_kind: null, action_body: null, actor: 'system', via: 'message' }] }, esc);
  assert.match(html, /replied in Gmail|no note/i);
});

test('nothing from a customer or a provider reaches the DOM as markup', () => {
  const hostile = {
    ...base,
    recent: [{
      ...base.recent[0],
      subject: '<img src=x onerror=alert(1)>',
      customer_name: '<script>bad()</script>',
      action_body: '</div><svg onload=alert(2)>',
      actor: '"><b>x</b>',
      link: 'javascript:alert(3)',
    }],
  };
  const html = reportHtml(hostile, esc);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>bad/);
  assert.doesNotMatch(html, /<svg onload/);
  assert.doesNotMatch(html, /href="javascript:/, 'only http(s) links are rendered');
  assert.match(html, /&lt;img src=x/);
});

test('an empty period says there is nothing, not zero minutes', () => {
  const html = reportHtml({ ...base, channels: [{ channel: 'all', median_business_minutes: null, answered: 0 }], outstanding: { all: { under_2h: 0, h2_8: 0, h8_24: 0, over_24h: 0, total: 0 } }, recent: [] }, esc);
  assert.match(html, /—|nothing/i);
  assert.doesNotMatch(html, /NaN|undefined|null/);
});
