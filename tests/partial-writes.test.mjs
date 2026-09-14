// A sync can die between any two database writes: the run is killed, the REST
// API fails mid-run, or a REST batch turns out not to be atomic. Whatever point
// it dies at, the next sync of the same activity must finish the job: the same
// thread state and the same response-time rows as an uninterrupted sync. A
// thread updated without its response row would make the admin report
// silently under-count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncThread } from '../src/db/threads.ts';
import { makeD1 } from './helpers/d1.mjs';

const T0 = 1789480800; // Tue 09:00 CDT
const MIN = 60;
class Killed extends Error {}

/**
 * The D1 shim, killed before its `killAt`-th write. A batch is executed one
 * statement at a time, the way a non-atomic batch would, so a kill can land
 * inside it.
 */
function killable(db, killAt) {
  let writes = 0;
  const tick = () => { if (++writes === killAt) throw new Killed(`killed before write ${writes}`); };
  const wrap = (stmt, sql) => ({
    bind: (...a) => wrap(stmt.bind(...a), sql),
    first: () => stmt.first(),
    all: () => stmt.all(),
    run: async () => { if (!/^\s*select/i.test(sql)) tick(); return stmt.run(); },
    _inner: stmt,
  });
  return {
    get writes() { return writes; },
    db: {
      prepare: (sql) => wrap(db.prepare(sql), sql),
      batch: async (stmts) => { const out = []; for (const s of stmts) { tick(); out.push(await s._inner.run()); } return out; },
    },
  };
}

const observation = (id, timeline, extra = {}) => ({
  id, source_id: 'gmail:support@inhousewellness.com', brand_id: 'inhouse', channel: 'email', subject: 'S',
  customer_name: 'Dana', customer_handle: 'dana@example.com', refresh_customer: true, preview: 'p',
  conversation_started_at: timeline[0].at,
  newest_inbound_at: Math.max(...timeline.filter((m) => m.inbound).map((m) => m.at)),
  newest_outbound_at: timeline.some((m) => !m.inbound) ? Math.max(...timeline.filter((m) => !m.inbound).map((m) => m.at)) : null,
  timeline, ...extra,
});

function freshDb(setup) {
  const db = makeD1();
  db.raw.exec(`INSERT INTO source (id, brand_id, channel, provider, address) VALUES ('gmail:support@inhousewellness.com', 'inhouse', 'email', 'gmail', 'support@inhousewellness.com')`);
  setup?.(db);
  return db;
}
const snapshot = (db) => ({
  thread: db.raw.prepare('SELECT id, status, awaiting_since, last_inbound_at, last_outbound_at, closed_at FROM thread ORDER BY id').all().map((r) => ({ ...r })),
  response: db.raw.prepare('SELECT thread_id, awaiting_since, responded_at, business_minutes, via FROM response ORDER BY thread_id, awaiting_since').all().map((r) => ({ ...r })),
});

const SCENARIOS = {
  'a new thread whose wait began and ended in one observation': {
    first: [observation('gmail:a', [{ at: T0, inbound: true }, { at: T0 + 30 * MIN, inbound: false }])],
  },
  'an existing waiting thread receives our reply': {
    setup: (db) => syncThread(db, observation('gmail:b', [{ at: T0, inbound: true }]), T0 + MIN),
    first: [observation('gmail:b', [{ at: T0, inbound: true }, { at: T0 + 45 * MIN, inbound: false }])],
  },
  'a closed thread reopens and is answered in the same observation': {
    setup: async (db) => {
      await syncThread(db, observation('gmail:c', [{ at: T0, inbound: true }]), T0 + MIN);
      db.raw.exec(`UPDATE thread SET status = 'closed', closed_at = ${T0 + 5 * MIN}, awaiting_since = NULL WHERE id = 'gmail:c'`);
    },
    first: [observation('gmail:c', [{ at: T0, inbound: true }, { at: T0 + 60 * MIN, inbound: true }, { at: T0 + 90 * MIN, inbound: false }])],
  },
  'two waits end in one observation (a batch of response rows)': {
    first: [observation('gmail:d', [
      { at: T0, inbound: true }, { at: T0 + 10 * MIN, inbound: false },
      { at: T0 + 60 * MIN, inbound: true }, { at: T0 + 70 * MIN, inbound: false },
    ])],
  },
};

for (const [name, s] of Object.entries(SCENARIOS)) {
  test(`killed at any write, the next sync recovers: ${name}`, async () => {
    const reference = freshDb();
    await s.setup?.(reference);
    for (const o of s.first) await syncThread(reference, o, T0 + 2 * 3600);
    const expected = snapshot(reference);
    assert.ok(expected.response.length > 0, 'the scenario records at least one response');

    // How many writes does an uninterrupted sync make?
    const probe = freshDb();
    await s.setup?.(probe);
    const counter = killable(probe, Infinity);
    for (const o of s.first) await syncThread(counter.db, o, T0 + 2 * 3600);
    assert.ok(counter.writes >= 2, `${counter.writes} writes`);

    for (let k = 1; k <= counter.writes; k++) {
      const db = freshDb();
      await s.setup?.(db);
      const dying = killable(db, k);
      await assert.rejects((async () => { for (const o of s.first) await syncThread(dying.db, o, T0 + 2 * 3600); })(), Killed);
      for (const o of s.first) await syncThread(db, o, T0 + 3 * 3600); // the next run re-reads the same activity
      assert.deepEqual(snapshot(db), expected, `killed before write ${k} of ${counter.writes}`);
    }
  });
}
