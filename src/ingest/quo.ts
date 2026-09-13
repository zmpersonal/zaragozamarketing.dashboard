/**
 * Quo (formerly OpenPhone) ingest — calls and texts.
 *
 * The cron is the safety net. Webhooks in /hooks/quo are the fast path.
 */
import type { Env } from '../index.ts';
import { syncThread } from '../db/threads.ts';

const API = 'https://api.quo.com/';
const API_VERSION = '2026-03-30';

async function quo(env: Env, path: string, params: Record<string, string> = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: env.QUO_API_KEY, 'Quo-Api-Version': API_VERSION },
  });
  if (!res.ok) throw new Error(`Quo ${path} -> ${res.status}`);
  return res.json<any>();
}

export async function ingestQuo(env: Env) {
  const { results: sources } = await env.DB
    .prepare(`SELECT * FROM source WHERE provider = 'quo'`).all<any>();

  for (const src of sources) {
    try {
      // limit maxes out at 50 per Quo's docs, and the key is rate limited
      // to 10 req/sec. At our volume one page is plenty; paginate with
      // `after` + nextCursor if a backlog ever exceeds it.
      const convos = await quo(env, 'conversations', {
        phoneNumberId: src.address,
        limit: '50',
      });

      for (const c of convos.data ?? []) {
        const at = Math.floor(new Date(c.lastActivityAt ?? c.updatedAt).getTime() / 1000);
        const inbound = c.lastActivityDirection === 'incoming';

        // Quo's conversation list only reports the LATEST activity, so the
        // timeline is one event. lib/thread-state.ts holds an existing
        // awaiting_since across polls, which is what keeps the start of a run
        // of unanswered texts. conversation_started_at is when we first saw the
        // conversation, not necessarily its first message.
        await syncThread(env.DB, {
          id: `quo:${c.id}`,
          source_id: src.id,
          brand_id: src.brand_id,
          channel: 'phone',
          subject: c.lastActivityType === 'call' ? 'Call' : 'Text',
          customer_name: c.name ?? null,
          customer_handle: c.participants?.[0] ?? null,
          refresh_customer: false,
          preview: (c.previewText ?? '').slice(0, 200),
          conversation_started_at: at,
          newest_inbound_at: inbound ? at : null,
          newest_outbound_at: inbound ? null : at,
          timeline: [{ at, inbound }],
        }, Math.floor(Date.now() / 1000));
      }

      await env.DB.prepare(`UPDATE source SET last_synced_at = ?2 WHERE id = ?1`)
        .bind(src.id, Math.floor(Date.now() / 1000)).run();
    } catch (err) {
      console.error(`quo ingest failed for ${src.address}`, err);
    }
  }
}
