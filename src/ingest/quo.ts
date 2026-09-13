/**
 * Quo (formerly OpenPhone) ingest — calls and texts.
 *
 * The cron is the safety net. Webhooks in /hooks/quo are the fast path.
 */
import type { Env } from '../index.ts';

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

        await env.DB.prepare(`
          INSERT INTO thread (
            id, source_id, brand_id, channel, subject, customer_name,
            customer_handle, preview, status, first_inbound_at,
            last_inbound_at, last_outbound_at
          ) VALUES (?1,?2,?3,'phone',?4,?5,?6,?7,?8,?9,?10,?11)
          ON CONFLICT(id) DO UPDATE SET
            preview = excluded.preview,
            last_inbound_at = MAX(thread.last_inbound_at, excluded.last_inbound_at),
            status = CASE
              WHEN thread.status IN ('blocked','closed') THEN thread.status
              ELSE excluded.status
            END
        `).bind(
          `quo:${c.id}`, src.id, src.brand_id,
          c.lastActivityType === 'call' ? 'Call' : 'Text',
          c.name ?? null,
          c.participants?.[0] ?? null,
          (c.previewText ?? '').slice(0, 200),
          inbound ? 'waiting' : 'answered',
          at, at, inbound ? null : at
        ).run();
      }

      await env.DB.prepare(`UPDATE source SET last_synced_at = ?2 WHERE id = ?1`)
        .bind(src.id, Math.floor(Date.now() / 1000)).run();
    } catch (err) {
      console.error(`quo ingest failed for ${src.address}`, err);
    }
  }
}
