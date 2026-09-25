/**
 * The admin response-time view (round 15) — owners only.
 *
 * The `response` table has been recording every wait that ended since round 4:
 * awaiting_since, responded_at, business_minutes, via, actor. Nothing had ever
 * read it. This does, and it answers the question the dashboard was asked for:
 * how long does a customer wait, and what is waiting now.
 *
 * Three rules run through all of it:
 *   - **Median, not mean.** At two real emails a day, one 40-hour outlier moves
 *     a mean by hours and tells you nothing about a normal day.
 *   - **Business minutes** (America/Chicago, Mon-Fri 08:00-17:00), never
 *     wall-clock (CLAUDE.md invariant 6).
 *   - **Bulk and spam are excluded everywhere.** They are not customers waiting.
 *
 * Cost: four statements, and none of them returns a row per thread. The median
 * is picked inside SQLite with a window function, so a busy month returns two
 * rows per channel rather than every measurement. The age buckets are counted
 * in SQL against three timestamps computed once by businessTimeBefore — the
 * alternative, running the business-hours clock per open thread, is the one
 * shape of this route that would not scale.
 */
import type { Db } from './db/db.ts';
import { businessTimeBefore } from './lib/clock.ts';
import { threadLink } from './lib/links.ts';

/** Bucket edges in business minutes: under 2h, 2-8h (a working day), 8-24h (three days), older. */
export const BUCKET_MINUTES = [120, 480, 1440] as const;
export const RECENT_DAYS = 7;
export const RECENT_LIMIT = 100;
export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 365;

const NOT_DEMOTED = "t.triage NOT IN ('bulk','spam')";
const OPEN = "t.status IN ('waiting','blocked')";

export interface Bucketed { under_2h: number; h2_8: number; h8_24: number; over_24h: number; total: number }
const EMPTY_BUCKETS = (): Bucketed => ({ under_2h: 0, h2_8: 0, h8_24: 0, over_24h: 0, total: 0 });

export interface ReportChannel { channel: string; median_business_minutes: number | null; answered: number }

export async function buildReport(
  db: Db, sources: Map<string, string>, now: number, days: number,
): Promise<{
  now: number; since: number; days: number; recent_days: number;
  bucket_minutes: number[];
  channels: ReportChannel[];
  outstanding: Record<string, Bucketed>;
  recent: Record<string, unknown>[];
}> {
  const since = now - days * 86400;
  const recentSince = now - RECENT_DAYS * 86400;
  const [b2, b8, b24] = BUCKET_MINUTES.map((m) => businessTimeBefore(now, m));

  // Median and count per channel, and for everything, in one statement. The
  // rows that come back are at most two per channel, never the measurements.
  const medians = db.prepare(`
    WITH m AS (
      SELECT t.channel AS ch, r.business_minutes AS v
      FROM response r JOIN thread t ON t.id = r.thread_id
      WHERE r.responded_at >= ?1 AND ${NOT_DEMOTED}
    ),
    g AS (SELECT ch, v FROM m UNION ALL SELECT 'all' AS ch, v FROM m),
    w AS (
      SELECT ch, v,
             ROW_NUMBER() OVER (PARTITION BY ch ORDER BY v) AS rn,
             COUNT(*)     OVER (PARTITION BY ch)            AS n
      FROM g
    )
    SELECT ch, AVG(v) AS median, MAX(n) AS answered
    FROM w WHERE rn IN ((n + 1) / 2, (n + 2) / 2)
    GROUP BY ch
  `).bind(since);

  // Open threads by business age. Three comparisons, no rows per thread.
  const outstanding = db.prepare(`
    SELECT t.channel AS ch,
           SUM(CASE WHEN t.awaiting_since >  ?1 THEN 1 ELSE 0 END) AS under_2h,
           SUM(CASE WHEN t.awaiting_since <= ?1 AND t.awaiting_since > ?2 THEN 1 ELSE 0 END) AS h2_8,
           SUM(CASE WHEN t.awaiting_since <= ?2 AND t.awaiting_since > ?3 THEN 1 ELSE 0 END) AS h8_24,
           SUM(CASE WHEN t.awaiting_since <= ?3 THEN 1 ELSE 0 END) AS over_24h,
           COUNT(*) AS total
    FROM thread t
    WHERE ${OPEN} AND ${NOT_DEMOTED} AND t.awaiting_since IS NOT NULL
    GROUP BY t.channel
  `).bind(b2, b8, b24);

  // What was answered lately, with the agent's own words. The action is matched
  // on the second it was logged: POST /api/actions writes the action and the
  // response row with the same timestamp. A wait ingest saw end has no action,
  // which is not a gap — the reply itself is in Gmail.
  const recent = db.prepare(`
    SELECT r.thread_id, r.responded_at, r.business_minutes, r.via, r.actor,
           t.channel, t.subject, t.customer_name, t.customer_handle, t.source_id,
           a.kind AS action_kind, a.body AS action_body, a.actor AS action_actor
    FROM response r
    JOIN thread t ON t.id = r.thread_id
    LEFT JOIN action a
      ON a.thread_id = r.thread_id AND a.created_at = r.responded_at
     AND a.kind IN ('replied','called')
    WHERE r.responded_at >= ?1 AND ${NOT_DEMOTED}
    ORDER BY r.responded_at DESC
    LIMIT ${RECENT_LIMIT}
  `).bind(recentSince);

  const [medianRows, outRows, recentRows] = await Promise.all([
    medians.all<{ ch: string; median: number | null; answered: number }>(),
    outstanding.all<Bucketed & { ch: string }>(),
    recent.all<Record<string, unknown>>(),
  ]);

  const byChannel = new Map(medianRows.results.map((r) => [r.ch, r]));
  const channels: ReportChannel[] = ['email', 'phone', 'chat', 'all']
    .filter((ch) => ch === 'all' || byChannel.has(ch))
    .map((ch) => {
      const row = byChannel.get(ch);
      return {
        channel: ch,
        median_business_minutes: row?.median == null ? null : Math.round(row.median),
        answered: row?.answered ?? 0,
      };
    });

  const out: Record<string, Bucketed> = { all: EMPTY_BUCKETS() };
  for (const r of outRows.results) {
    const b: Bucketed = { under_2h: r.under_2h, h2_8: r.h2_8, h8_24: r.h8_24, over_24h: r.over_24h, total: r.total };
    out[r.ch] = b;
    for (const k of Object.keys(b) as (keyof Bucketed)[]) out.all[k] += b[k];
  }

  return {
    now, since, days, recent_days: RECENT_DAYS,
    bucket_minutes: [...BUCKET_MINUTES],
    channels,
    outstanding: out,
    recent: recentRows.results.map((r) => ({
      ...r,
      link: threadLink({ id: String(r.thread_id), channel: String(r.channel) }, sources.get(String(r.source_id)) ?? null),
    })),
  };
}
