/**
 * Ingest failures, kept visible instead of silent.
 *
 * Every item (a Gmail thread, a Quo conversation) that fails to sync gets a
 * row counting consecutive failures. After SKIP_AFTER_FAILURES, a Quo item
 * is skipped: the cursor moves past it so one poison record cannot stop all
 * phone ingest. A successful sync deletes the row. /api/board lists them.
 */

import type { Db } from './db.ts';

export const SKIP_AFTER_FAILURES = 3;

export interface FailureOutcome {
  failures: number;
  /** true once the item has failed SKIP_AFTER_FAILURES times: stop holding the cursor for it */
  skipped: boolean;
}

export async function recordFailure(
  db: Db, sourceId: string, itemId: string, error: unknown, now: number,
): Promise<FailureOutcome> {
  const message = String(error instanceof Error ? error.message : error).slice(0, 500);
  await db.prepare(`
    INSERT INTO ingest_failure (source_id, item_id, failures, first_failed_at, last_failed_at, last_error)
    VALUES (?1, ?2, 1, ?3, ?3, ?4)
    ON CONFLICT (source_id, item_id) DO UPDATE SET
      failures       = failures + 1,
      last_failed_at = ?3,
      last_error     = ?4,
      skipped_at     = CASE WHEN failures + 1 >= ?5 THEN COALESCE(skipped_at, ?3) ELSE skipped_at END
  `).bind(sourceId, itemId, now, message, SKIP_AFTER_FAILURES).run();

  const row = await db.prepare('SELECT failures FROM ingest_failure WHERE source_id = ?1 AND item_id = ?2')
    .bind(sourceId, itemId).first<{ failures: number }>();
  const failures = row?.failures ?? 1;
  return { failures, skipped: failures >= SKIP_AFTER_FAILURES };
}

export async function clearFailure(db: Db, sourceId: string, itemId: string): Promise<void> {
  await db.prepare('DELETE FROM ingest_failure WHERE source_id = ?1 AND item_id = ?2').bind(sourceId, itemId).run();
}

export async function listFailures(db: Db) {
  const { results } = await db.prepare(`
    SELECT source_id, item_id, failures, first_failed_at, last_failed_at, last_error, skipped_at
    FROM ingest_failure
    ORDER BY skipped_at IS NULL, last_failed_at DESC
  `).all();
  return results;
}
