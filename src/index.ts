/**
 * InHouse / THI support console — Cloudflare Worker
 *
 * Serves the dashboard, exposes the API, and runs ingest on a cron.
 * No dependency on any AI provider: if every subscription lapses, this
 * keeps polling Gmail and Quo and keeps serving the board.
 */

import { ingestGmail } from './ingest/gmail.ts';
import { ingestQuo } from './ingest/quo.ts';
import { rescueThread, responseInsert } from './db/threads.ts';
import { listFailures } from './db/failures.ts';
import { verifyQuoWebhook, webhookHeaders } from './lib/quo-signature.ts';

export interface Env {
  DB: D1Database;
  ACCESS_AUD: string;      // Cloudflare Access application audience tag
  ACCESS_TEAM: string;     // e.g. "inhouse" for inhouse.cloudflareaccess.com
  OWNERS: string;          // comma-separated emails that get the owner view
  /** Service-account key JSON (domain-wide delegation, gmail.readonly). A secret; Workers have no filesystem. */
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
  QUO_API_KEY: string;
  QUO_WEBHOOK_SECRET: string;
  /** Optional per-invocation ingest budget overrides. Workers Paid is required; see CLAUDE.md "Hosting cost". */
  INGEST_MAX_SUBREQUESTS?: string;
  INGEST_MAX_D1_QUERIES?: string;
  ASSETS: Fetcher;
}

type User = { email: string; role: 'owner' | 'agent' };

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const now = () => Math.floor(Date.now() / 1000);

/** Must match [triggers] crons in wrangler.toml. */
export const GMAIL_CRON = '*/5 * * * *';
export const QUO_CRON = '2-59/5 * * * *';

/**
 * Action kinds that reach the customer. Logging one always records contact
 * (last_outbound_at). Whether it resolves the wait is the agent's call: only
 * a status of 'answered' or 'closed' stops the clock. A voicemail is contact,
 * not resolution.
 */
const CONTACT_KINDS = new Set(['replied', 'called']);

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

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [rawHeader, rawPayload, rawSig] = parts;

  // Anything malformed (bad base64, bad JSON) is an unauthenticated request,
  // not a server error.
  const b64url = (s: string) =>
    Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  let payload: { exp?: unknown; aud?: unknown; email?: unknown };
  let sig: Uint8Array;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64url(rawPayload)));
    sig = b64url(rawSig);
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;

  // exp is required: a token that never expires is not an Access token.
  if (typeof payload.exp !== 'number' || payload.exp < now()) return null;
  // aud may be a string or an array; either way it must match exactly.
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (typeof payload.email !== 'string' || !payload.email.includes('@')) return null;

  const certs = await fetch(
    `https://${env.ACCESS_TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`
  ).then((r) => r.json<{ keys: JsonWebKey[] }>());

  let verified = false;
  for (const jwk of certs.keys) {
    const key = await crypto.subtle.importKey(
      'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
    );
    if (await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', key, sig,
      new TextEncoder().encode(`${rawHeader}.${rawPayload}`)
    )) { verified = true; break; }
  }
  if (!verified) return null;

  const email = payload.email.toLowerCase();
  const owners = env.OWNERS.toLowerCase().split(',').map((s) => s.trim());
  return { email, role: owners.includes(email) ? 'owner' : 'agent' };
}

// ---------------------------------------------------------------
// Queries
// ---------------------------------------------------------------

/**
 * The top strip: waiting count and oldest item per brand × channel, for
 * Needs-reply threads only. Bulk and spam are counted in their own queue
 * sections, never in these header numbers.
 */
async function board(env: Env) {
  const { results } = await env.DB.prepare(`
    SELECT brand_id, channel,
           COUNT(*)                    AS waiting,
           MIN(awaiting_since)         AS oldest_at,
           SUM(status = 'blocked')     AS blocked
    FROM thread
    WHERE status IN ('waiting','blocked') AND triage = 'customer'
    GROUP BY brand_id, channel
  `).all();
  return results;
}

/**
 * Rows returned per tier. Each tier is its own query with its own limit, so
 * no tier can crowd another out: round 8 found real Needs-reply threads
 * missing because one query served all three tiers and older spam used up a
 * shared LIMIT. The response reports shown vs total per tier, so a cut list
 * is visible instead of silent.
 */
export const QUEUE_LIMITS = { customer: 500, bulk: 200, spam: 200 };

type Tier = keyof typeof QUEUE_LIMITS;
/** Anything not bulk or spam is Needs reply, matching the UI: an unknown tier is never dropped. */
const TIER_SQL: Record<Tier, string> = {
  customer: "t.triage NOT IN ('bulk','spam')",
  bulk: "t.triage = 'bulk'",
  spam: "t.triage = 'spam'",
};

/**
 * One tier of the queue, in two groups:
 *   1. waiting: longest-waiting first, from awaiting_since (the oldest
 *      unanswered inbound), never conversation_started_at.
 *   2. blocked: below every waiting thread, longest-blocked first, from
 *      blocked_since. Blocked is a different kind of waiting, not ageless.
 * Priority orders within each group.
 */
async function queueTier(env: Env, user: User, mine: boolean, tier: Tier) {
  const where = `t.status IN ('waiting','blocked') AND ${TIER_SQL[tier]}
      ${mine ? 'AND (t.assignee = ?1 OR t.assignee IS NULL)' : ''}`;
  const bind = (sql: string) => (mine ? env.DB.prepare(sql).bind(user.email) : env.DB.prepare(sql));
  const rows = await bind(`
    SELECT t.id, t.brand_id, t.channel, t.subject, t.customer_name,
           t.customer_handle, t.preview, t.status, t.blocked_on, t.blocked_note,
           t.assignee, t.priority, t.conversation_started_at, t.last_inbound_at,
           t.awaiting_since, t.blocked_since, t.is_automated, t.triage, t.triage_signals
    FROM thread t
    WHERE ${where}
    ORDER BY t.status = 'blocked',
             t.priority DESC,
             CASE WHEN t.status = 'blocked' THEN t.blocked_since ELSE t.awaiting_since END IS NULL,
             CASE WHEN t.status = 'blocked' THEN t.blocked_since ELSE t.awaiting_since END ASC,
             t.conversation_started_at ASC
    LIMIT ${QUEUE_LIMITS[tier]}`).all();
  const count = await bind(`SELECT COUNT(*) AS n FROM thread t WHERE ${where}`).first<{ n: number }>();
  return { threads: rows.results, shown: rows.results.length, total: count?.n ?? rows.results.length };
}

async function queue(env: Env, user: User, mine: boolean) {
  const tiers = Object.keys(QUEUE_LIMITS) as Tier[];
  const parts = await Promise.all(tiers.map((tier) => queueTier(env, user, mine, tier)));
  return {
    threads: parts.flatMap((p) => p.threads),
    tiers: Object.fromEntries(tiers.map((tier, i) => [tier, { shown: parts[i].shown, total: parts[i].total }])),
  };
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
      // ingest_failures: items ingest could not sync, including skipped ones, so a stuck record is visible.
      return json({ user, board: await board(env), ingest_failures: await listFailures(env.DB) });
    }
    if (req.method === 'GET' && path === 'queue') {
      return json(await queue(env, user, mine));
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

      const at = now();
      const batch = [
        env.DB.prepare(
          `INSERT INTO action (thread_id, actor, kind, body, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5)`
        ).bind(b.thread_id, user.email, b.kind, b.body ?? null, at),
      ];

      // The agent's chosen status is authoritative. Contact ('replied',
      // 'called') always stamps last_outbound_at; the clock stops only if the
      // agent chose 'answered' or 'closed'. Ingest honours that: a stored
      // contact ends the wait only while awaiting_since is cleared
      // (lib/thread-state.ts). Other kinds never touch last_outbound_at.
      const contact = CONTACT_KINDS.has(b.kind);

      // If this action stops the clock, measure the wait it ends first.
      const stopsClock = b.status === 'closed' || (contact && b.status === 'answered');
      if (stopsClock) {
        const current = await env.DB.prepare('SELECT awaiting_since FROM thread WHERE id = ?1')
          .bind(b.thread_id).first<{ awaiting_since: number | null }>();
        if (current?.awaiting_since != null) {
          const via = contact ? (b.kind as 'replied' | 'called') : 'closed';
          batch.push(responseInsert(env.DB, b.thread_id, current.awaiting_since, at, via, user.email, at));
        }
      }

      if (b.status || contact) {
        batch.push(
          env.DB.prepare(
            `UPDATE thread
             -- 'answered' without contact while the clock is still running would take the
             -- customer out of the queue, and incremental ingest won't re-read an unchanged
             -- thread to correct it, so it is stored as 'waiting'.
             SET status = CASE
                   WHEN ?2 = 'answered' AND NOT ?7 AND awaiting_since IS NOT NULL THEN 'waiting'
                   ELSE COALESCE(?2, status)
                 END,
                 blocked_on   = CASE WHEN ?2 IS NULL THEN blocked_on ELSE ?3 END,
                 blocked_note = CASE WHEN ?2 IS NULL THEN blocked_note ELSE ?4 END,
                 -- set on the move to blocked, kept while it stays blocked, cleared on leaving
                 blocked_since = CASE
                   WHEN ?2 IS NULL THEN blocked_since
                   WHEN ?2 = 'blocked' THEN CASE WHEN status = 'blocked' THEN COALESCE(blocked_since, ?6) ELSE ?6 END
                   ELSE NULL
                 END,
                 assignee = COALESCE(assignee, ?5),
                 last_outbound_at = CASE WHEN ?7 THEN ?6 ELSE last_outbound_at END,
                 closed_at = CASE WHEN ?2 IS NULL THEN closed_at WHEN ?2 = 'closed' THEN ?6 ELSE NULL END,
                 -- only the agent choosing 'answered' (with contact) or 'closed' stops the clock
                 awaiting_since = CASE
                   WHEN ?2 = 'closed' THEN NULL
                   WHEN ?7 AND ?2 = 'answered' THEN NULL
                   ELSE awaiting_since
                 END
             WHERE id = ?1`
          ).bind(
            b.thread_id, b.status ?? null, b.blocked_on ?? null, b.blocked_note ?? null,
            user.email, at, contact ? 1 : 0
          )
        );
      }
      await env.DB.batch(batch);
      return json({ ok: true });
    }

    // Rescue a demoted thread into the queue. Triage verdict only: arrival
    // time and awaiting_since are untouched, so the clock stays honest.
    if (req.method === 'POST' && path.startsWith('threads/') && path.endsWith('/rescue')) {
      const id = decodeURIComponent(path.slice('threads/'.length, -'/rescue'.length));
      const found = await rescueThread(env.DB, id, user.email, now());
      return found ? json({ ok: true }) : json({ error: 'No such thread' }, 404);
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

  /**
   * Separate cron triggers (wrangler.toml), so Gmail and Quo each get a whole
   * invocation's subrequest budget instead of sharing one.
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (event.cron === GMAIL_CRON) ctx.waitUntil(ingestGmail(env));
    else if (event.cron === QUO_CRON) ctx.waitUntil(ingestQuo(env));
    else console.warn(`scheduled: no ingest is wired to cron "${event.cron}"`);
  },
};

/**
 * Public endpoint: nothing in the body is trusted until its Standard Webhooks
 * signature verifies (lib/quo-signature.ts). Anything else, including the
 * legacy openphone-signature header, gets a 401. Fails closed if the signing
 * secret is not configured.
 */
async function handleQuoWebhook(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // Read the raw text once: the signature covers these exact bytes.
  const raw = await req.text();

  if (!env.QUO_WEBHOOK_SECRET) {
    console.error('QUO_WEBHOOK_SECRET is not set; rejecting Quo webhook');
    return json({ error: 'Invalid signature' }, 401);
  }
  const verified = await verifyQuoWebhook(
    webhookHeaders(req.headers), raw, env.QUO_WEBHOOK_SECRET, Math.floor(Date.now() / 1000),
  );
  if (!verified) return json({ error: 'Invalid signature' }, 401);

  let event: { type?: string };
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: 'Body is not JSON' }, 400);
  }
  console.log('quo webhook', event.type);
  return json({ ok: true });
}
