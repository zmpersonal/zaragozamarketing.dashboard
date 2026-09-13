// One malformed thread must not stop a mailbox's sync: it is logged and
// skipped, and every other thread in the batch is still ingested.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestGmail } from '../src/ingest/gmail.ts';
import { makeEnv, withGmail, inbound, row, SOURCE_ID } from './helpers/gmail.mjs';

const DANA = 'Dana Reyes <dana@example.com>';
const T = '2026-09-15T09:00:00-05:00';

async function captureErrors(fn) {
  const real = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.map(String).join(' '));
  try { await fn(); } finally { console.error = real; }
  return lines;
}

const MALFORMED = {
  'a message with no payload (throws in code)': {
    raw: { snippet: 'x', messages: [{ id: 'm', internalDate: String(Date.parse(T)), labelIds: ['INBOX'] }] },
  },
  'a message with no internalDate (fails in the database)': {
    raw: { snippet: 'x', messages: [{ id: 'm', labelIds: ['INBOX'], payload: { headers: [{ name: 'From', value: DANA }] } }] },
  },
};

for (const [shape, bad] of Object.entries(MALFORMED)) {
  test(`malformed thread in the middle of a batch (${shape}) is logged and skipped; the rest sync`, async () => {
    const env = makeEnv();
    const errors = await captureErrors(() =>
      withGmail({
        t1: [inbound(T, DANA)],
        t2: bad,
        t3: [inbound(T, 'Sam Ortiz <sam@example.com>')],
      }, () => ingestGmail(env)),
    );

    assert.ok(await row(env, 't1'), 't1 before the bad thread is ingested');
    assert.equal(await row(env, 't2'), null, 'the bad thread is skipped');
    assert.ok(await row(env, 't3'), 't3 after the bad thread is still ingested');

    assert.equal(errors.length, 1, errors.join('\n'));
    assert.match(errors[0], /t2/, 'the log names the thread that failed');

    const src = await env.DB.prepare('SELECT last_synced_at FROM source WHERE id = ?1').bind(SOURCE_ID).first();
    assert.notEqual(src.last_synced_at, null, 'the mailbox still records that it synced');
  });
}
