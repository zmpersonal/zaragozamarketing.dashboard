/**
 * Gmail ingest — the "email scan", running on a cron for every mailbox.
 *
 * Scans each connected mailbox, upserts a thread row per conversation, and
 * decides waiting vs answered by looking at the direction of the LAST
 * message. That single rule is what makes the board honest.
 */
import type { Env } from '../index.ts';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me/';

async function tokenFor(env: Env, mailbox: string): Promise<string> {
  const tokens = JSON.parse(env.GOOGLE_REFRESH_TOKENS) as Record<string, string>;
  const refresh = tokens[mailbox];
  if (!refresh) throw new Error(`No refresh token stored for ${mailbox}`);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refresh,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed for ${mailbox}: ${res.status}`);
  return (await res.json<{ access_token: string }>()).access_token;
}

export async function ingestGmail(env: Env) {
  const { results: sources } = await env.DB
    .prepare(`SELECT * FROM source WHERE provider = 'gmail'`).all<any>();

  for (const src of sources) {
    try {
      const token = await tokenFor(env, src.address);
      const auth = { Authorization: `Bearer ${token}` };

      const list = await fetch(
        `${GMAIL}threads?q=${encodeURIComponent('in:inbox -in:chats newer_than:30d')}&maxResults=50`,
        { headers: auth }
      ).then((r) => r.json<any>());

      for (const stub of list.threads ?? []) {
        const t = await fetch(`${GMAIL}threads/${stub.id}?format=metadata`, { headers: auth })
          .then((r) => r.json<any>());
        const msgs = t.messages ?? [];
        if (!msgs.length) continue;

        const last = msgs[msgs.length - 1];
        const header = (m: any, name: string) =>
          m.payload.headers.find((h: any) => h.name.toLowerCase() === name)?.value ?? '';

        const from = header(last, 'from');
        const inbound = !from.toLowerCase().includes(src.address.toLowerCase());
        const firstAt = Math.floor(Number(msgs[0].internalDate) / 1000);
        const lastAt = Math.floor(Number(last.internalDate) / 1000);

        // Never clobber a status a human set. If the agent marked it
        // blocked, an unchanged mailbox shouldn't flip it back to waiting.
        await env.DB.prepare(`
          INSERT INTO thread (
            id, source_id, brand_id, channel, subject, customer_name,
            customer_handle, preview, status, first_inbound_at,
            last_inbound_at, last_outbound_at
          ) VALUES (?1,?2,?3,'email',?4,?5,?6,?7,?8,?9,?10,?11)
          ON CONFLICT(id) DO UPDATE SET
            preview        = excluded.preview,
            last_inbound_at  = MAX(thread.last_inbound_at, excluded.last_inbound_at),
            last_outbound_at = MAX(COALESCE(thread.last_outbound_at,0), COALESCE(excluded.last_outbound_at,0)),
            status = CASE
              WHEN thread.status IN ('blocked','closed') THEN thread.status
              ELSE excluded.status
            END
        `).bind(
          `gmail:${t.id}`, src.id, src.brand_id,
          header(msgs[0], 'subject') || '(no subject)',
          from.replace(/<.*/, '').replace(/"/g, '').trim(),
          (from.match(/<(.+)>/)?.[1] ?? from).toLowerCase(),
          (t.snippet ?? '').slice(0, 200),
          inbound ? 'waiting' : 'answered',
          firstAt,
          inbound ? lastAt : firstAt,
          inbound ? null : lastAt
        ).run();
      }

      await env.DB.prepare(`UPDATE source SET last_synced_at = ?2 WHERE id = ?1`)
        .bind(src.id, Math.floor(Date.now() / 1000)).run();
    } catch (err) {
      // One dead mailbox must not stop the other two.
      console.error(`gmail ingest failed for ${src.address}`, err);
    }
  }
}
