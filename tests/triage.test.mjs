// Hand-verified triage cases. These must keep passing.
// Run with `npm test` (node:test; Node strips the types from the .ts import).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/lib/triage.ts';

const noExemptions = () => ({
  everRepliedTo: new Set(),
  markedReal: new Set(),
  markedSpam: new Set(),
});

const msg = (over = {}) => ({
  from: 'Dana Reyes <dana@example.com>',
  subject: 'Sauna heater tripping the breaker',
  headers: {},
  labelIds: ['INBOX'],
  ...over,
});

const codes = (v) => v.signals.map((s) => s.code);

test('plain customer email, no signals -> NOT demoted', () => {
  const v = classify(msg(), noExemptions());
  assert.equal(v.demote, false);
  assert.deepEqual(codes(v), []);
});

test('noreply@shopify.com with CATEGORY_UPDATES -> demoted on noreply, NOT on Updates', () => {
  const v = classify(
    msg({ from: 'Shopify <noreply@shopify.com>', subject: 'Order #1042 confirmed',
          labelIds: ['INBOX', 'CATEGORY_UPDATES'] }),
    noExemptions(),
  );
  assert.equal(v.demote, true);
  assert.deepEqual(codes(v), ['noreply']);
  // The demotion must stand on the noreply signal alone.
  assert.ok(!v.signals.some((s) => /update/i.test(s.code) || /update/i.test(s.why)),
    'Updates category must not contribute a signal');
});

test('newsletter with List-Unsubscribe + CATEGORY_PROMOTIONS -> demoted', () => {
  const v = classify(
    msg({ from: 'Brand Weekly <news@brand.example>', subject: 'This week only',
          headers: { 'list-unsubscribe': '<mailto:unsub@brand.example>' },
          labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] }),
    noExemptions(),
  );
  assert.equal(v.demote, true);
  assert.ok(codes(v).includes('list_unsubscribe'));
  assert.ok(codes(v).includes('gmail_promo'));
});

test('sender in everRepliedTo -> NOT demoted even with List-Unsubscribe', () => {
  const ex = noExemptions();
  ex.everRepliedTo.add('priya@acme.example');
  const v = classify(
    msg({ from: 'Priya Raman <Priya@Acme.example>',
          headers: { 'list-unsubscribe': '<https://acme.example/unsub>' } }),
    ex,
  );
  assert.equal(v.demote, false);
  assert.equal(v.exemptReason, 'we have replied to this sender before');
});

test('CATEGORY_UPDATES alone, no other signal -> NOT demoted', () => {
  const v = classify(
    msg({ from: 'Carrier <tracking@carrier.example>', subject: 'Your pallet is out for delivery',
          labelIds: ['INBOX', 'CATEGORY_UPDATES'] }),
    noExemptions(),
  );
  assert.equal(v.demote, false);
  assert.deepEqual(codes(v), []);
});

// --- no-reply rule: the pattern anywhere in the local part (round 5) ------------

for (const from of [
  'Google Calendar <no-reply-calendar@google.com>',
  'LinkedIn <notifications-noreply@linkedin.com>',
  'Apps Script <noreply-apps-scripts-notifications@google.com>',
  'Google Workspace <workspace-noreply@google.com>',
  // Separators between the words: hyphen, underscore, dot, or nothing (round 6).
  'TestFlight <testflight_no_reply@email.apple.com>',
  'Store <no.reply@shop.example>',
  'Billing <do_not_reply@billing.example>',
  'Alerts <do.not.reply@alerts.example>',
  'Ops <mailer_daemon@mx.example>',
]) {
  test(`no-reply pattern inside the local part is demoted on noreply: ${from}`, () => {
    const v = classify(msg({ from, subject: 'Notification' }), noExemptions());
    assert.equal(v.demote, true);
    assert.deepEqual(codes(v), ['noreply']);
  });
}

for (const from of [
  'Sarah Kreplin <sarah.kreplin@example.com>',       // "rep" inside a real surname
  'Sauna Repairs <repairs@saunarepair.example>',   // "rep" as a word
  'Reply Guy <replyguy.jones@example.com>',          // "reply" without "no"
  'Noah Replyman <noah.replyman@example.com>',       // "no" and "reply" apart, more than one separator
]) {
  test(`a real person whose address merely contains "rep"/"reply" is NOT flagged: ${from}`, () => {
    const v = classify(msg({ from }), noExemptions());
    assert.equal(v.demote, false);
    assert.deepEqual(codes(v), []);
  });
}

test('the no-reply rule only reads the local part, not the domain', () => {
  const v = classify(msg({ from: 'Dana <dana@noreply-domain.example>' }), noExemptions());
  assert.deepEqual(codes(v), []);
});

test('prove/triage.mjs uses the same no-reply pattern as src/lib/triage.ts', async () => {
  const { readFileSync } = await import('node:fs');
  const grab = (file) => {
    const text = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    const m = text.match(/const NOREPLY = (\/.+\/[a-z]*);/);
    assert.ok(m, `${file} defines const NOREPLY = /.../`);
    return m[1];
  };
  assert.equal(grab('prove/triage.mjs'), grab('src/lib/triage.ts'));
});
