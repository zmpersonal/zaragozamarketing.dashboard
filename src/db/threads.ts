/**
 * Thread writes shared by every ingest path and the rescue action.
 *
 * syncThread reads the stored row, resolves the new state with the pure
 * rules in lib/thread-state.ts, then writes it back conditionally: the
 * UPDATE only applies if status, awaiting_since, last_inbound_at and
 * last_outbound_at are still what we read. If an agent changed the thread in between, the
 * write is skipped and the next ingest run resolves again from fresh data,
 * so ingest can never clobber a status a human just set.
 *
 * Write order (round 10): a sync can die between any two writes, and a D1
 * REST batch is not documented as atomic. Response rows are computed from the
 * state *before* the thread write, so they must never be lost to a thread row
 * that has already moved on:
 *   - existing thread: response rows first (INSERT OR IGNORE), then the
 *     thread UPDATE. Dying in between leaves the thread unchanged, so the next
 *     sync computes the same waits (ignored as duplicates) and updates.
 *   - new thread: the thread must exist first (response rows reference it),
 *     so it is inserted with waits_pending = 1, then its rows are written,
 *     then the flag is cleared. A later sync that finds the flag set records
 *     the waits in its observation again before anything else.
 * Only the reopened / unblocked action log can be lost to a kill (after the
 * UPDATE); it is a log line, not a measurement.
 */
import { completedWaits, resolveState, type Existing, type Observed } from '../lib/thread-state.ts';
import { businessMinutes } from '../lib/clock.ts';
import type { Db, DbStatement } from './db.ts';

/**
 * Store one response measurement. INSERT OR IGNORE on UNIQUE(thread_id,
 * awaiting_since): the same wait is only ever measured once, whether ingest
 * or an agent saw it end first.
 */
export function responseInsert(
  db: Db, threadId: string, awaitingSince: number, respondedAt: number,
  via: 'message' | 'replied' | 'called' | 'closed', actor: string, now: number,
): DbStatement {
  return db.prepare(
    `INSERT OR IGNORE INTO response (thread_id, awaiting_since, responded_at, business_minutes, via, actor, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  ).bind(threadId, awaitingSince, respondedAt, businessMinutes(awaitingSince, respondedAt), via, actor, now);
}

async function insertWaits(db: Db, threadId: string, waits: { awaiting_since: number; responded_at: number }[], now: number) {
  if (!waits.length) return;
  await db.batch(waits.map((w) => responseInsert(db, threadId, w.awaiting_since, w.responded_at, 'message', 'system', now)));
}

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
  /** Latest text; null keeps the stored preview (e.g. activity that is only a call). */
  preview: string | null;
  /** When the conversation began. Written on insert only. */
  conversation_started_at: number;
  newest_inbound_at: number | null;
  newest_outbound_at: number | null;
  timeline: Observed[];
  is_automated?: 0 | 1;
  /** Raw List-Unsubscribe headers, JSON {h, post}. Undefined leaves the stored value alone. */
  unsubscribe?: string | null;
  /** Classifier verdict. Written only while no human has set triage (triage_by IS NULL). */
  triage?: { tier: 'customer' | 'bulk' | 'spam'; score: number; signals: { code: string; why: string }[] };
}

export type SyncResult = 'inserted' | 'updated' | 'reopened' | 'unblocked' | 'skipped';

export async function syncThread(db: Db, o: ThreadObservation, now: number): Promise<SyncResult> {
  const existing = await db
    .prepare('SELECT status, last_inbound_at, last_outbound_at, awaiting_since, waits_pending FROM thread WHERE id = ?1')
    .bind(o.id)
    .first<Existing & { waits_pending: number }>();
  const state = resolveState(existing, o.timeline);

  if (!existing) {
    const waits = completedWaits(null, o.timeline);
    const res = await db.prepare(`
      INSERT INTO thread (
        id, source_id, brand_id, channel, subject, customer_name, customer_handle,
        preview, status, is_automated, conversation_started_at, last_inbound_at,
        last_outbound_at, awaiting_since, triage, triage_score, triage_signals, waits_pending,
        unsubscribe
      ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14, COALESCE(?15, 'customer'), COALESCE(?16, 0), ?17, ?18, ?19)
      ON CONFLICT(id) DO NOTHING
    `).bind(
      o.id, o.source_id, o.brand_id, o.channel, o.subject, o.customer_name, o.customer_handle,
      o.preview, state.status, o.is_automated ?? 0, o.conversation_started_at,
      o.newest_inbound_at ?? o.conversation_started_at, o.newest_outbound_at, state.awaiting_since,
      o.triage?.tier ?? null, o.triage?.score ?? null, o.triage ? JSON.stringify(o.triage.signals) : null,
      waits.length ? 1 : 0, o.unsubscribe ?? null,
    ).run();
    if (res.meta.changes === 0) return 'skipped';
    if (waits.length) {
      await insertWaits(db, o.id, waits, now);
      await db.prepare('UPDATE thread SET waits_pending = 0 WHERE id = ?1').bind(o.id).run();
    }
    return 'inserted';
  }

  // A previous sync inserted this thread and died before writing its response
  // rows: record the waits this observation shows (duplicates are ignored).
  if (existing.waits_pending) {
    await insertWaits(db, o.id, completedWaits(null, o.timeline), now);
    await db.prepare('UPDATE thread SET waits_pending = 0 WHERE id = ?1').bind(o.id).run();
  }

  // Response rows before the thread moves on (see the note at the top).
  await insertWaits(db, o.id, completedWaits(existing, o.timeline), now);


  // conversation_started_at is deliberately absent: it never changes after insert.
  const res = await db.prepare(`
    UPDATE thread SET
      -- What the thread is can change with new activity: a phone thread that
      -- was a missed call becomes a voicemail once Quo finishes processing it
      -- (round 14). An email thread's subject is the same string every time.
      subject          = COALESCE(?19, subject),
      customer_name    = CASE WHEN ?2 THEN ?3 ELSE customer_name END,
      customer_handle  = CASE WHEN ?2 THEN ?4 ELSE customer_handle END,
      preview          = COALESCE(?5, preview),
      unsubscribe      = COALESCE(?20, unsubscribe),
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
      blocked_since    = CASE WHEN ?15 THEN NULL ELSE blocked_since END,
      -- the classifier never overrides a human's triage call
      triage           = CASE WHEN triage_by IS NULL AND ?16 IS NOT NULL THEN ?16 ELSE triage END,
      triage_score     = CASE WHEN triage_by IS NULL AND ?16 IS NOT NULL THEN ?17 ELSE triage_score END,
      triage_signals   = CASE WHEN triage_by IS NULL AND ?16 IS NOT NULL THEN ?18 ELSE triage_signals END,
      -- back in the queue (a new inbound on a deleted thread): no longer deleted
      deleted_at       = CASE WHEN ?9 IN ('waiting','answered','blocked') THEN NULL ELSE deleted_at END
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
    o.triage?.tier ?? null, o.triage?.score ?? null, o.triage ? JSON.stringify(o.triage.signals) : null,
    o.subject ?? null, o.unsubscribe ?? null,
  ).run();

  if (res.meta.changes === 0) return 'skipped';

  if (state.reopened) {
    await db.prepare(
      `INSERT INTO action (thread_id, actor, kind, body, created_at) VALUES (?1, 'system', 'reopened', ?2, ?3)`
    ).bind(o.id, `New inbound message after the thread was ${existing.status}.`, now).run();
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
export async function rescueThread(db: Db, threadId: string, actor: string, now: number): Promise<boolean> {
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

/**
 * The mail behind a thread was deleted in Gmail (Delete forever, an emptied
 * Trash, or Gmail's 30-day spam purge). It leaves the queue as 'deleted', with
 * its clock stopped. This is not an answer: no response row, no outbound time,
 * so the admin report never counts it as a reply. A closed thread stays closed
 * and is only stamped. Idempotent: a thread already marked is left alone.
 */
export async function markThreadDeleted(db: Db, threadId: string, now: number): Promise<boolean> {
  const res = await db.prepare(`
    UPDATE thread SET
      status         = CASE WHEN status = 'closed' THEN status ELSE 'deleted' END,
      awaiting_since = CASE WHEN status = 'closed' THEN awaiting_since ELSE NULL END,
      blocked_since  = NULL,
      deleted_at     = ?2
    WHERE id = ?1 AND deleted_at IS NULL
  `).bind(threadId, now).run();
  if (res.meta.changes === 0) return false;
  await db.prepare(
    `INSERT INTO action (thread_id, actor, kind, body, created_at) VALUES (?1, 'system', 'deleted', ?2, ?3)`
  ).bind(threadId, 'The mail was deleted in Gmail. Removed from the queue; not counted as a reply.', now).run();
  return true;
}
