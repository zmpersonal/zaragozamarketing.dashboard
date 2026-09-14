// Bugs found running the real UI against the API on a local D1 (round 11):
//   1. The brand matrix said "clear" when the board failed to load, when the
//      channel's sync was stale, and for chat, which has no source at all; the
//      to-do panel said "Nothing on the list" when to-dos failed to load.
//   2. The 60-second refresh reloaded every tier from the first page, collapsing
//      any "Show 50 more" the agent had opened.
//   3. The "Blocked on" field was always visible: CSS display overrode [hidden].
//   4. /api/todos returned at most 100 rows with no total, so a new to-do could
//      be invisible: the round-8 queue bug, again, in the to-do list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/index.ts';
import { matrixCellView, todoListStatusHtml } from '../public/render.mjs';
import { reloadLoadedPages } from '../public/paging.mjs';
import { makeApiEnv, withAccess, mintToken, OWNER } from './helpers/access.mjs';

const NOW = 1789480800;
const H = 3600;
const email = (last) => ({ id: 'gmail:support@inhousewellness.com', brand_id: 'inhouse', provider: 'gmail', channel: 'email', address: 'support@inhousewellness.com', last_synced_at: last });

// --- 1. nothing says "clear" unless it was checked ---------------------------------------

test('matrix cell: "clear" only when the board loaded and the channel synced recently', () => {
  const base = { brand: 'inhouse', count: 0, oldestLabel: null, now: NOW, loaded: true };
  assert.deepEqual(matrixCellView({ ...base, channel: 'email', sources: [email(NOW - 600)] }), { count: '—', note: 'clear', tone: 'fresh' });
  assert.deepEqual(matrixCellView({ ...base, channel: 'email', sources: [email(NOW - 13 * H)] }), { count: '—', note: 'not verified: synced 13 h ago', tone: 'error' });
  assert.deepEqual(matrixCellView({ ...base, channel: 'email', sources: [email(NOW - 4 * H)] }), { count: '—', note: 'not verified: synced 4 h ago', tone: 'warning' });
  assert.deepEqual(matrixCellView({ ...base, channel: 'chat', sources: [email(NOW - 60)] }), { count: '—', note: 'not connected', tone: 'none' });
  // Found on the second pass: THI's email cell said "clear" because InHouse's mailbox was fresh.
  assert.deepEqual(matrixCellView({ ...base, brand: 'thi', channel: 'email', sources: [email(NOW - 60)] }), { count: '—', note: 'not connected', tone: 'none' });
  assert.deepEqual(matrixCellView({ ...base, channel: 'email', sources: [email(NOW - 600)], loaded: false }), { count: '?', note: 'not loaded', tone: 'error' });
  assert.deepEqual(matrixCellView({ ...base, count: 3, oldestLabel: '5h', channel: 'email', sources: [email(NOW - 600)] }), { count: '3', note: 'oldest 5h', tone: 'fresh' });
});

test('to-do panel: an error or an unloaded list never reads as "nothing on the list"', () => {
  assert.match(todoListStatusHtml({ loaded: true, error: null, shown: 0, total: 0 }), /Nothing on the list/);
  const failed = todoListStatusHtml({ loaded: false, error: '500 boom <b>', shown: 0, total: 0 });
  assert.match(failed, /Could not load to-dos/);
  assert.ok(!failed.includes('<b>'));
  assert.doesNotMatch(failed, /Nothing on the list/);
  assert.match(todoListStatusHtml({ loaded: true, error: null, shown: 100, total: 101 }), /Showing 100 of 101[\s\S]*data-more-todos/);
  assert.equal(todoListStatusHtml({ loaded: true, error: null, shown: 5, total: 5 }), '');
});

// --- 2. refresh keeps what the agent has opened ----------------------------------------------

test('a refresh re-fetches as many pages as are already loaded, not just the first', async () => {
  const calls = [];
  const fetchPage = async (offset) => { calls.push(offset); return { threads: Array.from({ length: offset < 100 ? 50 : 7 }, (_, i) => ({ id: `t${offset + i}` })), total: 157 }; };
  const r = await reloadLoadedPages(fetchPage, 150, 50);
  assert.deepEqual(calls, [0, 50, 100]);
  assert.equal(r.threads.length, 107);
  assert.equal(r.total, 157);
  const first = await reloadLoadedPages(async (o) => { calls.push(o); return { threads: [{ id: 'a' }], total: 1 }; }, 0, 50);
  assert.equal(first.threads.length, 1, 'nothing loaded yet: the first page');
});

// --- 3. [hidden] hides --------------------------------------------------------------------------

test('the page CSS lets the hidden attribute win over display rules', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
});

// --- 4. to-dos are paged, with a total ---------------------------------------------------------

async function todos(env, query = '') {
  const token = await mintToken({ email: OWNER });
  const res = await withAccess(() => worker.fetch(new Request(`https://console.example/api/todos${query}`, { headers: { 'Cf-Access-Jwt-Assertion': token } }), env));
  return res.json();
}

test('/api/todos reports the total and pages; a new undated to-do is on the first page', async () => {
  const env = makeApiEnv();
  const ins = env.DB.raw.prepare(`INSERT INTO todo (brand_id, title, assignee, due_at, created_by, created_at) VALUES ('inhouse', ?, ?, ?, ?, ?)`);
  for (let i = 0; i < 60; i++) ins.run(`dated ${i}`, OWNER, NOW + i * H, OWNER, NOW - 1000 + i);
  for (let i = 0; i < 90; i++) ins.run(`undated ${i}`, OWNER, null, OWNER, NOW - 5000 + i);
  ins.run('just added', OWNER, null, OWNER, NOW);
  const first = await todos(env);
  assert.equal(first.total, 151);
  assert.equal(first.todos.length, 100);
  assert.equal(first.todos[0].title, 'dated 0', 'dated to-dos first, soonest due first');
  assert.equal(first.todos[60].title, 'just added', 'then undated, newest first');
  const second = await todos(env, '?offset=100');
  assert.equal(second.todos.length, 51);
  assert.equal(new Set([...first.todos, ...second.todos].map((t) => t.id)).size, 151);
});
