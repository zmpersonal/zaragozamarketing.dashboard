/**
 * Thread writes shared by every ingest path and the rescue action.
 *
 * syncThread reads the stored row, resolves the new state with the pure
 * rules in lib/thread-state.ts, then writes it back conditionally: the
 * UPDATE only applies if status, awaiting_since, last_inbound_at and
 * last_outbound_at are still what we read. If an agent changed the thread in between, the
 * write is skipped and the next cron run resolves again from fresh data,
 * so ingest can never clobber a status a human just set.
 */
import { resolveState, type Existing, type Observed } from '../lib/thread-state.ts';

export interface ThreadObservation {
  id: string;
  source_id: string;
  brand_id: string;
  channel: 'email' | 'phone' | 'chat';
  subject: string;
  customer_name: string | null;
  customer_handle: string | null;
  /** Overwrite customer fields on update (only when derived from the full thread). */
  refresh_customer: boolean;
  preview: string;
  /** When the conversation began. Written on insert only. */
  conversation_started_at: number;
  newest_inbound_at: number | null;
  newest_outbound_at: number | null;
  timeline: Observed[];
  is_automated?: 0 | 1;
}

export type SyncResult = 'inserted' | 'updated' | 'reopened' | 'unblocked' | 'skipped';

export async function syncThread(db: D1Database, o: ThreadObservation, now: number): Promise<SyncResult> {
  const existing = await db
    .prepare('SELECT status, last_inbound_at, last_outbound_at, awaiting_since FROM thread WHERE id = ?1')
    .bind(o.id)
    .first<Existing>();
  const state = resolveState(existing, o.timeline);

  if (!existing) {
    const res = await db.prepare(`
      INSERT INTO thread (
        id, source_id, brand_id, channel, subject, customer_name, customer_handle,
        preview, status, is_automated, conversation_started_at, last_inbound_at,
        last_outbound_at, awaiting_since
      ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
      ON CONFLICT(id) DO NOTHING
    `).bind(
      o.id, o.source_id, o.brand_id, o.channel, o.subject, o.customer_name, o.customer_handle,
      o.preview, state.status, o.is_automated ?? 0, o.conversation_started_at,
      o.newest_inbound_at ?? o.conversation_started_at, o.newest_outbound_at, state.awaiting_since,
    ).run();
    return res.meta.changes > 0 ? 'inserted' : 'skipped';
  }

  // conversation_started_at is deliberately absent: it never changes after insert.
  const res = await db.prepare(`
    UPDATE thread SET
      customer_name    = CASE WHEN ?2 THEN ?3 ELSE customer_name END,
      customer_handle  = CASE WHEN ?2 THEN ?4 ELSE customer_handle END,
      preview          = ?5,
      is_automated     = COALESCE(?6, is_automated),
      last_inbound_at  = MAX(last_inbound_at, COALESCE(?7, last_inbound_at)),
      last_outbound_at = CASE
                           WHEN ?8 IS NULL THEN last_outbound_at
                           WHEN last_outbound_at IS NULL OR ?8 > last_outbound_at THEN ?8
                           ELSE last_outbound_at
                         END,
      status           = ?9,
      awaiting_since   = ?10,
      -- leaving 'blocked' because the customer chased: no blocked age, but
      -- blocked_on / blocked_note stay as context for the agent
      blocked_since    = CASE WHEN ?15 THEN NULL ELSE blocked_since END
    WHERE id = ?1
      AND status = ?11
      AND awaiting_since IS ?12
      AND last_inbound_at = ?13
      AND last_outbound_at IS ?14
  `).bind(
    o.id, o.refresh_customer ? 1 : 0, o.customer_name, o.customer_handle, o.preview,
    o.is_automated ?? null, o.newest_inbound_at, o.newest_outbound_at,
    state.status, state.awaiting_since,
    existing.status, existing.awaiting_since, existing.last_inbound_at, existing.last_outbound_at,
    state.unblocked ? 1 : 0,
  ).run();

  if (res.meta.changes === 0) return 'skipped';

  if (state.reopened) {
    await db.prepare(
      `INSERT INTO action (thread_id, actor, kind, body, created_at) VALUES (?1, 'system', 'reopened', ?2, ?3)`
    ).bind(o.id, 'New inbound message after the thread was closed.', now).run();
    return 'reopened';
  }
  if (state.unblocked) {
    await db.prepare(
      `INSERT INTO action (thread_id, actor, kind, body, created_at)
       SELECT ?1, 'system', 'unblocked', 'Customer wrote again while blocked on ' || COALESCE(blocked_on, 'something') || '.', ?2
       FROM thread WHERE id = ?1`
    ).bind(o.id, now).run();
    return 'unblocked';
  }
  return 'updated';
}

/**
 * Rescue a demoted thread into the queue. Changes the triage verdict and
 * logs who did it. Never touches conversation_started_at or awaiting_since: the
 * customer wrote when they wrote, and the response clock must say so.
 * Returns false if there is no such thread.
 */
export async function rescueThread(db: D1Database, threadId: string, actor: string, now: number): Promise<boolean> {
  const found = await db.prepare('SELECT 1 AS ok FROM thread WHERE id = ?1').bind(threadId).first();
  if (!found) return false;
  await db.batch([
    db.prepare(`UPDATE thread SET triage = 'customer', triage_by = ?2 WHERE id = ?1`).bind(threadId, actor),
    db.prepare(
      `INSERT INTO action (thread_id, actor, kind, body, created_at) VALUES (?1, ?2, 'rescued', NULL, ?3)`
    ).bind(threadId, actor, now),
  ]);
  return true;
}
