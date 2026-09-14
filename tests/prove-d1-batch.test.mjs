// prove/d1-batch-atomicity.mjs asks the real D1 REST API whether a batch whose
// second statement fails leaves the first one applied. It is run by a human with
// a D1 token; here it runs against the stubbed API in both behaviours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proveBatchAtomicity } from '../prove/d1-batch-atomicity.mjs';
import { D1HttpClient } from '../src/db/d1-http.ts';
import { makeD1Rest, ACCOUNT, DATABASE, TOKEN } from './helpers/d1-rest.mjs';

const client = (api) => new D1HttpClient({ accountId: ACCOUNT, databaseId: DATABASE, token: TOKEN, fetch: api.fetch, sleep: async () => {} });

test('an atomic batch is reported ATOMIC, and the scratch table is dropped', async () => {
  const api = makeD1Rest();
  const r = await proveBatchAtomicity(client(api));
  assert.equal(r.verdict, 'ATOMIC');
  assert.equal(r.rowsAfterFailedBatch, 0);
  assert.match(r.batchError, /NOT NULL/);
  assert.equal(api.db.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = '_prove_batch_atomicity'").get().n, 0);
});

test('a batch that commits statement by statement is reported NOT ATOMIC', async () => {
  const api = makeD1Rest();
  api.atomicBatch = false;
  const r = await proveBatchAtomicity(client(api));
  assert.equal(r.verdict, 'NOT ATOMIC');
  assert.equal(r.rowsAfterFailedBatch, 1);
});

test('a batch that did not fail at all is inconclusive, never reported as atomic', async () => {
  const api = makeD1Rest();
  const c = client(api);
  const lenient = { prepare: (sql) => c.prepare(sql.replace('NOT NULL', '')), batch: (s) => c.batch(s) };
  const r = await proveBatchAtomicity(lenient);
  assert.equal(r.verdict, 'INCONCLUSIVE');
});
