// prove/ingest-live.mjs runs the real ingest code against a mailbox into a
// local database file (outside the repo) and reports counts. Its job in round 7:
// the owner moves a junk message to Trash by hand, the check re-runs, and it
// must show that the next incremental run noticed the move and the thread is
// still ingested (triage never hides mail; trash is part of the population).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveIngest, formatReport } from '../prove/_ingest-live.mjs';
import { withGmail, inbound, SERVICE_ACCOUNT_JSON, MAILBOX } from './helpers/gmail.mjs';
import { GMAIL_LIMITS } from '../src/ingest/gmail.ts';

const DAY = 86400_000;
const ago = (days) => new Date(Math.floor((Date.now() - days * DAY) / 1000) * 1000).toISOString();
const ROOT = new URL('..', import.meta.url).pathname;

function mailbox() {
  const threads = {};
  for (let i = 0; i < GMAIL_LIMITS.threadsPerRun + 7; i++) threads[`c${i}`] = [inbound(ago(1 + (i % 20)), `C${i} <c${i}@example.com>`, `Order question ${i}`)];
  threads.junk = [inbound(ago(2), 'Deals <deals@junk.example>', 'Limited time offer for c0@example.com', { labelIds: ['CATEGORY_PROMOTIONS'], headers: { 'List-Unsubscribe': '<mailto:u@junk.example>' } })];
  threads.already = [inbound(ago(3), 'Old Junk <old@junk.example>', 'Already binned', { labelIds: ['TRASH'] })];
  return threads;
}

const quiet = async (fn) => {
  const real = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, real); }
};
const live = (threads, state) => quiet(() => withGmail(threads, () => liveIngest({ mailbox: MAILBOX, keyJson: SERVICE_ACCOUNT_JSON, stateFile: state, repoRoot: ROOT }), { pageSize: 10 }));

test('baseline: runs ingest until caught up, counts tiers, and trashed mail in the window is ingested', async () => {
  const threads = mailbox();
  const state = join(mkdtempSync(join(tmpdir(), 'live-')), 'live.sqlite');
  const r = await live(threads, state);
  assert.equal(r.threads, Object.keys(threads).length);
  assert.ok(r.runs >= 2, 'more threads than one run takes: it loops until caught up');
  assert.equal(r.modes[0], 'backfill');
  assert.equal(r.trash.inWindow, 1);
  assert.equal(r.trash.ingested, 1);
  assert.deepEqual(r.trash.newly, [], 'the first run has nothing to compare against');
  assert.deepEqual(r.tiers, { customer: GMAIL_LIMITS.threadsPerRun + 8, bulk: 1, spam: 0 });
  assert.ok(r.maxRun.fetch > 0 && r.maxRun.fetch <= GMAIL_LIMITS.maxSubrequests);
  assert.equal((statSync(state).mode & 0o777).toString(8), '600');
});

test('after a message is moved to Trash, the next run is incremental, re-fetches that thread, and it is still ingested', async () => {
  const threads = mailbox();
  const state = join(mkdtempSync(join(tmpdir(), 'live-')), 'live.sqlite');
  await live(threads, state);
  const quietRun = await live(threads, state);
  assert.deepEqual(quietRun.modes, ['incremental']);
  assert.deepEqual(quietRun.refetched, []);

  threads.junk[0].labelIds = ['TRASH', 'CATEGORY_PROMOTIONS'];
  const r = await live(threads, state);
  assert.deepEqual(r.modes, ['incremental']);
  assert.deepEqual(r.trash.newly.map((t) => t.id), ['junk']);
  assert.deepEqual(r.refetched, ['junk'], 'history.list reported the label change');
  assert.equal(r.trash.newly[0].ingested, true);
  assert.equal(r.trash.newly[0].tier, 'bulk');
  assert.equal(r.trash.inWindow, 2);
  assert.equal(r.trash.ingested, 2);
  assert.equal(r.threads, Object.keys(threads).length, 'nothing dropped');
});

test('the printed report carries counts, dates, tiers and subjects, never a sender address', async () => {
  const threads = mailbox();
  const state = join(mkdtempSync(join(tmpdir(), 'live-')), 'live.sqlite');
  await live(threads, state);
  threads.junk[0].labelIds = ['TRASH'];
  const text = formatReport(await live(threads, state));
  assert.doesNotMatch(text, /@/);
  assert.match(text, /^NEWLY IN TRASH SINCE LAST RUN: 1$/m);
  assert.match(text, /^  \d{4}-\d{2}-\d{2} \| bulk \| ingested \| Limited time offer for \[address\]$/m);
  assert.match(text, /^TRASH IN WINDOW: 2 threads, 2 ingested$/m);
  assert.match(text, /^MODES: incremental$/m);
});

test('refuses a state file inside the repo', async () => {
  await assert.rejects(live(mailbox(), join(ROOT, 'live.sqlite')), /outside the repo/);
});
