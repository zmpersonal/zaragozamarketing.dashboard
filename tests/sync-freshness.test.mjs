// Sync freshness is shown per source, because the hourly Actions run can stop
// silently (a disabled workflow, an expired token, a quota, an API change) and
// the keepalive can't be verified. Over 3 hours since the last successful sync
// is a warning, over 12 an error, and an empty queue is never shown as simply
// "nothing waiting" while a source is stale or the API is failing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { ingestGmail } from '../src/ingest/gmail.ts';
import { ingestQuo } from '../src/ingest/quo.ts';
import { makeApiEnv, withAccess, mintToken, OWNER } from './helpers/access.mjs';
import { makeEnv, withGmail, inbound, SOURCE_ID } from './helpers/gmail.mjs';
import { makeQuoEnv, makeQuoAccount, withQuo, SOURCE_ID as QUO_SOURCE } from './helpers/quo.mjs';
import { sourceFreshness, overallFreshness, freshnessBadgeHtml, emptyQueueHtml, WARN_AFTER, ERROR_AFTER } from '../public/freshness.mjs';
import { esc } from '../public/render.mjs';

const NOW = 1789480800;
const email = (last) => ({ id: 'gmail:support@inhousewellness.com', brand_id: 'inhouse', provider: 'gmail', channel: 'email', address: 'support@inhousewellness.com', last_synced_at: last });
const H = 3600;
const gmail = (last) => ({ id: 'gmail:support@inhousewellness.com', provider: 'gmail', channel: 'email', address: 'support@inhousewellness.com', last_synced_at: last });
const quo = (last) => ({ id: 'quo:PN1', provider: 'quo', channel: 'phone', address: 'PN1', last_synced_at: last });
const quietly = async (fn) => { const r = { log: console.log, error: console.error, warn: console.warn }; console.log = console.error = console.warn = () => {}; try { return await fn(); } finally { Object.assign(console, r); } };

// --- classification --------------------------------------------------------------------

test('thresholds: fresh up to 3 hours, warning past 3, error past 12, and never synced is an error', () => {
  assert.equal(WARN_AFTER, 3 * H);
  assert.equal(ERROR_AFTER, 12 * H);
  assert.equal(sourceFreshness(gmail(NOW - 10 * 60), NOW).state, 'fresh');
  assert.equal(sourceFreshness(gmail(NOW - 3 * H), NOW).state, 'fresh', 'exactly 3 hours is not yet over');
  assert.equal(sourceFreshness(gmail(NOW - 3 * H - 1), NOW).state, 'warning');
  assert.equal(sourceFreshness(gmail(NOW - 12 * H), NOW).state, 'warning');
  assert.equal(sourceFreshness(gmail(NOW - 12 * H - 1), NOW).state, 'error');
  assert.equal(sourceFreshness(gmail(null), NOW).state, 'error');
  assert.match(sourceFreshness(gmail(null), NOW).text, /never synced/i);
  assert.match(sourceFreshness(gmail(NOW - 14 * H), NOW).text, /14 h ago/);
  assert.match(sourceFreshness(quo(NOW - 12 * 60), NOW).text, /Phone.*12 min ago/);
});

test('overall state is the worst source; no sources at all is an error', () => {
  assert.equal(overallFreshness([gmail(NOW - 60), quo(NOW - 60)], NOW).state, 'fresh');
  assert.equal(overallFreshness([gmail(NOW - 60), quo(NOW - 5 * H)], NOW).state, 'warning');
  assert.equal(overallFreshness([gmail(NOW - 20 * H), quo(NOW - 5 * H)], NOW).state, 'error');
  assert.equal(overallFreshness([], NOW).state, 'error');
});

// --- what the agent sees ------------------------------------------------------------------

test('the badge shows each source; stale ones are marked warning or error, visibly', () => {
  const fresh = freshnessBadgeHtml([gmail(NOW - 10 * 60), quo(NOW - 20 * 60)], NOW, esc);
  assert.match(fresh, /class="sync fresh"/);
  assert.doesNotMatch(fresh, /warning|error/);
  const stale = freshnessBadgeHtml([gmail(NOW - 5 * H), quo(NOW - 13 * H)], NOW, esc);
  assert.match(stale, /class="sync warning"[^>]*role="status"[^<]*>[^<]*Email[^<]*5 h ago/);
  assert.match(stale, /class="sync error"[^>]*role="alert"[^<]*>[^<]*Phone[^<]*13 h ago/);
});

test('an empty queue with fresh sources says so; with a stale source it says the list may be out of date', () => {
  const fresh = emptyQueueHtml({ sources: [gmail(NOW - 10 * 60), quo(NOW - 10 * 60)], now: NOW }, esc);
  assert.match(fresh, /Nothing waiting/);
  assert.doesNotMatch(fresh, /out of date|not loaded|never/i);

  const stale = emptyQueueHtml({ sources: [gmail(NOW - 14 * H), quo(NOW - 10 * 60)], now: NOW }, esc);
  assert.notEqual(stale, fresh);
  assert.match(stale, /class="empty error"/);
  assert.match(stale, /may be out of date/);
  assert.match(stale, /Email[^<]*14 h ago/);

  const warn = emptyQueueHtml({ sources: [gmail(NOW - 4 * H), quo(NOW - 10 * 60)], now: NOW }, esc);
  assert.match(warn, /class="empty warning"/);
});

test('an empty queue because the API failed is never shown as "nothing waiting"', () => {
  const broken = emptyQueueHtml({ sources: [gmail(NOW - 60)], now: NOW, apiError: 'HTTP 500 <oops>' }, esc);
  assert.match(broken, /class="empty error"/);
  assert.match(broken, /could not load/i);
  assert.doesNotMatch(broken, /Nothing waiting/);
  assert.ok(!broken.includes('<oops>'), 'escaped');
  const none = emptyQueueHtml({ sources: [], now: NOW }, esc);
  assert.match(none, /No sources are set up/);
});

// --- where the timestamps come from --------------------------------------------------------

test('/api/board returns every source with its last successful sync and the server clock', async () => {
  const env = makeApiEnv();
  env.DB.raw.exec(`UPDATE source SET last_synced_at = ${NOW - 2 * H}`);
  env.DB.raw.exec(`INSERT INTO source (id, brand_id, channel, provider, address) VALUES ('quo:PN1', 'inhouse', 'phone', 'quo', 'PN1')`);
  const token = await mintToken({ email: OWNER });
  const before = Math.floor(Date.now() / 1000);
  const res = await withAccess(() => worker.fetch(new Request('https://console.example/api/board', { headers: { 'Cf-Access-Jwt-Assertion': token } }), env));
  const body = await res.json();
  assert.ok(body.now >= before && body.now <= before + 5, 'server time, so a wrong laptop clock cannot make stale look fresh');
  assert.deepEqual(body.sources, [
    { id: 'gmail:support@inhousewellness.com', brand_id: 'inhouse', provider: 'gmail', channel: 'email', address: 'support@inhousewellness.com', last_synced_at: NOW - 2 * H },
    { id: 'quo:PN1', brand_id: 'inhouse', provider: 'quo', channel: 'phone', address: 'PN1', last_synced_at: null },
  ]);
});

test('a run that fails for a source does not touch its last successful sync; a good run does', async () => {
  const env = makeEnv();
  const T = Math.floor(Date.now() / 1000); // ingest stamps real time
  env.DB.raw.exec(`UPDATE source SET last_synced_at = ${T - 20 * H} WHERE id = '${SOURCE_ID}'`);
  const last = () => env.DB.raw.prepare('SELECT last_synced_at FROM source WHERE id = ?').get(SOURCE_ID).last_synced_at;
  await quietly(() => ingestGmail({ ...env, GOOGLE_SERVICE_ACCOUNT_JSON: '{"not":"a key"}' }));
  assert.equal(last(), T - 20 * H, 'unusable credentials');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 500 });
  try { await quietly(() => ingestGmail(env)); } finally { globalThis.fetch = realFetch; }
  assert.equal(last(), T - 20 * H, 'Google down');
  await quietly(() => withGmail({ a: [inbound(new Date().toISOString(), 'D <d@example.com>')] }, () => ingestGmail(env)));
  assert.ok(last() > T - 20 * H, 'a successful run moves it');

  const q = makeQuoEnv();
  q.DB.raw.exec(`UPDATE source SET last_synced_at = 5 WHERE id = '${QUO_SOURCE}'`);
  const account = makeQuoAccount();
  const qfetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('quota', { status: 429 });
  try { await quietly(() => ingestQuo(q)); } finally { globalThis.fetch = qfetch; }
  assert.equal(q.DB.raw.prepare('SELECT last_synced_at FROM source').get().last_synced_at, 5, 'Quo quota exceeded');
  await quietly(() => withQuo(account, () => ingestQuo(q)));
  assert.ok(q.DB.raw.prepare('SELECT last_synced_at FROM source').get().last_synced_at > 5);
});

test('the error and badge renderers escape even when the caller forgets to pass esc', () => {
  assert.ok(!emptyQueueHtml({ sources: [], now: NOW, apiError: '<img src=x onerror=1>' }).includes('<img'));
  assert.ok(!freshnessBadgeHtml([{ ...gmail(null), address: '<b>x</b>' }], NOW).includes('<b>'));
});

// Round 15, found by running it: the board loads before the queue does, so for
// one paint the page said "0 need a reply" over an empty-queue message while
// the first page of threads was still in flight. An empty queue is a claim
// about the world and must not be made before the answer arrives.
test('a queue that has not loaded yet says so, and never looks empty', () => {
  const html = emptyQueueHtml({ sources: [email(NOW - 60)], now: NOW, apiError: null, loading: true }, esc);
  assert.match(html, /Loading/i);
  assert.doesNotMatch(html, /Nothing waiting/i);
  assert.doesNotMatch(html, /out of date/i);
});

test('loading beats every other state, including a stale source', () => {
  const html = emptyQueueHtml({ sources: [email(NOW - 40 * 3600)], now: NOW, apiError: null, loading: true }, esc);
  assert.match(html, /Loading/i);
});

test('once loaded, nothing changes about what it says', () => {
  const fresh = emptyQueueHtml({ sources: [email(NOW - 60)], now: NOW, apiError: null, loading: false }, esc);
  assert.match(fresh, /Nothing waiting/);
});
