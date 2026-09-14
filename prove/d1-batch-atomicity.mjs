#!/usr/bin/env node
/**
 * PROVE: is a D1 REST API batch atomic?
 *
 * Cloudflare documents the Worker binding's batch() as a transaction ("aborts
 * or rolls back the entire sequence"). The REST /query page only says a batch
 * "will be executed as a batch". This settles it against the real database:
 *
 *   1. CREATE TABLE _prove_batch_atomicity (id INTEGER PRIMARY KEY, v TEXT NOT NULL)
 *   2. batch [ INSERT (1, 'ok'), INSERT (2, NULL) ]   -- the second violates NOT NULL
 *   3. count rows: 0 -> ATOMIC (rolled back), 1 -> NOT ATOMIC (first one committed)
 *   4. DROP the table
 *
 * It writes to the production database (a scratch table, dropped at the end),
 * so it is a human step:
 *   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_D1_DATABASE_ID=... \
 *     node prove/d1-batch-atomicity.mjs
 * Ingest is written to be correct either way (src/db/threads.ts, "Write order").
 */
import { D1HttpClient } from '../src/db/d1-http.ts';

const TABLE = '_prove_batch_atomicity';

export async function proveBatchAtomicity(db) {
  await db.prepare(`DROP TABLE IF EXISTS ${TABLE}`).run();
  await db.prepare(`CREATE TABLE ${TABLE} (id INTEGER PRIMARY KEY, v TEXT NOT NULL)`).run();
  let batchError = null;
  try {
    await db.batch([
      db.prepare(`INSERT INTO ${TABLE} (id, v) VALUES (?1, ?2)`).bind(1, 'ok'),
      db.prepare(`INSERT INTO ${TABLE} (id, v) VALUES (?1, ?2)`).bind(2, null),
    ]);
  } catch (err) {
    batchError = err.message;
  }
  const rows = (await db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).first()).n;
  await db.prepare(`DROP TABLE IF EXISTS ${TABLE}`).run();
  const verdict = batchError === null ? 'INCONCLUSIVE' : rows === 0 ? 'ATOMIC' : 'NOT ATOMIC';
  return { verdict, rowsAfterFailedBatch: rows, batchError };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const missing = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_D1_DATABASE_ID'].filter((n) => !process.env[n]);
  if (missing.length) {
    console.error(`\n  FAILED: set ${missing.join(', ')}\n`);
    process.exit(1);
  }
  const db = new D1HttpClient({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID, databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID, token: process.env.CLOUDFLARE_API_TOKEN });
  const r = await proveBatchAtomicity(db);
  console.log(`VERDICT: ${r.verdict}`);
  console.log(`ROWS AFTER FAILED BATCH: ${r.rowsAfterFailedBatch} (0 = rolled back)`);
  console.log(`BATCH ERROR: ${(r.batchError ?? 'none: the batch did not fail, so nothing was tested').replaceAll(process.env.CLOUDFLARE_API_TOKEN, '***')}`);
}
