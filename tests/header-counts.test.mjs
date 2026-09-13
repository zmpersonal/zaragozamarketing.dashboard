// Header counts ("N open", "past 24 hours", per-brand cells, board API) count
// Needs-reply threads only. Bulk and spam each keep their own count inside
// their own section, and are never hidden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headerCounts, brandCell, sectionThreads } from '../public/queue-sections.mjs';
import worker from '../src/index.ts';
import { makeApiEnv, withAccess, mintToken, apiRequest, insertThread, OWNER } from './helpers/access.mjs';

const NOW = 1789480800;
const H = 3600;
const t = (id, triage, hoursAgo, extra = {}) => ({
  id, triage, brand_id: 'inhouse', channel: 'email', status: 'waiting', awaiting_since: NOW - hoursAgo * H,
  conversation_started_at: NOW - hoursAgo * H, subject: id, ...extra,
});
const THREADS = [
  t('c1', 'customer', 2), t('c2', 'customer', 30), t('b1', 'bulk', 50), t('b2', 'bulk', 60),
  t('s1', 'spam', 70), t('s2', 'spam', 80), t('s3', 'spam', 90),
  t('p1', 'customer', 1, { channel: 'phone' }),
];

test('header counts: open and past-24h count Needs-reply only', () => {
  assert.deepEqual(headerCounts(THREADS, NOW), { open: 3, over24h: 1 });
});

test('per-brand cell: count and oldest are Needs-reply only', () => {
  assert.deepEqual(brandCell(THREADS, 'inhouse', 'email'), { count: 2, oldest: NOW - 30 * H });
  assert.deepEqual(brandCell(THREADS, 'inhouse', 'phone'), { count: 1, oldest: NOW - 1 * H });
  assert.deepEqual(brandCell([t('s', 'spam', 5)], 'inhouse', 'email'), { count: 0, oldest: null });
});

test('bulk and spam keep their own counts in their own sections', () => {
  const s = Object.fromEntries(sectionThreads(THREADS).map((x) => [x.tier, x.threads.length]));
  assert.deepEqual(s, { customer: 3, bulk: 2, spam: 3 });
});

test('/api/board counts and oldest exclude bulk and spam', async () => {
  const env = makeApiEnv();
  const rows = [['gmail:c', 'customer', 10], ['gmail:b', 'bulk', 100], ['gmail:s', 'spam', 200]];
  for (const [id, triage, hoursAgo] of rows) {
    insertThread(env, { id, awaiting_since: NOW - hoursAgo * H, started: NOW - hoursAgo * H });
    env.DB.raw.prepare('UPDATE thread SET triage = ? WHERE id = ?').run(triage, id);
  }
  const res = await withAccess(async () => worker.fetch(apiRequest('board', { token: await mintToken({ email: OWNER }) }), env));
  const { board } = await res.json();
  assert.equal(board.length, 1);
  assert.equal(board[0].waiting, 1);
  assert.equal(board[0].oldest_at, NOW - 10 * H);
});
