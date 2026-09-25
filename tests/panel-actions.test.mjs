// The detail panel's two new controls (round 15): who a thread is assigned to,
// and what the agent can do about a bulk sender. Pure builders, escaped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assigneeHtml, unsubscribeHtml, esc } from '../public/render.mjs';

const AGENTS = ['julian@inhousewellness.com', 'marianne@inhousewellness.com', 'charlie@inhousewellness.com'];

test('the picker lists the people, by first name, with the current one selected', () => {
  const html = assigneeHtml({ agents: AGENTS, assignee: 'marianne@inhousewellness.com' }, esc);
  assert.match(html, /<option value="marianne@inhousewellness\.com" selected>Marianne<\/option>/);
  assert.match(html, /Julian/);
  assert.match(html, /Charlie/);
  assert.match(html, /<option value="" >Unassigned<\/option>|<option value="">Unassigned<\/option>/);
});

test('an assignee who is no longer in the list is still shown, not silently dropped', () => {
  const html = assigneeHtml({ agents: AGENTS, assignee: 'someone.who.left@inhousewellness.com' }, esc);
  assert.match(html, /someone\.who\.left@inhousewellness\.com/);
  assert.match(html, /selected/);
});

test('with nobody configured the picker says so instead of offering an empty list', () => {
  const html = assigneeHtml({ agents: [], assignee: null }, esc);
  assert.doesNotMatch(html, /<select/);
  assert.match(html, /AGENTS|nobody|not configured/i);
});

test('a hostile address cannot break out of the option', () => {
  const html = assigneeHtml({ agents: ['"><script>bad()</script>@x.com'], assignee: null }, esc);
  assert.doesNotMatch(html, /<script>bad/);
  assert.match(html, /&lt;script&gt;/);
});

test('an https unsubscribe is a link the agent clicks, and says where it goes', () => {
  const html = unsubscribeHtml({ url: 'https://example.com/u/abc', mailto: null, one_click: false }, esc);
  assert.match(html, /href="https:\/\/example\.com\/u\/abc"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /example\.com/, 'the sender is named, so the agent knows what they are opening');
});

test('mailto-only says plainly that it cannot be sent from here', () => {
  const html = unsubscribeHtml({ url: null, mailto: 'mailto:u@example.com', one_click: false }, esc);
  assert.match(html, /mailto:u@example\.com/);
  assert.match(html, /your own mail|not from support@|cannot send/i);
});

test('one-click is mentioned as a fact, not offered as a button', () => {
  const html = unsubscribeHtml({ url: 'https://example.com/u/abc', mailto: null, one_click: true }, esc);
  assert.match(html, /one-click/i);
  assert.doesNotMatch(html, /<button/i, 'this console never posts an unsubscribe on the mailbox’s behalf');
});

test('no header, or a header with nothing usable, renders nothing at all', () => {
  assert.equal(unsubscribeHtml(null, esc), '');
  assert.equal(unsubscribeHtml({ url: null, mailto: null, one_click: false }, esc), '');
});

test('a javascript: URL that survived storage is never rendered as a link', () => {
  const html = unsubscribeHtml({ url: 'javascript:alert(1)', mailto: null, one_click: false }, esc);
  assert.doesNotMatch(html, /href="javascript:/);
});
