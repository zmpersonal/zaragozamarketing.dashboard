// Deep links into the provider (round 15). The admin report is for reading how
// something was answered, which means opening the real thread. The Quo shape is
// the documented one (my.quo.com/inbox/PN123/c/CN123, from the 2026-03-30
// webhook payload docs); Gmail's is the mailbox-scoped #all search, so an
// archived or spam-filed thread still opens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threadLink } from '../src/lib/links.ts';

const gmail = { id: 'gmail:18f2c1a9b', channel: 'email' };
const quo = { id: 'quo:CN123abc', channel: 'phone' };

test('a Gmail thread opens in the right mailbox, including archived and spam', () => {
  const url = threadLink(gmail, 'support@inhousewellness.com');
  assert.equal(url, 'https://mail.google.com/mail/u/support@inhousewellness.com/#all/18f2c1a9b');
});

test('a Quo conversation opens on its own number', () => {
  assert.equal(threadLink(quo, 'PN8WZAnkxN'), 'https://my.quo.com/inbox/PN8WZAnkxN/c/CN123abc');
});

test('no source address, unknown provider or a malformed id gives no link, never a broken one', () => {
  assert.equal(threadLink(gmail, null), null);
  assert.equal(threadLink(quo, null), null);
  assert.equal(threadLink({ id: 'tidio:abc', channel: 'chat' }, 'widget'), null);
  assert.equal(threadLink({ id: 'gmail:', channel: 'email' }, 'support@inhousewellness.com'), null);
  assert.equal(threadLink({ id: 'nocolon', channel: 'email' }, 'support@inhousewellness.com'), null);
});

test('nothing from the id or the address can escape the URL', () => {
  const hostile = threadLink({ id: 'gmail:a b"><script>', channel: 'email' }, 'support@inhousewellness.com');
  assert.doesNotMatch(hostile ?? '', /[<>"' ]/);
  // A source address that isn't the documented shape gets no link at all.
  assert.equal(threadLink({ id: 'quo:CN1', channel: 'phone' }, 'PN1?evil=1#x'), null);
  assert.equal(threadLink(gmail, 'not an address'), null);
  assert.equal(threadLink({ id: 'quo:CN1', channel: 'phone' }, 'PN1'), 'https://my.quo.com/inbox/PN1/c/CN1');
});
