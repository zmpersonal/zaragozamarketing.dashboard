/**
 * InHouse / THI support console — Cloudflare Worker
 *
 * Serves the dashboard, exposes the API, and runs ingest on a cron.
 * No dependency on any AI provider: if every subscription lapses, this
 * keeps polling Gmail and Quo and keeps serving the board.
 */

import { ingestGmail } from './ingest/gmail';
import { ingestQuo } from './ingest/quo';

export interface Env {
  DB: D1Database;
  ACCESS_AUD: string;      // Cloudflare Access application audience tag
  ACCESS_TEAM: string;     // e.g. "inhouse" for inhouse.cloudflareaccess.com
  OWNERS: string;          // comma-separated emails that get the owner view
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REFRESH_TOKENS: string; // JSON: { "support@inhousewellness.com": "1//0..." }
  QUO_API_KEY: string;
  ASSETS: Fetcher;
}

type User = { email: string; role: 'owner' | 'agent' };

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const now = () => Math.floor(Date.now() / 1000);

/**
 * Identity comes from the Cloudflare Access JWT, which Access has already
 * validated at the edge before the request reaches us. We verify the
 * signature again anyway — a Worker can be reached directly if someone
 * ever misconfigures the route, and an unauthenticated write to this DB
 * would be a bad day.
 */
async function authenticate(req: Request, env: Env): Promise<User | null> {
  const token =
    req.headers.get('Cf-Access-Jwt-Assertion') ??
    (req.headers.get('cookie')?.match(/CF_Authorization=([^;]+)/)?.[1] ?? null);
  if (!token) return null;

  const certs = await fetch(
    `https://${env.ACCESS_TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`
  ).then((r) => r.json<{ keys: JsonWebKey[] }>());

  const [rawHeader, rawPayload, rawSig] = token.split('.');
  if (!rawSig) return null;

  const b64url = (s: string) =>
    Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const payload = JSON.parse(new TextDecoder().decode(b64url(rawPayload)));

  if (payload.exp < now()) return null;
  if (!(payload.aud ?? []).includes(env.ACCESS_AUD)) return null;

  let verified = false;
  for (const jwk of certs.keys) {
    const key = await crypto.subtle.importKey(
      'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
    );
    if (await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', key, b64url(rawSig),
      new TextEncoder().encode(`${rawHeader}.${rawPayload}`)
    )) { verified = true; break; }
  }
  if (!verified) return null;

  const email = String(payload.email).toLowerCase();
  const owners = env.OWNERS.toLowerCase().split(',').map((s) => s.trim());
  return { email, role: owners.includes(email) ? 'owner' : 'agent' };
}

// ---------------------------------------------------------------
// Queries
// ---------------------------------------------------------------

/** The top strip: waiting count and oldest item per brand × channel. */
async function board(env: Env) {
  const { results } = await env.DB.prepare(`
    SELECT brand_id, channel,
           COUNT(*)                    AS waiting,
           MIN(first_inbound_at)       AS oldest_at,
           SUM(status = 'blocked')     AS blocked
    FROM thread
    WHERE status IN ('waiting','blocked')
    GROUP BY brand_id, channel
  `).all();
  return results;
}

/** The queue. Oldest first — age is the only ranking that matters. */
async function queue(env: Env, user: User, mine: boolean) {
  const sql = `
    SELECT t.id, t.brand_id, t.channel, t.subject, t.customer_name,
           t.customer_handle, t.preview, t.status, t.blocked_on, t.blocked_note,
           t.assignee, t.priority, t.first_inbound_at, t.last_inbound_at,
           t.is_automated
    FROM thread t
    WHERE t.status IN ('waiting','blocked')
      ${mine ? 'AND (t.assignee = ?1 OR t.assignee IS NULL)' : ''}
    ORDER BY t.priority DESC, t.first_inbound_at ASC
    LIMIT 200`;
  const stmt = mine
    ? env.DB.prepare(sql).bind(user.email)
    : env.DB.prepare(sql);
  const { results } = await stmt.all();
  return results;
}

async function todos(env: Env, user: User, mine: boolean) {
  const sql = `
    SELECT id, brand_id, thread_id, title, detail, assignee, due_at, created_at
    FROM todo
    WHERE done_at IS NULL
      ${mine ? 'AND (assignee = ?1 OR assignee IS NULL)' : ''}
    ORDER BY due_at IS NULL, due_at ASC, created_at ASC
    LIMIT 100`;
  const stmt = mine ? env.DB.prepare(sql).bind(user.email) : env.DB.prepare(sql);
  const { results } = await stmt.all();
  return results;
}

// ---------------------------------------------------------------
// Router
// ---------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Inbound webhooks authenticate by signature, not by Access.
    if (url.pathname === '/hooks/quo') {
      return handleQuoWebhook(req, env);
    }

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(req);
    }

    const user = await authenticate(req, env);
    if (!user) return json({ error: 'Not signed in' }, 401);

    const path = url.pathname.slice(5);
    const mine = user.role === 'agent' || url.searchParams.get('mine') === '1';

    // --- reads -------------------------------------------------
    if (req.method === 'GET' && path === 'board') {
      return json({ user, board: await board(env) });
    }
    if (req.method === 'GET' && path === 'queue') {
      return json({ threads: await queue(env, user, mine) });
    }
    if (req.method === 'GET' && path === 'todos') {
      return json({ todos: await todos(env, user, mine) });
    }
    if (req.method === 'GET' && path.startsWith('threads/')) {
      const id = path.slice(8);
      const thread = await env.DB.prepare('SELECT * FROM thread WHERE id = ?1')
        .bind(id).first();
      if (!thread) return json({ error: 'No such thread' }, 404);
      const { results: actions } = await env.DB
        .prepare('SELECT * FROM action WHERE thread_id = ?1 ORDER BY created_at DESC')
        .bind(id).all();
      return json({ thread, actions });
    }

    // --- writes: the agent's "input actions and responses" -----
    if (req.method === 'POST' && path === 'actions') {
      const b = await req.json<{
        thread_id: string; kind: string; body?: string;
        status?: string; blocked_on?: string; blocked_note?: string;
      }>();
      if (!b.thread_id || !b.kind) return json({ error: 'thread_id and kind required' }, 400);

      const batch = [
        env.DB.prepare(
          `INSERT INTO action (thread_id, actor, kind, body, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5)`
        ).bind(b.thread_id, user.email, b.kind, b.body ?? null, now()),
      ];

      // Logging a reply is what moves a thread out of the waiting count.
      if (b.status) {
        batch.push(
          env.DB.prepare(
            `UPDATE thread
             SET status = ?2, blocked_on = ?3, blocked_note = ?4,
                 assignee = COALESCE(assignee, ?5),
                 last_outbound_at = ?6,
                 closed_at = CASE WHEN ?2 = 'closed' THEN ?6 ELSE NULL END
             WHERE id = ?1`
          ).bind(
            b.thread_id, b.status, b.blocked_on ?? null, b.blocked_note ?? null,
            user.email, now()
          )
        );
      }
      await env.DB.batch(batch);
      return json({ ok: true });
    }

    if (req.method === 'POST' && path === 'todos') {
      const b = await req.json<{
        title: string; detail?: string; brand_id?: string;
        thread_id?: string; assignee?: string; due_at?: number;
      }>();
      if (!b.title) return json({ error: 'title required' }, 400);
      await env.DB.prepare(
        `INSERT INTO todo (brand_id, thread_id, title, detail, assignee, due_at, created_by, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`
      ).bind(
        b.brand_id ?? null, b.thread_id ?? null, b.title, b.detail ?? null,
        b.assignee ?? user.email, b.due_at ?? null, user.email, now()
      ).run();
      return json({ ok: true });
    }

    if (req.method === 'POST' && path.startsWith('todos/') && path.endsWith('/done')) {
      const id = path.slice(6, -5);
      await env.DB.prepare('UPDATE todo SET done_at = ?2 WHERE id = ?1')
        .bind(id, now()).run();
      return json({ ok: true });
    }

    return json({ error: 'No such route' }, 404);
  },

  /** Cron catches anything the webhooks missed. Wired in wrangler.toml. */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(Promise.all([ingestGmail(env), ingestQuo(env)]));
  },
};

async function handleQuoWebhook(req: Request, env: Env): Promise<Response> {
  // TODO round 2: verify the Quo signature header before trusting the body.
  const event = await req.json<any>();
  console.log('quo webhook', event.type);
  return json({ ok: true });
}
