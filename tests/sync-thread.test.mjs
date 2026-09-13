// syncThread writes conditionally: if a human changes the thread between
// ingest reading it and writing it, the write is skipped rather than
// clobbering what the human just set. The next sync resolves from fresh data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncThread } from '../src/db/threads.ts';
import { makeEnv, at } from './helpers/gmail.mjs';

const observation = (timeline) => ({
  id: 'gmail:t1', source_id: 'gmail:support@inhousewellness.com', brand_id: 'inhouse', channel: 'email',
  subject: 'Sauna heater', customer_name: 'Dana Reyes', customer_handle: 'dana@example.com',
  refresh_customer: true, preview: 'hi', started_at: timeline[0].at,
  newest_inbound_at: Math.max(...timeline.filter((m) => m.inbound).map((m) => m.at)),
  newest_outbound_at: null, timeline,
});

test('an agent blocking the thread mid-sync is not overwritten', async () => {
  const env = makeEnv();
  const T0 = at('2026-09-15T09:00:00-05:00');
  const T1 = at('2026-09-15T10:00:00-05:00');
  assert.equal(await syncThread(env.DB, observation([{ at: T0, inbound: true }]), T0), 'inserted');

  // A DB whose read returns the pre-change row, then lets the agent's write land before ingest writes.
  const racing = {
    ...env.DB,
    prepare(sql) {
      const stmt = env.DB.prepare(sql);
      if (!sql.includes('SELECT status, last_inbound_at, awaiting_since')) return stmt;
      return {
        bind: (...p) => ({
          first: async () => {
            const snapshot = await stmt.bind(...p).first();
            env.DB.raw.exec(`UPDATE thread SET status = 'blocked', blocked_on = 'supplier' WHERE id = 'gmail:t1'`);
            return snapshot;
          },
        }),
      };
    },
  };

  const result = await syncThread(racing, observation([{ at: T0, inbound: true }, { at: T1, inbound: false }]), T1);
  assert.equal(result, 'skipped');
  const t = await env.DB.prepare(`SELECT status, blocked_on FROM thread WHERE id = 'gmail:t1'`).first();
  assert.deepEqual(t, { status: 'blocked', blocked_on: 'supplier' });
});
