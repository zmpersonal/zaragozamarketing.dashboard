/**
 * Gmail ingest — the "email scan", running on a cron for every mailbox.
 *
 * Reads the whole received stream, the same population prove/triage.mjs
 * measures: everything received in the window, archived, auto-filtered,
 * spam and trash included, excluding only our sent mail, drafts and chats.
 * Reading only in:inbox would make the triage filter moot: mail a Gmail
 * filter or Gmail's spam judgment moved never reached the queue.
 *
 * Syncs a thread row per conversation, with a triage tier (customer / bulk /
 * spam) from the first inbound message.
 * Status and awaiting_since come from the full message timeline via
 * lib/thread-state.ts: waiting while any inbound message has no reply
 * after it, answered once the last word is ours.
 */
import type { Env } from '../index.ts';
import { emailOf } from '../lib/triage.ts';
import type { Observed } from '../lib/thread-state.ts';
import { syncThread } from '../db/threads.ts';
import { clearFailure, recordFailure } from '../db/failures.ts';
import { GMAIL_READONLY, parseServiceAccount, serviceAccountToken, type ServiceAccountKey } from '../lib/google-auth.ts';
import { classify, type Exemptions } from '../lib/triage.ts';
import { knownCustomerSet } from '../lib/known-customers.ts';

const WINDOW_DAYS = 30;
export const RECEIVED_QUERY = `in:anywhere newer_than:${WINDOW_DAYS}d -in:sent -in:drafts -in:chats`;

/** Every thread id with a received message matching the query, following nextPageToken to the end. */
async function receivedThreadIds(auth: Record<string, string>): Promise<{ messages: number; threadIds: string[] }> {
  const threadIds = new Set<string>();
  let messages = 0;
  let pageToken: string | undefined;
  do {
    const url = new URL(`${GMAIL}messages`);
    url.searchParams.set('q', RECEIVED_QUERY);
    // messages.list drops SPAM and TRASH unless asked.
    url.searchParams.set('includeSpamTrash', 'true');
    url.searchParams.set('maxResults', '500');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url, { headers: auth });
    if (!res.ok) throw new Error(`Gmail messages.list -> ${res.status}`);
    const page = await res.json<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string }>();
    for (const m of page.messages ?? []) { messages++; threadIds.add(m.threadId); }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return { messages, threadIds: [...threadIds] };
}

/** Exemptions from our own records: sender rules, verified customers, and everyone we have replied to. */
async function loadExemptions(db: D1Database): Promise<Exemptions> {
  const rules = (await db.prepare('SELECT address, verdict FROM sender_rule').all<{ address: string; verdict: string }>()).results;
  const replied = (await db.prepare(`
    SELECT address FROM known_sender WHERE replied_at IS NOT NULL
    UNION SELECT customer_handle FROM thread WHERE last_outbound_at IS NOT NULL AND customer_handle IS NOT NULL
  `).all<{ address: string }>()).results;
  return {
    markedReal: new Set(rules.filter((r) => r.verdict === 'customer').map((r) => r.address.toLowerCase())),
    markedSpam: new Set(rules.filter((r) => r.verdict === 'spam').map((r) => r.address.toLowerCase())),
    everRepliedTo: new Set(replied.map((r) => r.address.toLowerCase())),
    knownCustomers: knownCustomerSet(),
  };
}

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me/';

export async function ingestGmail(env: Env) {
  const { results: sources } = await env.DB
    .prepare(`SELECT * FROM source WHERE provider = 'gmail'`).all<any>();
  if (!sources.length) return;

  // One service account with domain-wide delegation reads every mailbox by
  // impersonating it (sub = the mailbox), scope gmail.readonly only.
  let serviceAccount: ServiceAccountKey;
  try {
    serviceAccount = parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch (err) {
    console.error(`gmail ingest skipped: GOOGLE_SERVICE_ACCOUNT_JSON is not usable (${(err as Error).message})`);
    return;
  }

  for (const src of sources) {
    try {
      const token = await serviceAccountToken(serviceAccount, src.address, GMAIL_READONLY);
      const auth = { Authorization: `Bearer ${token}` };

      const { messages, threadIds } = await receivedThreadIds(auth);
      console.log(`gmail ingest ${src.address}: query "${RECEIVED_QUERY}" includeSpamTrash=true -> ${messages} messages in ${threadIds.length} threads`);
      const exemptions = await loadExemptions(env.DB);

      for (const threadId of threadIds) {
        const stub = { id: threadId };
        // One malformed thread (bad payload, a value the database rejects)
        // is logged, recorded in ingest_failure, and skipped. It must not
        // stop the rest of the mailbox. A clean sync clears its record.
        const itemId = `gmail:${stub.id}`;
        try {
          await syncGmailThread(env, src, auth, stub.id, exemptions);
          await clearFailure(env.DB, src.id, itemId);
        } catch (err) {
          const { failures } = await recordFailure(env.DB, src.id, itemId, err, Math.floor(Date.now() / 1000));
          console.error(`gmail ingest skipped thread ${stub.id} in ${src.address} (failure ${failures})`, err);
        }
      }

      await env.DB.prepare(`UPDATE source SET last_synced_at = ?2 WHERE id = ?1`)
        .bind(src.id, Math.floor(Date.now() / 1000)).run();
    } catch (err) {
      // Token or list failure: this mailbox is skipped this run. One dead
      // mailbox must not stop the others.
      console.error(`gmail ingest failed for ${src.address}`, err);
    }
  }
}

/** Fetch one Gmail thread and write it to its thread row. */
async function syncGmailThread(
  env: Env, src: { id: string; brand_id: string; address: string }, auth: Record<string, string>,
  threadId: string, exemptions: Exemptions,
) {
  const t = await fetch(`${GMAIL}threads/${threadId}?format=metadata`, { headers: auth })
    .then((r) => r.json<any>());
  const msgs = t.messages ?? [];
  if (!msgs.length) return;

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
  if (!firstIn) return; // nothing inbound: not a customer conversation

  const customerFrom = header(firstIn, 'from');

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

  await syncThread(env.DB, {
    id: `gmail:${t.id}`,
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
