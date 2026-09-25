// List-Unsubscribe (round 15), measured on the real mailbox with
// prove/unsubscribe.mjs: 76 of 297 threads in 30 days carry the header,
// 0 of them are mailto-only, 49 are https-only, 27 carry both, and 63 of the 76
// advertise RFC 8058 one-click. So every thread that has the header has
// something an agent can click.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnsubscribe } from '../src/lib/unsubscribe.ts';

test('an https URL is offered as a link', () => {
  const u = parseUnsubscribe('<https://example.com/u/abc123>');
  assert.equal(u.url, 'https://example.com/u/abc123');
  assert.equal(u.mailto, null);
  assert.equal(u.one_click, false);
});

test('both forms: the link wins, and the mailto is kept as the fallback', () => {
  const u = parseUnsubscribe('<mailto:unsub@example.com?subject=unsubscribe>, <https://example.com/u/abc>');
  assert.equal(u.url, 'https://example.com/u/abc');
  assert.equal(u.mailto, 'mailto:unsub@example.com?subject=unsubscribe');
});

test('mailto only, which is the case an agent cannot resolve from the console', () => {
  const u = parseUnsubscribe('<mailto:unsub@example.com>');
  assert.equal(u.url, null);
  assert.equal(u.mailto, 'mailto:unsub@example.com');
});

test('one-click is reported, never performed', () => {
  const u = parseUnsubscribe('<https://example.com/u/abc>', 'List-Unsubscribe=One-Click');
  assert.equal(u.one_click, true);
  assert.equal(u.url, 'https://example.com/u/abc');
  assert.equal(Object.keys(u).sort().join(), 'mailto,one_click,url', 'nothing that looks like an action');
});

test('anything that is not http(s) or mailto is dropped', () => {
  for (const header of [
    '<javascript:alert(1)>',
    '<data:text/html,hi>',
    '<ftp://example.com/u>',
    '<file:///etc/passwd>',
    'https://example.com/no-angle-brackets',
    '',
    '   ',
  ]) {
    const u = parseUnsubscribe(header);
    assert.equal(u.url, null, header);
    assert.equal(u.mailto, null, header);
  }
});

test('a javascript: URL hidden behind a valid one is still dropped', () => {
  const u = parseUnsubscribe('<javascript:alert(1)>, <https://example.com/u/abc>');
  assert.equal(u.url, 'https://example.com/u/abc');
});

test('null, undefined and nonsense are the same as no header', () => {
  for (const header of [null, undefined, 42, {}]) {
    assert.deepEqual(parseUnsubscribe(header), { url: null, mailto: null, one_click: false });
  }
});

test('an http URL is accepted but reported as it is, not upgraded', () => {
  assert.equal(parseUnsubscribe('<http://example.com/u/abc>').url, 'http://example.com/u/abc');
});
