/**
 * Quo (formerly OpenPhone) ingest — texts and calls.
 *
 * The webhook (/hooks/quo) is the fast path; this poll is the backstop that
 * guarantees every inbound is observed, even when a later outbound in the
 * same conversation supersedes it before we look. It reads individual
 * messages and calls created since a cursor stored per source, never just a
 * conversation's latest activity (which hid an inbound answered between polls).
 *
 * Quo v1 API (www.quo.com/docs/mdx/api-reference). The dated 2026-03-30 API
 * does not list messages yet; v1 "remains fully supported".
 *   GET /v1/conversations  phoneNumbers[], maxResults; newest activity first
 *   GET /v1/messages       phoneNumberId, participants[] (required), createdAfter
 *   GET /v1/calls          phoneNumberId, participants (max 1), createdAfter
 * Auth is the raw key in Authorization (no Bearer).
 *
 * Bounded per run, like Gmail (round 8). source.sync_cursor holds JSON
 * {highWater, scan}:
 *   - highWater: unix seconds; everything created before it (less a small
 *     overlap) has been read. null until the first scan completes, so the
 *     first scan reads 30 days back.
 *   - scan: the read in progress, {since, startedAt, pageToken, listingDone,
 *     pending, anyFailed}. Each run lists at most QUO_LIMITS.listPagesPerRun
 *     pages of conversations and reads at most conversationsPerRun of them.
 *     When the scan completes with nothing held for retry, highWater becomes
 *     the scan's START time, not the newest event seen: a conversation read
 *     early in a scan that spans runs can get new activity older than events
 *     read later.
 * A Budget (lib/budget.ts) counts every fetch and D1 statement; a
 * conversation that doesn't fit what is left waits for the next run.
 */
import type { IngestEnv } from '../db/db.ts';
import type { Observed } from '../lib/thread-state.ts';
import { syncThread } from '../db/threads.ts';
import { clearFailure, recordFailure, SKIP_AFTER_FAILURES } from '../db/failures.ts';
import { Budget } from '../lib/budget.ts';

const API = 'https://api.quo.com/v1/';
const PAGE = '100';

/**
 * Per-run caps, sized for an hourly GitHub Actions run (round 9); see GMAIL_LIMITS.
 * Quo's API allows 10 requests per second; ingest reads sequentially.
 */
export const QUO_LIMITS = {
  /** conversations read per source per run (below one 100-conversation listing page) */
  conversationsPerRun: 80,
  /** conversation listing pages per source per run (up to 100 each) */
  listPagesPerRun: 5,
  /** pages of messages, and of calls, one conversation may read (100 each); more is recorded as a failure */
  pagesPerConversation: 10,
  /** cap on conversations queued in the cursor */
  maxPending: 2000,
  /** per run, all sources: fetches + D1 statements */
  maxSubrequests: 2000,
  /** per run, all sources. With Gmail's 600, under Cloudflare's 1,200 API requests per 5 minutes. */
  maxD1Queries: 400,
};

/**
 * Worst-case D1 statements to sync one conversation before its waits are known:
 * syncThread SELECT + INSERT/UPDATE + reopen/unblock log, clearFailure, and
 * recordFailure's 2 if it fails. Each completed wait adds one response row.
 */
const CONVERSATION_QUERIES = 6;
const CONVERSATION_FETCHES = 2 * QUO_LIMITS.pagesPerConversation;
/** First poll for a source reads this far back. Matches Gmail's 30-day window. */
const BACKFILL_SECONDS = 30 * 86400;
/** Re-read a little before the cursor, for items indexed late. Re-reads are idempotent. */
const OVERLAP_SECONDS = 5 * 60;

const secs = (isoDate: string) => Math.floor(Date.parse(isoDate) / 1000);
const isoOf = (unix: number) => new Date(unix * 1000).toISOString();

/** The only credential these helpers need, so prove/quo.mjs can reuse them outside the Worker. */
type QuoAuth = Pick<IngestEnv, 'QUO_API_KEY'>;

export interface QuoPhoneNumber { id: string; number: string; name?: string | null }
export interface QuoConversation {
  id: string;
  phoneNumberId: string;
  participants: string[];
  name?: string | null;
  createdAt: string;
  lastActivityAt?: string | null;
}
export interface QuoMessage { direction: 'incoming' | 'outgoing'; status?: string; createdAt: string; text?: string }
export interface QuoCall { direction: 'incoming' | 'outgoing'; createdAt: string; answeredAt?: string | null }

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function quo<T>(env: QuoAuth, path: string, params: [string, string][], fetchImpl: Fetch = fetch): Promise<{ data: T[]; nextPageToken?: string | null }> {
  const url = new URL(API + path);
  for (const [k, v] of params) url.searchParams.append(k, v);
  const res = await fetchImpl(url, { headers: { Authorization: env.QUO_API_KEY ?? '' } });
  if (!res.ok) throw new Error(`Quo ${path} -> ${res.status}`);
  return res.json();
}

/** Every page of a list endpoint, or at most maxPages (then it throws rather than return a partial list). */
async function all<T>(env: QuoAuth, path: string, params: [string, string][], opts: ReadOptions = {}): Promise<T[]> {
  const out: T[] = [];
  let pageToken: string | null | undefined;
  let pages = 0;
  do {
    if (opts.maxPages !== undefined && pages === opts.maxPages) {
      throw new Error(`Quo ${path}: more than ${opts.maxPages} pages for one conversation; not read this run`);
    }
    const page = await quo<T>(env, path, pageToken ? [...params, ['pageToken', pageToken]] : params, opts.fetch);
    out.push(...page.data);
    pageToken = page.nextPageToken;
    pages++;
  } while (pageToken);
  return out;
}

interface ReadOptions { fetch?: Fetch; maxPages?: number }

export const listPhoneNumbers = (env: QuoAuth) => all<QuoPhoneNumber>(env, 'phone-numbers', []);

/** Conversations with activity at or after `since`. Pages stop once they are older (newest first). */
export async function activeConversations(env: QuoAuth, phone: string, since: number): Promise<QuoConversation[]> {
  const out: QuoConversation[] = [];
  let pageToken: string | null | undefined;
  do {
    const params: [string, string][] = [['phoneNumbers', phone], ['maxResults', PAGE]];
    if (pageToken) params.push(['pageToken', pageToken]);
    const page = await quo<QuoConversation>(env, 'conversations', params);
    for (const c of page.data) {
      if (secs(c.lastActivityAt ?? c.createdAt) < since) return out;
      out.push(c);
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

/**
 * One conversation's activity as a timeline. Contact means the customer was
 * actually reached: an outgoing text that was not undelivered, or a call that
 * was answered. An incoming call that was answered is the customer reaching
 * us and us picking up, so it is an inbound followed by contact.
 */
export function toTimeline(messages: QuoMessage[], calls: QuoCall[]): Observed[] {
  const timeline: Observed[] = [];
  for (const m of messages) {
    if (m.direction === 'incoming') timeline.push({ at: secs(m.createdAt), inbound: true });
    else if (m.status !== 'undelivered') timeline.push({ at: secs(m.createdAt), inbound: false });
  }
  for (const c of calls) {
    if (c.direction === 'incoming') {
      timeline.push({ at: secs(c.createdAt), inbound: true });
      if (c.answeredAt) timeline.push({ at: secs(c.answeredAt), inbound: false });
    } else if (c.answeredAt) {
      timeline.push({ at: secs(c.answeredAt), inbound: false });
    }
  }
  return timeline.sort((a, b) => a.at - b.at);
}

/** Every message and call in one conversation created after `since`, as a timeline. */
export async function readConversation(env: QuoAuth, c: QuoConversation, since: number, opts: ReadOptions = {}) {
  const base: [string, string][] = [
    ['phoneNumberId', c.phoneNumberId],
    ...c.participants.map((p): [string, string] => ['participants', p]),
    ['createdAfter', isoOf(since)],
    ['maxResults', PAGE],
  ];
  const messages = await all<QuoMessage>(env, 'messages', base, opts);
  // The calls endpoint accepts a single participant, so group threads have no call history.
  const calls = c.participants.length === 1 ? await all<QuoCall>(env, 'calls', base, opts) : [];
  return { messages, calls, timeline: toTimeline(messages, calls) };
}

interface Scan {
  since: number;
  startedAt: number;
  pageToken: string | null;
  listingDone: boolean;
  pending: QuoConversation[];
  anyFailed: boolean;
}
interface QuoCursor { highWater: number | null; scan: Scan | null }

function parseCursor(raw: string | null): QuoCursor {
  if (!raw) return { highWater: null, scan: null };
  if (/^\d+$/.test(raw)) return { highWater: Number(raw), scan: null }; // pre-round-8 cursor
  try {
    const c = JSON.parse(raw);
    return { highWater: typeof c.highWater === 'number' ? c.highWater : null, scan: c.scan && typeof c.scan.since === 'number' ? c.scan : null };
  } catch {
    return { highWater: null, scan: null };
  }
}

class DeferConversation extends Error {}

export interface IngestSummary {
  /** Sources that could not be read at all this run (auth, listing, database). */
  failedSources: string[];
  /** Items (conversations) that failed and were recorded in ingest_failure. */
  failedItems: number;
  processed: number;
}

export async function ingestQuo(env: IngestEnv, budget: Budget = Budget.from(env, QUO_LIMITS)): Promise<IngestSummary> {
  const summary: IngestSummary = { failedSources: [], failedItems: 0, processed: 0 };
  const db = budget.wrap(env.DB);
  const benv = { ...env, DB: db };
  const { results: sources } = await db
    .prepare(`SELECT * FROM source WHERE provider = 'quo'`).all<any>();
  if (sources.length && !env.QUO_API_KEY) {
    console.error('quo ingest skipped: QUO_API_KEY is not set');
    summary.failedSources = sources.map((s: any) => s.address);
    return summary;
  }

  for (const src of sources) {
    // Room for this source's listing and its cursor write.
    if (!budget.canAfford(QUO_LIMITS.listPagesPerRun, 1)) {
      console.warn(`quo ingest ${src.address}: budget exhausted before this source; it runs next time`);
      break;
    }
    const now = Math.floor(Date.now() / 1000);
    const cursor = parseCursor(src.sync_cursor);
    let mode = 'continue';
    let processed = 0;
    try {
      if (!cursor.scan) {
        mode = cursor.highWater === null ? 'backfill' : 'incremental';
        cursor.scan = {
          since: (cursor.highWater ?? now - BACKFILL_SECONDS) - OVERLAP_SECONDS,
          startedAt: now, pageToken: null, listingDone: false, pending: [], anyFailed: false,
        };
      }
      const scan = cursor.scan;

      // List: newest activity first, stopping at the first conversation older than the scan.
      for (let pages = 0; !scan.listingDone && pages < QUO_LIMITS.listPagesPerRun
        && scan.pending.length < QUO_LIMITS.conversationsPerRun && scan.pending.length < QUO_LIMITS.maxPending; pages++) {
        const params: [string, string][] = [['phoneNumbers', src.address], ['maxResults', PAGE]];
        if (scan.pageToken) params.push(['pageToken', scan.pageToken]);
        let page;
        try {
          page = await quo<QuoConversation>(env, 'conversations', params, budget.fetch);
        } catch (err) {
          if (!scan.pageToken) throw err;
          // A stored page token Quo no longer accepts: start the scan again next run, cursor unchanged.
          console.warn(`quo ingest ${src.address}: listing page token rejected (${(err as Error).message}); restarting the scan next run`);
          cursor.scan = null;
          break;
        }
        for (const c of page.data) {
          if (secs(c.lastActivityAt ?? c.createdAt) < scan.since) { scan.listingDone = true; break; }
          if (!scan.pending.some((p) => p.id === c.id)) {
            scan.pending.push({ id: c.id, phoneNumberId: c.phoneNumberId, participants: c.participants, name: c.name ?? null, createdAt: c.createdAt, lastActivityAt: c.lastActivityAt ?? null });
          }
        }
        scan.pageToken = page.nextPageToken ?? null;
        if (!scan.pageToken) scan.listingDone = true;
      }

      while (cursor.scan && scan.pending.length && processed < QUO_LIMITS.conversationsPerRun) {
        // Reserve this conversation's worst-case reads and base writes, plus the cursor write.
        if (!budget.canAfford(CONVERSATION_FETCHES, CONVERSATION_QUERIES + 1)) break;
        const c = scan.pending[0];
        const itemId = `quo:${c.id}`;
        try {
          const { messages, timeline } = await readConversation(env, c, scan.since, { fetch: budget.fetch, maxPages: QUO_LIMITS.pagesPerConversation });
          // Each outbound can end a wait and add a response row.
          const writes = CONVERSATION_QUERIES + timeline.filter((e) => !e.inbound).length + 1;
          if (writes > budget.maxQueries || writes > budget.maxSubrequests) {
            throw new Error(`needs ${writes} D1 queries, more than one run allows`);
          }
          if (!budget.canAfford(0, writes)) throw new DeferConversation();
          if (timeline.length) await syncConversation(benv, src, c, messages, timeline, now);
          await clearFailure(db, src.id, itemId);
        } catch (err) {
          if (err instanceof DeferConversation) break; // stays first in line for the next run
          // One failing conversation is logged and skipped; the others still sync.
          // It holds the cursor (retried by the next scan) until SKIP_AFTER_FAILURES,
          // then is skipped; the record stays in ingest_failure for a human.
          summary.failedItems++;
          const { failures, skipped } = await recordFailure(db, src.id, itemId, err, now);
          if (skipped) {
            console.error(`quo ingest skipping conversation ${c.id} on ${src.address} after ${failures} failures (limit ${SKIP_AFTER_FAILURES}); see ingest_failure`, err);
          } else {
            scan.anyFailed = true;
            console.error(`quo ingest skipped conversation ${c.id} on ${src.address} (failure ${failures} of ${SKIP_AFTER_FAILURES}); will retry`, err);
          }
        }
        scan.pending.shift();
        processed++;
        summary.processed++;
      }

      if (cursor.scan && scan.listingDone && !scan.pending.length) {
        if (!scan.anyFailed) cursor.highWater = scan.startedAt;
        cursor.scan = null;
      }
    } catch (err) {
      // Listing failed: this source is skipped this run and its cursor is not touched.
      console.error(`quo ingest failed for ${src.address}`, err);
      summary.failedSources.push(src.address);
      continue;
    }

    await db.prepare(`UPDATE source SET last_synced_at = ?2, sync_cursor = ?3 WHERE id = ?1`)
      .bind(src.id, now, JSON.stringify(cursor)).run();
    console.log(`quo ingest ${src.address}: mode=${mode}; processed ${processed} conversations, ${cursor.scan?.pending.length ?? 0} pending; subrequests fetch=${budget.fetches} d1=${budget.queries} (limits ${budget.maxSubrequests} / d1 ${budget.maxQueries})${budget.pastDeadline ? '; stopped at the run deadline' : ''}`);
  }
  return summary;
}

/** Write one conversation's observed timeline to its thread. */
async function syncConversation(
  env: IngestEnv, src: { id: string; brand_id: string }, c: QuoConversation,
  messages: QuoMessage[], timeline: Observed[], now: number,
) {
  const newest = (inbound: boolean): number | null => {
    const times = timeline.filter((m) => m.inbound === inbound).map((m) => m.at);
    return times.length ? Math.max(...times) : null;
  };
  const latest = [...messages].sort((a, b) => secs(b.createdAt) - secs(a.createdAt))[0];

  await syncThread(env.DB, {
    id: `quo:${c.id}`,
    source_id: src.id,
    brand_id: src.brand_id,
    channel: 'phone',
    subject: messages.length ? 'Text' : 'Call',
    customer_name: c.name ?? null,
    customer_handle: c.participants[0] ?? null,
    refresh_customer: false,
    preview: (latest?.text ?? '').slice(0, 200),
    conversation_started_at: secs(c.createdAt),
    newest_inbound_at: newest(true),
    newest_outbound_at: newest(false),
    timeline,
  }, now);
}
