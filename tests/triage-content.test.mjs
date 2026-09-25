// Phone triage (round 14): a voicemail transcript or a text is content, not
// headers, so the email signals in classify() can't see it. These are Julian's
// two rules for this line, measured against 50 real voicemail transcripts with
// prove/quo-calls.mjs before being written (counts only; the transcripts stay
// on his machine):
//   "google listing"      28/50  (the robocall campaign; 48 distinct caller numbers)
//   "google verification"  0/50  in this window, but it is a rule he has seen fire
// Every text here is fabricated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyContent } from '../src/lib/triage.ts';

const tier = (text) => classifyContent(text).tier;
const codes = (text) => classifyContent(text).signals.map((s) => s.code);

test('a voicemail about a Google listing is spam', () => {
  for (const text of [
    'Hi, this is Amanda calling about your Google listing. Press 1 to speak with a specialist.',
    "We noticed your Google business listing has not been claimed. Press 1.",
    'Your listing on Google is about to expire. Press one to renew.',
    'THIS IS A COURTESY CALL REGARDING YOUR GOOGLE LISTING',
  ]) {
    assert.equal(tier(text), 'spam', text);
    assert.ok(codes(text).includes('google_listing'), text);
  }
});

test('a voicemail about Google verification is spam too', () => {
  for (const text of [
    'Calling about the Google verification for your business. Press 1.',
    'Your verification with Google is incomplete.',
  ]) {
    assert.equal(tier(text), 'spam', text);
    assert.ok(codes(text).includes('google_verification'), text);
  }
});

test('a real customer who mentions Google in another context is NOT spam', () => {
  for (const text of [
    'Hi, I found your number on Google. My chiller is leaking and I need someone out today.',
    'Google says you close at six, is that right? Can you verify my order number 4021 before I drive over?',
    // Same sentence, both words: this is why the rule is the noun "verification"
    // and not "verify". A customer saying this must never be demoted.
    'I found you on Google and I need to verify my order before Friday.',
    'I need to verify my refund went through. Please call me back.',
    'Your listing price on the website seems wrong, can you check?',
    'Hello, this is Rosa. Calling back about the pump.',
  ]) {
    assert.equal(tier(text), 'customer', text);
    assert.deepEqual(codes(text), [], text);
  }
});

test('the verdict carries its reason to the UI, and never counts as a bulk signal', () => {
  const v = classifyContent('About your Google listing, press 1.');
  assert.equal(v.demote, true);
  assert.equal(v.score, 0, 'content spam is the spam tier, never a bulk score');
  assert.deepEqual(v.signals.map((s) => s.weight), [0]);
  assert.match(v.signals[0].why, /listing/i);
});

test('no content, or content with no rule, is left alone in Needs reply', () => {
  for (const text of [null, undefined, '', '   ', 'Missed call, no voicemail']) {
    const v = classifyContent(text);
    assert.equal(v.tier, 'customer');
    assert.equal(v.demote, false);
    assert.deepEqual(v.signals, []);
  }
});
