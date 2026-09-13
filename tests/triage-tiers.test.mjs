// Three tiers: customer, bulk, spam. Gmail's SPAM label routes to 'spam' and
// ONLY there; it adds nothing to the bulk score. Our own reply history (and
// the owner-verified known-customer list) beats Gmail's spam judgment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/lib/triage.ts';
import { KNOWN_CUSTOMERS, knownCustomerSet } from '../src/lib/known-customers.ts';

const none = () => ({ everRepliedTo: new Set(), markedReal: new Set(), markedSpam: new Set() });
const msg = (over = {}) => ({
  from: 'Dana Reyes <dana@example.com>', subject: 'Sauna heater tripping the breaker',
  headers: {}, labelIds: ['INBOX'], ...over,
});
const codes = (v) => v.signals.map((s) => s.code).sort();
const BULK_HEADERS = { 'list-unsubscribe': '<mailto:u@brand.example>' };

// --- the four cases ------------------------------------------------------------

test('neither spam nor bulk -> customer', () => {
  const v = classify(msg(), none());
  assert.equal(v.tier, 'customer');
  assert.equal(v.demote, false);
  assert.deepEqual(codes(v), []);
});

test('bulk only -> bulk', () => {
  const v = classify(msg({ from: 'Brand <news@brand.example>', headers: BULK_HEADERS, labelIds: ['CATEGORY_PROMOTIONS'] }), none());
  assert.equal(v.tier, 'bulk');
  assert.equal(v.demote, true);
  assert.equal(v.score, 4);
  assert.deepEqual(codes(v), ['gmail_promo', 'list_unsubscribe']);
});

test('spam only -> spam, with no bulk score', () => {
  const v = classify(msg({ from: 'Prize <win@prize.example>', labelIds: ['SPAM'] }), none());
  assert.equal(v.tier, 'spam');
  assert.equal(v.demote, true);
  assert.equal(v.score, 0);
  assert.deepEqual(codes(v), ['gmail_spam']);
});

test('spam AND bulk -> spam (bulk reasons still carried)', () => {
  const v = classify(msg({ from: 'Brand <news@brand.example>', headers: BULK_HEADERS, labelIds: ['SPAM', 'CATEGORY_PROMOTIONS'] }), none());
  assert.equal(v.tier, 'spam');
  assert.equal(v.score, 4, 'bulk score counts only bulk signals');
  assert.deepEqual(codes(v), ['gmail_promo', 'gmail_spam', 'list_unsubscribe']);
});

test("the SPAM label contributes nothing to the bulk score", () => {
  // list_id alone (weight 1) is below the bulk threshold with or without SPAM.
  const withSpam = classify(msg({ headers: { 'list-id': '<x.list>' }, labelIds: ['SPAM'] }), none());
  const without = classify(msg({ headers: { 'list-id': '<x.list>' } }), none());
  assert.equal(withSpam.score, without.score);
  assert.equal(without.tier, 'customer');
  assert.equal(withSpam.tier, 'spam');
  assert.ok(withSpam.signals.find((s) => s.code === 'gmail_spam').weight === 0);
});

test('an agent-marked spam sender -> spam', () => {
  const ex = none(); ex.markedSpam.add('win@prize.example');
  const v = classify(msg({ from: 'Prize <win@prize.example>' }), ex);
  assert.equal(v.tier, 'spam');
});

// --- reply history and known customers beat Gmail's spam judgment ----------------

test('a sender we have replied to before is customer even with Gmail SPAM and bulk signals', () => {
  const ex = none(); ex.everRepliedTo.add('priya@acme.example');
  const v = classify(msg({ from: 'Priya <Priya@acme.example>', headers: BULK_HEADERS, labelIds: ['SPAM', 'CATEGORY_PROMOTIONS'] }), ex);
  assert.equal(v.tier, 'customer');
  assert.equal(v.demote, false);
  assert.equal(v.exemptReason, 'we have replied to this sender before');
});

// Real case (round 5 run, verified by hand by the owner): a genuine customer
// whose message Gmail misfiled as spam.
const REAL_CASE = msg({
  from: 'A Customer <verified.customer@example.com>',
  subject: 'Track A Shipment - Priority1 for A Customer',
  labelIds: ['SPAM'],
});

test('real case: verified.customer@example.com with Gmail SPAM is customer via the known-customer list', () => {
  assert.ok(KNOWN_CUSTOMERS.some((k) => k.address === 'verified.customer@example.com'));
  const ex = { ...none(), knownCustomers: knownCustomerSet() };
  const v = classify(REAL_CASE, ex);
  assert.equal(v.tier, 'customer');
  assert.equal(v.exemptReason, 'owner verified this sender as a customer');
});

test('real case without the exemption would be spam: the exemption is what saves it', () => {
  assert.equal(classify(REAL_CASE, none()).tier, 'spam');
});

test('known-customer addresses are matched case-insensitively', () => {
  const ex = { ...none(), knownCustomers: knownCustomerSet() };
  assert.equal(classify({ ...REAL_CASE, from: 'Dennis <verified.customer@example.com>' }, ex).tier, 'customer');
});
