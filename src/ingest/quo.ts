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
 */
import type { Env } from '../index.ts';
import type { Observed } from '../lib/thread-state.ts';
import { syncThread } from '../db/threads.ts';
import { clearFailure, recordFailure, SKIP_AFTER_FAILURES } from '../db/failures.ts';

const API = 'https://api.quo.com/v1/';
const PAGE = '100';
/** First poll for a source reads this far back. Matches Gmail's 30-day window. */
const BACKFILL_SECONDS = 30 * 86400;
/** Re-read a little before the cursor, for items indexed late. Re-reads are idempotent. */
const OVERLAP_SECONDS = 5 * 60;

const secs = (isoDate: string) => Math.floor(Date.parse(isoDate) / 1000);
const isoOf = (unix: number) => new Date(unix * 1000).toISOString();

/** The only credential these helpers need, so prove/quo.mjs can reuse them outside the Worker. */
type QuoAuth = Pick<Env, 'QUO_API_KEY'>;

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

async function quo<T>(env: QuoAuth, path: string, params: [string, string][]): Promise<{ data: T[]; nextPageToken?: string | null }> {
  const url = new URL(API + path);
  for (const [k, v] of params) url.searchParams.append(k, v);
  const res = await fetch(url, { headers: { Authorization: env.QUO_API_KEY } });
  if (!res.ok) throw new Error(`Quo ${path} -> ${res.status}`);
  return res.json();
}

/** Every page of a list endpoint. */
async function all<T>(env: QuoAuth, path: string, params: [string, string][]): Promise<T[]> {
  const out: T[] = [];
  let pageToken: string | null | undefined;
  do {
    const page = await quo<T>(env, path, pageToken ? [...params, ['pageToken', pageToken]] : params);
    out.push(...page.data);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

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
export async function readConversation(env: QuoAuth, c: QuoConversation, since: number) {
  const base: [string, string][] = [
    ['phoneNumberId', c.phoneNumberId],
    ...c.participants.map((p): [string, string] => ['participants', p]),
    ['createdAfter', isoOf(since)],
    ['maxResults', PAGE],
  ];
  const messages = await all<QuoMessage>(env, 'messages', base);
  // The calls endpoint accepts a single participant, so group threads have no call history.
  const calls = c.participants.length === 1 ? await all<QuoCall>(env, 'calls', base) : [];
  return { messages, calls, timeline: toTimeline(messages, calls) };
}

export async function ingestQuo(env: Env) {
  const { results: sources } = await env.DB
    .prepare(`SELECT * FROM source WHERE provider = 'quo'`).all<any>();

  for (const src of sources) {
    try {
      const now = Math.floor(Date.now() / 1000);
      const cursor: number | null = src.sync_cursor ? Number(src.sync_cursor) : null;
      const since = (cursor ?? now - BACKFILL_SECONDS) - OVERLAP_SECONDS;

      let highWater = cursor;
      let anyFailed = false;

      for (const c of await activeConversations(env, src.address, since)) {
        // One failing conversation is logged and skipped; the others still sync.
        try {
          const { messages, timeline } = await readConversation(env, c, since);
          if (timeline.length) await syncConversation(env, src, c, messages, timeline, now);
          await clearFailure(env.DB, src.id, `quo:${c.id}`);

          if (timeline.length) {
            const last = timeline[timeline.length - 1].at;
            highWater = highWater === null ? last : Math.max(highWater, last);
          }
        } catch (err) {
          // A conversation that keeps failing must not hold the cursor back
          // forever. Hold it (retry next poll) until SKIP_AFTER_FAILURES, then
          // skip past it; the record stays in ingest_failure for a human.
          const { failures, skipped } = await recordFailure(env.DB, src.id, `quo:${c.id}`, err, now);
          if (skipped) {
            console.error(`quo ingest skipping conversation ${c.id} on ${src.address} after ${failures} failures (limit ${SKIP_AFTER_FAILURES}); see ingest_failure`, err);
          } else {
            anyFailed = true;
            console.error(`quo ingest skipped conversation ${c.id} on ${src.address} (failure ${failures} of ${SKIP_AFTER_FAILURES}); will retry`, err);
          }
        }
      }

      // Advance the cursor unless a conversation failed and is still being
      // retried. Otherwise hold it, so that conversation is read again next poll.
      await env.DB.prepare(
        `UPDATE source SET last_synced_at = ?2, sync_cursor = CASE WHEN ?3 THEN sync_cursor ELSE ?4 END WHERE id = ?1`
      ).bind(src.id, now, anyFailed ? 1 : 0, highWater === null ? null : String(highWater)).run();
    } catch (err) {
      console.error(`quo ingest failed for ${src.address}`, err);
    }
  }
}

/** Write one conversation's observed timeline to its thread. */
async function syncConversation(
  env: Env, src: { id: string; brand_id: string }, c: QuoConversation,
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
