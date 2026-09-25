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
import type { Db, IngestEnv } from '../db/db.ts';
import type { Observed } from '../lib/thread-state.ts';
import { classifyContent } from '../lib/triage.ts';
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
  /** voicemail lookups (one fetch each) one conversation may make in a run */
  voicemailsPerConversation: 10,
  /** cap on conversations queued in the cursor */
  maxPending: 2000,
  /** per run, all sources: fetches + D1 statements */
  maxSubrequests: 2000,
  /** per run, all sources. With Gmail's 600, under Cloudflare's 1,200 API requests per 5 minutes. */
  maxD1Queries: 400,
};

/**
 * Worst-case D1 statements to sync one conversation before its waits are known:
 * syncThread SELECT + INSERT/UPDATE + clearing waits_pending on a new thread +
 * reopen/unblock log, clearFailure, and recordFailure's 2 if it fails. Each completed wait adds one response row.
 */
const CONVERSATION_QUERIES = 7;
// Voicemail lookups are deliberately NOT reserved here: they are enrichment on
// top of a call we have already recorded, so they are spent only out of what is
// left (readConversation's `budget`). Reserving them would halve how many
// conversations fit a tight run for something that is never half a write.
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
/**
 * A call as /v1/calls returns it (round 14, checked against the live line):
 * answeredAt is set only when a human picked up. `status` is 'no-answer' or
 * 'completed', and 'completed' does NOT mean answered — 3 of 72 incoming calls
 * were 'completed' with answeredAt null and duration 0. `voicemail` is not part
 * of the call: it is fetched per call from /v1/call-voicemails/{callId}.
 */
export interface QuoCall {
  id?: string;
  direction: 'incoming' | 'outgoing';
  createdAt: string;
  answeredAt?: string | null;
  status?: string;
  duration?: number | null;
  voicemail?: QuoVoicemail | null;
}
export interface QuoVoicemail { transcript?: string | null; duration?: number | null; status?: string }

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

interface ReadOptions {
  fetch?: Fetch;
  maxPages?: number;
  /** What is left of the run. Voicemail lookups stop when they no longer fit. */
  budget?: { canAfford(fetches: number, queries: number): boolean };
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
    // Undelivered and failed texts never reached the customer, so they are not contact.
    else if (m.status !== 'undelivered' && m.status !== 'failed') timeline.push({ at: secs(m.createdAt), inbound: false });
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

/**
 * The voicemail left on one call, or null if there wasn't one.
 *
 * GET /v1/call-voicemails/{callId} answers 404 "Call voicemail not found" for a
 * call that just rang out — 14 of 64 on the live line — so 404 is a normal
 * answer, not a failure. Any other error is logged and treated as "no
 * voicemail": this is enrichment on top of a call we already recorded, and
 * losing it must never cost us the call itself or stall the cursor.
 */
export async function fetchVoicemail(env: QuoAuth, callId: string, fetchImpl: Fetch = fetch): Promise<QuoVoicemail | null> {
  const res = await fetchImpl(new URL(API + 'call-voicemails/' + encodeURIComponent(callId)), { headers: { Authorization: env.QUO_API_KEY ?? '' } });
  if (res.status === 404) return null;
  if (!res.ok) {
    console.warn(`quo voicemail ${callId} -> ${res.status}; treated as no voicemail`);
    return null;
  }
  const body = await res.json() as { data?: QuoVoicemail };
  return body?.data ?? null;
}

/** A call that could have gone to voicemail: they rang us and nobody picked up. */
const couldHaveVoicemail = (c: QuoCall) => c.direction === 'incoming' && c.answeredAt == null && !!c.id;

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
  // One extra request per unanswered incoming call, newest first, capped per run.
  let lookups = 0;
  for (const call of [...calls].sort((a, b) => secs(b.createdAt) - secs(a.createdAt))) {
    if (!couldHaveVoicemail(call)) continue;
    if (lookups >= QUO_LIMITS.voicemailsPerConversation || opts.budget?.canAfford(1, 0) === false) {
      console.warn(`quo: not looking up the voicemail on ${call.id} this run (${lookups} done); it stays a missed call until the thread is read again`);
      break;
    }
    lookups++;
    call.voicemail = await fetchVoicemail(env, call.id as string, opts.fetch ?? fetch);
  }
  return { messages, calls, timeline: toTimeline(messages, calls) };
}

/**
 * What a phone thread is, from its newest activity (round 14). "Call" told the
 * agent nothing: 52 of the 52 phone threads in the queue were titled that, so
 * the section read as noise whatever was in it.
 *
 * `contentForTriage` is the customer's words only — voicemail transcripts and
 * inbound texts. Our own outgoing texts must never classify their thread.
 * Pure.
 */
export function phoneSummary(messages: QuoMessage[], calls: QuoCall[]): { subject: string; preview: string | null; contentForTriage: string } {
  const events = [
    ...messages.map((m) => ({ at: secs(m.createdAt), kind: 'message' as const, m })),
    ...calls.map((c) => ({ at: secs(c.createdAt), kind: 'call' as const, c })),
  ].sort((a, b) => a.at - b.at);

  const newest = events.at(-1);
  let subject = 'Call';
  let preview: string | null = null;
  if (newest?.kind === 'message') {
    subject = 'Text';
    preview = newest.m.text?.trim() ? newest.m.text.slice(0, 200) : null;
  } else if (newest?.kind === 'call') {
    const c = newest.c;
    subject = c.answeredAt ? 'Call'
      : c.direction === 'outgoing' ? 'Outgoing call'
      : c.voicemail ? 'Voicemail'
      : 'Missed call';
    if (c.voicemail?.transcript) preview = c.voicemail.transcript.slice(0, 200);
  }

  const contentForTriage = [
    ...calls.map((c) => c.voicemail?.transcript ?? ''),
    ...messages.filter((m) => m.direction === 'incoming').map((m) => m.text ?? ''),
  ].filter(Boolean).join('\n');

  return { subject, preview, contentForTriage };
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
          const { messages, calls, timeline } = await readConversation(env, c, scan.since, { fetch: budget.fetch, maxPages: QUO_LIMITS.pagesPerConversation, budget });
          // Each outbound can end a wait and add a response row.
          const writes = CONVERSATION_QUERIES + timeline.filter((e) => !e.inbound).length + 1;
          if (writes > budget.maxQueries || writes > budget.maxSubrequests) {
            throw new Error(`needs ${writes} D1 queries, more than one run allows`);
          }
          if (!budget.canAfford(0, writes)) throw new DeferConversation();
          await syncQuoActivity(benv, src, c, { messages, calls }, now);
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

/**
 * The one write path for Quo activity, whichever way it arrived: polling
 * (readConversation) or a webhook event (quoWebhookActivity). Both hand over
 * the same message and call shapes, so the timeline, state rules and
 * response measurements cannot drift between them. Returns false when there
 * is nothing to record (e.g. only a failed outgoing text).
 */
export async function syncQuoActivity(
  env: IngestEnv, src: { id: string; brand_id: string }, c: QuoConversation,
  activity: { messages: QuoMessage[]; calls: QuoCall[] }, now: number,
): Promise<boolean> {
  const timeline = toTimeline(activity.messages, activity.calls);
  if (!timeline.length) return false;
  await syncConversation(env, src, c, activity.messages, activity.calls, timeline, now);
  return true;
}

// --- webhook events (API 2026-03-30) -------------------------------------------
// www.quo.com/docs/2026-03-30/webhooks-event-payloads, read round 10. Every event
// is {id, type, createdAt, data: {resource, context}}; context carries
// phoneNumberId and conversationId (both may be null).

export type WebhookActivity =
  | { kind: 'activity'; phoneNumberId: string; conversation: QuoConversation; messages: QuoMessage[]; calls: QuoCall[] }
  | { kind: 'ignored'; reason: string }
  | { kind: 'malformed'; reason: string };

const MESSAGE_EVENTS = new Set(['message.received', 'message.delivered', 'message.undelivered', 'message.failed']);
const CALL_EVENTS = new Set(['call.completed', 'call.missed']);
const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/** Turn a verified webhook event into the message/call shapes polling produces. Pure. */
export function quoWebhookActivity(event: any): WebhookActivity {
  const type = event?.type;
  if (!MESSAGE_EVENTS.has(type) && !CALL_EVENTS.has(type)) return { kind: 'ignored', reason: `event type ${type} is not ingested` };
  const resource = event?.data?.resource;
  const context = event?.data?.context;
  if (!resource || !context) return { kind: 'malformed', reason: `${type} without data.resource or data.context` };
  if (!context.phoneNumberId) return { kind: 'ignored', reason: `${type} has no phoneNumberId` };
  if (!context.conversationId) return { kind: 'ignored', reason: `${type} has no conversationId` };
  if (!isTime(resource.createdAt)) return { kind: 'malformed', reason: `${type} resource.createdAt is missing or not a date` };

  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  let participants: string[];
  const messages: QuoMessage[] = [];
  const calls: QuoCall[] = [];
  if (MESSAGE_EVENTS.has(type)) {
    const incoming = type === 'message.received';
    participants = incoming ? strings([context.senderIdentifier]) : strings(context.recipientIdentifiers);
    messages.push({
      direction: incoming ? 'incoming' : 'outgoing',
      status: typeof resource.status === 'string' ? resource.status : type.slice('message.'.length),
      createdAt: resource.createdAt,
      text: typeof resource.text === 'string' ? resource.text : undefined,
    });
  } else {
    participants = strings(context.participants?.external);
    const direction = type === 'call.missed' ? 'incoming' : resource.direction;
    if (direction !== 'incoming' && direction !== 'outgoing') return { kind: 'malformed', reason: `${type} without a direction` };
    if (resource.answeredAt != null && !isTime(resource.answeredAt)) return { kind: 'malformed', reason: `${type} resource.answeredAt is not a date` };
    calls.push({ direction, createdAt: resource.createdAt, answeredAt: type === 'call.missed' ? null : resource.answeredAt ?? null });
  }
  return {
    kind: 'activity',
    phoneNumberId: context.phoneNumberId,
    // A webhook-first thread starts at its first event; polling's view of the
    // conversation's own createdAt never overwrites it (conversation_started_at is insert-only).
    conversation: { id: context.conversationId, phoneNumberId: context.phoneNumberId, participants, name: null, createdAt: resource.createdAt },
    messages, calls,
  };
}

/** Write a verified webhook event. 'ignored' covers events we can't place (unknown number, no conversation, other types). */
export async function ingestQuoWebhookEvent(db: Db, event: unknown, now: number): Promise<'synced' | 'ignored' | 'malformed'> {
  const a = quoWebhookActivity(event);
  if (a.kind === 'malformed') { console.error(`quo webhook: malformed event: ${a.reason}`); return 'malformed'; }
  if (a.kind === 'ignored') { console.log(`quo webhook ignored: ${a.reason}`); return 'ignored'; }
  const src = await db.prepare(`SELECT id, brand_id FROM source WHERE provider = 'quo' AND address = ?1`)
    .bind(a.phoneNumberId).first<{ id: string; brand_id: string }>();
  if (!src) { console.log(`quo webhook ignored: no source for phone number ${a.phoneNumberId}`); return 'ignored'; }
  return (await syncQuoActivity({ DB: db }, src, a.conversation, a, now)) ? 'synced' : 'ignored';
}

/** Write one conversation's observed timeline to its thread. */
async function syncConversation(
  env: IngestEnv, src: { id: string; brand_id: string }, c: QuoConversation,
  messages: QuoMessage[], calls: QuoCall[], timeline: Observed[], now: number,
) {
  const newest = (inbound: boolean): number | null => {
    const times = timeline.filter((m) => m.inbound === inbound).map((m) => m.at);
    return times.length ? Math.max(...times) : null;
  };
  const { subject, preview, contentForTriage } = phoneSummary(messages, calls);
  // Only a demotion is passed on. An observation with no matching content must
  // not quietly promote a thread back out of spam, and a human verdict
  // (triage_by) is protected in syncThread either way.
  const verdict = classifyContent(contentForTriage);

  await syncThread(env.DB, {
    id: `quo:${c.id}`,
    source_id: src.id,
    brand_id: src.brand_id,
    channel: 'phone',
    subject,
    customer_name: c.name ?? null,
    customer_handle: c.participants[0] ?? null,
    refresh_customer: false,
    preview,
    triage: verdict.demote ? { tier: verdict.tier, score: verdict.score, signals: verdict.signals.map((s) => ({ code: s.code, why: s.why })) } : undefined,
    conversation_started_at: secs(c.createdAt),
    newest_inbound_at: newest(true),
    newest_outbound_at: newest(false),
    timeline,
  }, now);
}
