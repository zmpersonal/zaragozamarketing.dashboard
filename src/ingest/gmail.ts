/**
 * Gmail ingest — the "email scan", running on a cron for every mailbox.
 *
 * Scans each connected mailbox and syncs a thread row per conversation.
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

      const list = await fetch(
        `${GMAIL}threads?q=${encodeURIComponent('in:inbox -in:chats newer_than:30d')}&maxResults=50`,
        { headers: auth }
      ).then((r) => r.json<any>());

      for (const stub of list.threads ?? []) {
        // One malformed thread (bad payload, a value the database rejects)
        // is logged, recorded in ingest_failure, and skipped. It must not
        // stop the rest of the mailbox. A clean sync clears its record.
        const itemId = `gmail:${stub.id}`;
        try {
          await syncGmailThread(env, src, auth, stub.id);
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
async function syncGmailThread(env: Env, src: { id: string; brand_id: string; address: string }, auth: Record<string, string>, threadId: string) {
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
  }, Math.floor(Date.now() / 1000));
}
