// The same ingest code, two databases: the Worker binding (the D1 shim) and
// the D1 REST client (stubbed API over node:sqlite). Every scenario must leave
// both databases identical, row for row. Only where the queries go differs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestGmail } from '../src/ingest/gmail.ts';
import { ingestQuo } from '../src/ingest/quo.ts';
import { D1HttpClient } from '../src/db/d1-http.ts';
import { makeD1 } from './helpers/d1.mjs';
import { makeD1Rest, ACCOUNT, DATABASE, TOKEN } from './helpers/d1-rest.mjs';
import { withGmail, inbound, outbound, SERVICE_ACCOUNT_JSON, MAILBOX, SOURCE_ID } from './helpers/gmail.mjs';
import { makeQuoAccount, withQuo, PHONE, SOURCE_ID as QUO_SOURCE } from './helpers/quo.mjs';

const DAY = 86400_000;
const ago = (days) => new Date(Math.floor((Date.now() - days * DAY) / 1000) * 1000).toISOString();

function twin(sourceSql) {
  const binding = makeD1();
  binding.raw.exec(sourceSql);
  const restDb = makeD1();
  restDb.raw.exec(sourceSql);
  const api = makeD1Rest(restDb);
  const http = new D1HttpClient({ accountId: ACCOUNT, databaseId: DATABASE, token: TOKEN, fetch: api.fetch, sleep: async () => {} });
  return { binding, restDb, api, http };
}

/** Everything ingest writes, minus wall-clock stamps that differ between two runs. */
function snapshot(raw) {
  const all = (sql) => raw.prepare(sql).all().map((r) => ({ ...r }));
  return {
    thread: all('SELECT * FROM thread ORDER BY id'),
    response: all('SELECT thread_id, awaiting_since, responded_at, business_minutes, via, actor FROM response ORDER BY thread_id, awaiting_since'),
    action: all('SELECT thread_id, actor, kind, body FROM action ORDER BY thread_id, kind'),
    known_sender: all('SELECT address, replied_at IS NOT NULL AS replied FROM known_sender ORDER BY address'),
    ingest_failure: all('SELECT source_id, item_id, failures, skipped_at IS NOT NULL AS skipped FROM ingest_failure ORDER BY item_id'),
    source: all('SELECT id, sync_cursor FROM source ORDER BY id').map((s) => {
      const c = s.sync_cursor ? JSON.parse(s.sync_cursor) : null;
      if (c?.scan) { delete c.scan.startedAt; delete c.scan.since; }
      if (c && 'highWater' in c) c.highWater = c.highWater === null ? null : 'set';
      return { id: s.id, cursor: c };
    }),
  };
}

const quietly = async (fn) => {
  const real = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, real); }
};

test('Gmail: backfill, a reply, a new thread, a spam relabel and a malformed thread give identical databases', async () => {
  const { binding, restDb, api, http } = twin(`INSERT INTO source (id, brand_id, channel, provider, address) VALUES ('${SOURCE_ID}', 'inhouse', 'email', 'gmail', '${MAILBOX}')`);
  const mailbox = () => ({
    a: [inbound(ago(3), 'Dana <dana@example.com>')],
    b: [inbound(ago(2), 'Sam <sam@example.com>'), outbound(ago(1))],
    c: [inbound(ago(1), 'Brand <news@brand.example>', 'Sale', { labelIds: ['CATEGORY_PROMOTIONS'], headers: { 'List-Unsubscribe': '<mailto:u@b.example>' } })],
    bad: { raw: { messages: [{ id: 'x', payload: null }] } },
  });
  const one = mailbox();
  const two = mailbox();
  const steps = [
    (t) => {},
    (t) => { t.a.push(outbound(ago(0))); },
    (t) => { t.d = [inbound(ago(0), 'Priya <priya@acme.example>')]; t.c[0].labelIds = ['SPAM']; },
  ];
  for (const step of steps) {
    step(one); step(two);
    const sumBinding = await quietly(() => withGmail(one, () => ingestGmail({ DB: binding, GOOGLE_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT_JSON })));
    const sumHttp = await quietly(() => withGmail(two, () => ingestGmail({ DB: http, GOOGLE_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT_JSON })));
    assert.deepEqual(sumHttp, sumBinding);
    assert.deepEqual(snapshot(restDb.raw), snapshot(binding.raw));
  }
  assert.ok(snapshot(binding.raw).thread.length >= 4, 'the scenario actually wrote threads');
  assert.ok(api.requests.length > 20, 'and it went over HTTP');
});

test('Quo: bounded scan, texts, calls and a failing conversation give identical databases', async () => {
  const { binding, restDb, http } = twin(`INSERT INTO source (id, brand_id, channel, provider, address) VALUES ('${QUO_SOURCE}', 'inhouse', 'phone', 'quo', '${PHONE}')`);
  const T0 = Math.floor(Date.now() / 1000) - 3600;
  const account = () => {
    const a = makeQuoAccount();
    a.conversation('CN1', { participants: ['+15125550101'], createdAt: T0 - 86400 });
    a.conversation('CN2', { participants: ['+15125550102'], createdAt: T0 - 86400 });
    a.conversation('CN3', { participants: ['+15125550103'], createdAt: T0 - 86400 });
    a.text('CN1', T0, 'incoming'); a.text('CN1', T0 + 60, 'outgoing');
    a.call('CN2', T0 + 10, 'incoming');
    a.text('CN3', T0 + 20, 'incoming');
    a.fail.add('CN3');
    return a;
  };
  const one = account();
  const two = account();
  for (let i = 0; i < 2; i++) {
    const sumBinding = await quietly(() => withQuo(one, () => ingestQuo({ DB: binding, QUO_API_KEY: 'k' })));
    const sumHttp = await quietly(() => withQuo(two, () => ingestQuo({ DB: http, QUO_API_KEY: 'k' })));
    assert.deepEqual(sumHttp, sumBinding);
    assert.deepEqual(snapshot(restDb.raw), snapshot(binding.raw));
  }
  assert.equal(snapshot(binding.raw).thread.length, 2);
  assert.equal(snapshot(binding.raw).ingest_failure[0].failures, 2);
});
