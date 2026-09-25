/**
 * Gmail ingest — incremental, bounded, on a cron for every mailbox.
 *
 * Population: the whole received stream, the same one prove/triage.mjs
 * measures (archived, filtered, spam and trash included; only our sent mail,
 * drafts and chats excluded). Never in:inbox, which makes the filter moot.
 *
 * Incremental: source.sync_cursor holds JSON {historyId, pending, backfillPageToken}.
 *   - empty cursor  -> bounded backfill: read the profile's historyId, list ONE
 *                      page of RECEIVED_QUERY, queue its threads, and keep the
 *                      page token so later runs catch up page by page.
 *   - historyId     -> history.list since it: only threads that changed.
 *   - expired (404) or invalid (400) historyId
 *                   -> bounded window sync (the same one-page listing) and
 *                      re-seed the cursor from the profile.
 * Gmail behaviour verified on support@ (round 7): profile historyId is numeric;
 * history records carry thread ids and increase; expired/future ids 404,
 * non-numeric ids 400.
 *
 * Bounded: at most GMAIL_LIMITS.threadsPerRun threads per mailbox per run,
 * and a Budget (lib/budget.ts) that counts every fetch and D1 query. Work that
 * doesn't fit stays in cursor.pending for the next run.
 *
 * Each thread gets a triage tier from its first inbound message; status and
 * awaiting_since come from the full timeline (lib/thread-state.ts).
 */
import type { Db, IngestEnv } from '../db/db.ts';
import { emailOf } from '../lib/triage.ts';
import type { Observed } from '../lib/thread-state.ts';
import { markThreadDeleted, syncThread } from '../db/threads.ts';
import { clearFailure, recordFailure } from '../db/failures.ts';
import { GMAIL_READONLY, parseServiceAccount, serviceAccountToken, type ServiceAccountKey } from '../lib/google-auth.ts';
import { classify, type Exemptions } from '../lib/triage.ts';
import { Budget } from '../lib/budget.ts';
import type { IngestSummary } from './quo.ts';

const WINDOW_DAYS = 30;
export const RECEIVED_QUERY = `in:anywhere newer_than:${WINDOW_DAYS}d -in:sent -in:drafts -in:chats`;

/**
 * Per-run caps, sized for an hourly GitHub Actions run (round 9), not the
 * Workers 50-subrequest ceiling they were first sized for. The binding limits
 * are the Cloudflare API rate (D1 statements: Gmail 600 + Quo 400 per run, under
 * 1,200 per 5 minutes) and the run's wall-clock deadline (scripts/ingest.mjs).
 * The counts are backstops so a bug can't run away.
 */
export const GMAIL_LIMITS = {
  /** threads fetched per mailbox per run: a 30-day support@ backlog (~260) clears in 2-3 runs */
  threadsPerRun: 150,
  /** messages per backfill / fallback page (Gmail's maximum is 500) */
  backfillPageSize: 500,
  /** history.list pages per run (up to 500 records each) */
  historyPages: 5,
  /** cap on queued thread ids carried in the cursor */
  maxPending: 5000,
  /** per run, all mailboxes: fetches + D1 statements */
  maxSubrequests: 2000,
  /** per run, all mailboxes. With Quo's 400, under Cloudflare's 1,200 API requests per 5 minutes. */
  maxD1Queries: 600,
};

/**
 * Worst-case D1 queries to sync one thread, before its reply count is known:
 * SELECT + INSERT/UPDATE + clearing waits_pending on a new thread + reopen/unblock
 * log + known_sender upsert + clearFailure, plus recordFailure's 2 if it fails. Each reply in the thread can add one
 * response row on top; that is checked once the thread is fetched.
 */
const THREAD_QUERIES = 8;
/** Per mailbox, outside the thread loop: 2 exemption reads + 1 cursor write. */
const MAILBOX_QUERIES = 3;
/** Per mailbox, outside the thread loop: token + at most 3 listing calls (history pages or profile + list, + one catch-up page). */
const MAILBOX_FETCHES = 4;

interface Cursor { historyId: string | null; pending: string[]; backfillPageToken: string | null }

function parseCursor(raw: string | null): Cursor {
  const empty: Cursor = { historyId: null, pending: [], backfillPageToken: null };
  if (!raw) return empty;
  if (/^\d+$/.test(raw)) return { ...empty, historyId: raw };
  try {
    const c = JSON.parse(raw);
    return {
      historyId: typeof c.historyId === 'string' ? c.historyId : null,
      pending: Array.isArray(c.pending) ? c.pending.filter((x: unknown) => typeof x === 'string') : [],
      backfillPageToken: typeof c.backfillPageToken === 'string' ? c.backfillPageToken : null,
    };
  } catch {
    return empty;
  }
}

class DeferThread extends Error {}

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me/';

async function gmailGet(budget: Budget, auth: Record<string, string>, path: string, params: [string, string][] = []) {
  const url = new URL(GMAIL + path);
  for (const [k, v] of params) url.searchParams.append(k, v);
  const res = await budget.fetch(url, { headers: auth });
  return { status: res.status, body: res.ok ? await res.json<any>() : null };
}

/** Exemptions from our own records: sender rules (verified customers, spam senders) and everyone we have replied to. */
async function loadExemptions(db: Db): Promise<Exemptions> {
  const rules = (await db.prepare('SELECT address, verdict FROM sender_rule').all<{ address: string; verdict: string }>()).results;
  const replied = (await db.prepare(`
    SELECT address FROM known_sender WHERE replied_at IS NOT NULL
    UNION SELECT customer_handle FROM thread WHERE last_outbound_at IS NOT NULL AND customer_handle IS NOT NULL
  `).all<{ address: string }>()).results;
  return {
    markedReal: new Set(rules.filter((r) => r.verdict === 'customer').map((r) => r.address.toLowerCase())),
    markedSpam: new Set(rules.filter((r) => r.verdict === 'spam').map((r) => r.address.toLowerCase())),
    everRepliedTo: new Set(replied.map((r) => r.address.toLowerCase())),
  };
}

const queue = (cursor: Cursor, ids: Iterable<string>) => {
  for (const id of ids) if (!cursor.pending.includes(id)) cursor.pending.push(id);
};

/** One page of the received stream (backfill / fallback / catch-up). */
async function listWindowPage(budget: Budget, auth: Record<string, string>, cursor: Cursor, pageToken: string | null) {
  const params: [string, string][] = [
    ['q', RECEIVED_QUERY], ['includeSpamTrash', 'true'], ['maxResults', String(GMAIL_LIMITS.backfillPageSize)],
  ];
  if (pageToken) params.push(['pageToken', pageToken]);
  const r = await gmailGet(budget, auth, 'messages', params);
  if (r.status === 400 && pageToken) return { messages: 0, threads: 0, expiredToken: true };
  if (!r.body) throw new Error(`Gmail messages.list -> ${r.status}`);
  const ids = new Set<string>((r.body.messages ?? []).map((m: { threadId: string }) => m.threadId));
  queue(cursor, ids);
  cursor.backfillPageToken = r.body.nextPageToken ?? null;
  return { messages: (r.body.messages ?? []).length, threads: ids.size, expiredToken: false };
}

/** Threads changed since cursor.historyId, or { expired } if Gmail no longer has that history. */
async function readHistory(budget: Budget, auth: Record<string, string>, cursor: Cursor) {
  const changed = new Set<string>();
  let pageToken: string | undefined;
  let historyId = cursor.historyId as string;
  for (let page = 0; page < GMAIL_LIMITS.historyPages; page++) {
    const params: [string, string][] = [
      ['startHistoryId', cursor.historyId as string], ['maxResults', '500'],
      ['historyTypes', 'messageAdded'], ['historyTypes', 'labelAdded'], ['historyTypes', 'labelRemoved'],
      // Permanent deletions, so a deleted customer thread leaves the queue (markThreadDeleted).
      ['historyTypes', 'messageDeleted'],
    ];
    if (pageToken) params.push(['pageToken', pageToken]);
    const r = await gmailGet(budget, auth, 'history', params);
    if (r.status === 404 || r.status === 400) return { expired: true as const, status: r.status };
    if (!r.body) throw new Error(`Gmail history.list -> ${r.status}`);
    for (const rec of r.body.history ?? []) {
      // Drafts and chats are not mail we act on; skip messages added with those labels.
      const skip = new Set<string>((rec.messagesAdded ?? [])
        .filter((a: any) => (a.message?.labelIds ?? []).some((l: string) => l === 'DRAFT' || l === 'CHAT'))
        .map((a: any) => a.message.id));
      for (const m of rec.messages ?? []) if (!skip.has(m.id)) changed.add(m.threadId);
      historyId = rec.id;
    }
    pageToken = r.body.nextPageToken;
    if (!pageToken) { historyId = r.body.historyId ?? historyId; break; }
    // More pages than this run reads: resume after the last record we saw.
  }
  return { expired: false as const, changed, historyId };
}

export async function ingestGmail(env: IngestEnv, budget: Budget = Budget.from(env, GMAIL_LIMITS)): Promise<IngestSummary> {
  const summary: IngestSummary = { failedSources: [], failedItems: 0, processed: 0 };
  const db = budget.wrap(env.DB);
  const benv = { ...env, DB: db };
  const { results: sources } = await db
    .prepare(`SELECT * FROM source WHERE provider = 'gmail'`).all<any>();
  if (!sources.length) return summary;

  // One service account with domain-wide delegation reads every mailbox by
  // impersonating it (sub = the mailbox), scope gmail.readonly only.
  let serviceAccount: ServiceAccountKey;
  try {
    serviceAccount = parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch (err) {
    console.error(`gmail ingest skipped: GOOGLE_SERVICE_ACCOUNT_JSON is not usable (${(err as Error).message})`);
    summary.failedSources = sources.map((s: any) => s.address);
    return summary;
  }

  for (const src of sources) {
    if (!budget.canAfford(MAILBOX_FETCHES, MAILBOX_QUERIES)) {
      console.warn(`gmail ingest ${src.address}: budget exhausted before this mailbox; it runs next time`);
      break;
    }
    const cursor = parseCursor(src.sync_cursor);
    let mode = 'incremental';
    let detail = '';
    let processed = 0;
    try {
      const token = await serviceAccountToken(serviceAccount, src.address, GMAIL_READONLY, undefined, budget.fetch);
      const auth = { Authorization: `Bearer ${token}` };
      const exemptions = await loadExemptions(db);

      const seed = async () => {
        const profile = await gmailGet(budget, auth, 'profile');
        if (!profile.body?.historyId) throw new Error(`Gmail profile -> ${profile.status}`);
        cursor.historyId = String(profile.body.historyId);
        cursor.backfillPageToken = null;
        const page = await listWindowPage(budget, auth, cursor, null);
        detail = `query "${RECEIVED_QUERY}" includeSpamTrash=true -> ${page.messages} messages in ${page.threads} threads`;
      };

      if (!cursor.historyId) {
        mode = 'backfill';
        await seed();
      } else {
        const from = cursor.historyId;
        const h = await readHistory(budget, auth, cursor);
        if (h.expired) {
          mode = 'fallback';
          console.warn(`gmail ingest ${src.address}: mode=fallback historyId ${from} ${h.status === 404 ? 'expired' : 'invalid'} (${h.status}); re-seeding from a bounded window`);
          await seed();
        } else {
          queue(cursor, h.changed);
          cursor.historyId = h.historyId;
          detail = `historyId ${from} -> ${h.historyId}, ${h.changed.size} changed threads`;
          // Still catching up on the initial backfill: one more page when there is room.
          if (cursor.backfillPageToken && cursor.pending.length < GMAIL_LIMITS.threadsPerRun) {
            const page = await listWindowPage(budget, auth, cursor, cursor.backfillPageToken);
            if (page.expiredToken) cursor.backfillPageToken = null;
            detail += `; backfill page +${page.threads} threads`;
          }
        }
      }

      if (cursor.pending.length > GMAIL_LIMITS.maxPending) {
        console.warn(`gmail ingest ${src.address}: ${cursor.pending.length} threads queued; keeping ${GMAIL_LIMITS.maxPending}`);
        cursor.pending = cursor.pending.slice(0, GMAIL_LIMITS.maxPending);
      }

      while (cursor.pending.length && processed < GMAIL_LIMITS.threadsPerRun) {
        // Reserve this thread's fetch and base writes, plus the cursor write that ends the run.
        if (!budget.canAfford(1, THREAD_QUERIES + 1)) break;
        const threadId = cursor.pending[0];
        const itemId = `gmail:${threadId}`;
        try {
          await syncGmailThread(benv, src, auth, threadId, exemptions, budget);
          await clearFailure(db, src.id, itemId);
        } catch (err) {
          if (err instanceof DeferThread) break; // too big for what's left of this run; it stays first in line
          // One malformed thread is logged, recorded in ingest_failure, and skipped.
          summary.failedItems++;
          const { failures } = await recordFailure(db, src.id, itemId, err, Math.floor(Date.now() / 1000));
          console.error(`gmail ingest skipped thread ${threadId} in ${src.address} (failure ${failures})`, err);
        }
        cursor.pending.shift();
        processed++;
        summary.processed++;
      }
    } catch (err) {
      // Token, listing or history failure: this mailbox is skipped this run. One dead
      // mailbox must not stop the others. The cursor is not advanced.
      console.error(`gmail ingest failed for ${src.address}`, err);
      summary.failedSources.push(src.address);
      continue;
    }

    await db.prepare(`UPDATE source SET last_synced_at = ?2, sync_cursor = ?3 WHERE id = ?1`)
      .bind(src.id, Math.floor(Date.now() / 1000), JSON.stringify(cursor)).run();
    console.log(`gmail ingest ${src.address}: mode=${mode} ${detail}; processed ${processed} threads, ${cursor.pending.length} pending; subrequests fetch=${budget.fetches} d1=${budget.queries} (limits ${budget.maxSubrequests} / d1 ${budget.maxQueries})${budget.pastDeadline ? '; stopped at the run deadline' : ''}`);
  }
  return summary;
}

/** Fetch one Gmail thread and write it to its thread row. */
async function syncGmailThread(
  env: IngestEnv, src: { id: string; brand_id: string; address: string }, auth: Record<string, string>,
  threadId: string, exemptions: Exemptions, budget: Budget,
) {
  const res = await budget.fetch(`${GMAIL}threads/${threadId}?format=metadata`, { headers: auth });
  const now = Math.floor(Date.now() / 1000);
  // Every message deleted (verified on support@, round 8: threads.get is 404).
  if (res.status === 404) { await markThreadDeleted(env.DB, `gmail:${threadId}`, now); return; }
  if (!res.ok) throw new Error(`Gmail threads.get -> ${res.status}`);
  const t = await res.json<any>();
  if (!Array.isArray(t.messages)) throw new Error('Gmail thread without a messages array');
  // Drafts and chats are not conversation messages: a saved draft reply from
  // our address must never count as having replied.
  const msgs = t.messages.filter((m: any) => !(m.labelIds ?? []).some((l: string) => l === 'DRAFT' || l === 'CHAT'));
  // Nothing left but drafts or chats: if we had ingested it, its mail was deleted.
  if (!msgs.length) { await markThreadDeleted(env.DB, `gmail:${threadId}`, now); return; }

  const header = (m: any, name: string) =>
    m.payload.headers.find((h: any) => h.name.toLowerCase() === name)?.value ?? '';

  // Outbound = Gmail's SENT label (set for every send from this mailbox,
  // send-as aliases included) or an exact From match. Never a substring
  // match: that let alias replies count as inbound.
  const isInbound = (m: any) =>
    !(m.labelIds ?? []).includes('SENT') &&
    emailOf(header(m, 'from')) !== src.address.toLowerCase();

  // The customer is whoever opened the conversation with us: the sender
  // of the FIRST inbound message. Never the newest message, which may be
  // our own reply or a colleague cc'd in later.
  const firstIn = msgs.find(isInbound);
  // Nothing inbound: not a customer conversation. If we had ingested it, the customer's mail was deleted.
  if (!firstIn) { await markThreadDeleted(env.DB, `gmail:${threadId}`, now); return; }

  const customerFrom = header(firstIn, 'from');

  // Each reply in the thread can add a response row: make sure the writes fit.
  const replies = msgs.filter((m: any) => !isInbound(m)).length;
  if (!budget.canAfford(0, THREAD_QUERIES + replies + 1)) throw new DeferThread();

  // Triage from the first inbound message. Replying in this very thread
  // counts as having replied to its sender; record it for other threads too.
  const replied = msgs.some((m: any) => !isInbound(m));
  const customerAddress = emailOf(customerFrom);
  if (replied) {
    await env.DB.prepare(`
      INSERT INTO known_sender (address, first_seen_at, replied_at) VALUES (?1, ?2, ?2)
      ON CONFLICT (address) DO UPDATE SET replied_at = COALESCE(known_sender.replied_at, excluded.replied_at)
    `).bind(customerAddress, Math.floor(Date.now() / 1000)).run();
  }
  const headerMap: Record<string, string> = {};
  for (const h of firstIn.payload.headers) headerMap[h.name.toLowerCase()] = h.value;
  const verdict = classify(
    { from: customerFrom, subject: header(firstIn, 'subject'), headers: headerMap, labelIds: firstIn.labelIds ?? [] },
    replied ? { ...exemptions, everRepliedTo: new Set([...exemptions.everRepliedTo, customerAddress]) } : exemptions,
  );
  const secs = (m: any) => Math.floor(Number(m.internalDate) / 1000);

  // Gmail returns the whole thread, so the timeline is complete and
  // lib/thread-state.ts can decide status and awaiting_since exactly.
  const timeline: Observed[] = msgs.map((m: any) => ({ at: secs(m), inbound: isInbound(m) }));
  const newest = (inbound: boolean): number | null => {
    const times = timeline.filter((m) => m.inbound === inbound).map((m) => m.at);
    return times.length ? Math.max(...times) : null;
  };

  // Kept as sent, for the agent to act on (round 15). The same header the bulk
  // signal above reads: 76 of 297 threads in 30 days carry it, and every one of
  // those offered an https link (prove/unsubscribe.mjs).
  const listUnsubscribe = headerMap['list-unsubscribe'];
  const unsubscribe = listUnsubscribe
    ? JSON.stringify({ h: listUnsubscribe, ...(headerMap['list-unsubscribe-post'] ? { post: headerMap['list-unsubscribe-post'] } : {}) })
    : null;

  await syncThread(env.DB, {
    id: `gmail:${t.id}`,
    unsubscribe,
    source_id: src.id,
    brand_id: src.brand_id,
    channel: 'email',
    subject: header(msgs[0], 'subject') || '(no subject)',
    customer_name: customerFrom.replace(/<.*/, '').replace(/"/g, '').trim(),
    customer_handle: emailOf(customerFrom),
    refresh_customer: true,
    preview: (t.snippet ?? '').slice(0, 200),
    conversation_started_at: secs(msgs[0]),
    newest_inbound_at: newest(true),
    newest_outbound_at: newest(false),
    timeline,
    triage: {
      tier: verdict.tier,
      score: verdict.score,
      signals: verdict.signals.map(({ code, why }) => ({ code, why })),
    },
  }, Math.floor(Date.now() / 1000));
}
