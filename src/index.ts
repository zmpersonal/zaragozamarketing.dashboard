/**
 * InHouse / THI support console — Cloudflare Worker
 *
 * Serves the dashboard, the API and the Quo webhook, which writes phone activity
 * as it happens. Scheduled ingest (Gmail, and Quo polling as the backstop) runs
 * hourly on GitHub Actions (scripts/ingest.mjs) against the same D1 database
 * over the REST API. No dependency on any AI provider.
 */

import { rescueThread, responseInsert } from './db/threads.ts';
import type { Db } from './db/db.ts';
import { listFailures } from './db/failures.ts';
import { verifyQuoWebhook, webhookHeaders } from './lib/quo-signature.ts';
import { ingestQuoWebhookEvent } from './ingest/quo.ts';

export interface Env {
  DB: D1Database;
  ACCESS_AUD: string;      // Cloudflare Access application audience tag
  ACCESS_TEAM: string;     // e.g. "inhouse" for inhouse.cloudflareaccess.com
  OWNERS: string;          // comma-separated emails that get the owner view
  QUO_WEBHOOK_SECRET: string;    // whsec_... signing key returned when the webhook is created (Standard Webhooks)
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
 * Action kinds that reach the customer. Logging one always records contact
 * (last_outbound_at). Whether it resolves the wait is the agent's call: only
 * a status of 'answered' or 'closed' stops the clock. A voicemail is contact,
 * not resolution.
 */
const CONTACT_KINDS = new Set(['replied', 'called']);

/** What an agent can log through POST /api/actions. System kinds (reopened, unblocked, deleted, rescued) are not accepted. */
const ACTION_KINDS = new Set(['replied', 'called', 'note', 'escalated']);
const AGENT_STATUSES = new Set(['waiting', 'answered', 'blocked', 'closed']);
const BLOCKED_ON = new Set(['customer', 'supplier', 'refund', 'shipping', 'owner', 'other']);

/**
 * Writes accept only same-origin JSON. A cross-site page can make the browser
 * send the Access cookie with a form POST (any content type a form allows) or a
 * "simple" fetch, so every POST must carry Content-Type application/json (which
 * a cross-site request can't send without a CORS preflight we never answer) and
 * an Origin equal to ours; Sec-Fetch-Site, when present, must be same-origin.
 */
function writeRefusal(req: Request, url: URL): Response | null {
  const type = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return json({ error: 'Content-Type must be application/json' }, 415);
  if (req.headers.get('origin') !== url.origin) return json({ error: 'Cross-origin request refused' }, 403);
  const site = req.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return json({ error: 'Cross-site request refused' }, 403);
  return null;
}

/** The request body as a JSON object, or null when it isn't one. */
async function jsonObject(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = await req.json();
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const threadExists = async (env: Env, id: string) =>
  !!(await env.DB.prepare('SELECT 1 AS ok FROM thread WHERE id = ?1').bind(id).first());

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
 * The queue is paged per tier (round 11). Each tier is its own query, so no
 * tier can crowd another out (round 8 found real Needs-reply threads missing
 * when one query served all three tiers under one LIMIT). Totals come from one
 * grouped COUNT(*). Nothing is hidden: a tier longer than a page says
 * "N of M" and the UI fetches the next page with ?tier=&offset=.
 */
export const QUEUE_PAGE = 50;
/** Rows per tier on the first page (kept by name for tests/queue-tiers). */
export const QUEUE_LIMITS = { customer: QUEUE_PAGE, bulk: QUEUE_PAGE, spam: QUEUE_PAGE };

type Tier = keyof typeof QUEUE_LIMITS;
const TIERS = Object.keys(QUEUE_LIMITS) as Tier[];
/** Anything not bulk or spam is Needs reply, matching the UI: an unknown tier is never dropped. */
const TIER_SQL: Record<Tier, string> = {
  customer: "t.triage NOT IN ('bulk','spam')",
  bulk: "t.triage = 'bulk'",
  spam: "t.triage = 'spam'",
};
const TIER_OF_ROW = "CASE WHEN t.triage IN ('bulk','spam') THEN t.triage ELSE 'customer' END";
const OPEN = "t.status IN ('waiting','blocked')";
const MINE = 'AND (t.assignee = ?1 OR t.assignee IS NULL)';

/**
 * What a queue row needs to render, and no more (round 11). Every row returned
 * is decoded into an object inside the Worker by the D1 binding, which was the
 * largest share of /api/queue's CPU; preview and notes load with the thread
 * (GET /api/threads/:id) when it is opened.
 */
const LIST_COLUMNS = `t.id, t.brand_id, t.channel, t.subject, t.customer_name, t.customer_handle,
           t.status, t.blocked_on, t.assignee, t.conversation_started_at, t.awaiting_since,
           t.blocked_since, t.is_automated, t.triage, t.triage_signals`;

/**
 * One page of one tier, in two groups:
 *   1. waiting: longest-waiting first, from awaiting_since (the oldest
 *      unanswered inbound), never conversation_started_at.
 *   2. blocked: below every waiting thread, longest-blocked first, from
 *      blocked_since. Blocked is a different kind of waiting, not ageless.
 * Priority orders within each group; the id breaks ties so pages don't overlap.
 */
async function queuePage(env: Env, user: User, mine: boolean, tier: Tier, offset: number) {
  const sql = `
    SELECT ${LIST_COLUMNS}
    FROM thread t
    WHERE ${OPEN} AND ${TIER_SQL[tier]} ${mine ? MINE : ''}
    ORDER BY t.status = 'blocked',
             t.priority DESC,
             CASE WHEN t.status = 'blocked' THEN t.blocked_since ELSE t.awaiting_since END IS NULL,
             CASE WHEN t.status = 'blocked' THEN t.blocked_since ELSE t.awaiting_since END ASC,
             t.conversation_started_at ASC,
             t.id ASC
    LIMIT ${QUEUE_PAGE} OFFSET ${offset}`;
  const stmt = mine ? env.DB.prepare(sql).bind(user.email) : env.DB.prepare(sql);
  return (await stmt.all()).results;
}

/** Open threads per tier, in one statement. */
async function tierTotals(env: Env, user: User, mine: boolean): Promise<Record<Tier, number>> {
  const sql = `SELECT ${TIER_OF_ROW} AS tier, COUNT(*) AS n FROM thread t WHERE ${OPEN} ${mine ? MINE : ''} GROUP BY 1`;
  const stmt = mine ? env.DB.prepare(sql).bind(user.email) : env.DB.prepare(sql);
  const totals = { customer: 0, bulk: 0, spam: 0 };
  for (const r of (await stmt.all<{ tier: Tier; n: number }>()).results) totals[r.tier] = r.n;
  return totals;
}

async function queue(env: Env, user: User, mine: boolean) {
  const [totals, ...pages] = await Promise.all([tierTotals(env, user, mine), ...TIERS.map((tier) => queuePage(env, user, mine, tier, 0))]);
  return {
    threads: pages.flat(),
    tiers: Object.fromEntries(TIERS.map((tier, i) => [tier, { shown: pages[i].length, total: totals[tier] }])),
    page_size: QUEUE_PAGE,
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

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const refused = writeRefusal(req, url);
      if (refused) return refused;
    }

    // --- reads -------------------------------------------------
    if (req.method === 'GET' && path === 'board') {
      // ingest_failures: items ingest could not sync, including skipped ones, so a stuck record is visible.
      return json({ user, board: await board(env), ingest_failures: await listFailures(env.DB) });
    }
    if (req.method === 'GET' && path === 'queue') {
      const tier = url.searchParams.get('tier');
      const offsetParam = url.searchParams.get('offset');
      if (tier === null) {
        if (offsetParam !== null) return json({ error: 'offset needs a tier' }, 400);
        return json(await queue(env, user, mine));
      }
      if (!(TIERS as string[]).includes(tier)) return json({ error: `tier must be one of ${TIERS.join(', ')}` }, 400);
      if (offsetParam !== null && !/^\d+$/.test(offsetParam)) return json({ error: 'offset must be a whole number' }, 400);
      const offset = Number(offsetParam ?? 0);
      const [totals, threads] = await Promise.all([tierTotals(env, user, mine), queuePage(env, user, mine, tier as Tier, offset)]);
      return json({ tier, offset, threads, shown: threads.length, total: totals[tier as Tier], page_size: QUEUE_PAGE });
    }
    if (req.method === 'GET' && path === 'todos') {
      return json({ todos: await todos(env, user, mine) });
    }
    if (req.method === 'GET' && path.startsWith('threads/')) {
      let id: string;
      try { id = decodeURIComponent(path.slice(8)); } catch { return json({ error: 'Bad thread id' }, 400); }
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
      const raw = await jsonObject(req);
      if (!raw) return json({ error: 'Body must be a JSON object' }, 400);
      const b = raw as {
        thread_id: string; kind: string; body?: string | null;
        status?: string | null; blocked_on?: string | null; blocked_note?: string | null;
      };
      if (typeof b.thread_id !== 'string' || !b.thread_id) return json({ error: 'thread_id required' }, 400);
      if (typeof b.kind !== 'string' || !ACTION_KINDS.has(b.kind)) return json({ error: `kind must be one of ${[...ACTION_KINDS].join(', ')}` }, 400);
      if (b.status != null && !AGENT_STATUSES.has(b.status)) return json({ error: `status must be one of ${[...AGENT_STATUSES].join(', ')}` }, 400);
      if (b.blocked_on != null && !BLOCKED_ON.has(b.blocked_on)) return json({ error: `blocked_on must be one of ${[...BLOCKED_ON].join(', ')}` }, 400);
      if (b.body != null && typeof b.body !== 'string') return json({ error: 'body must be text' }, 400);
      if (!(await threadExists(env, b.thread_id))) return json({ error: 'No such thread' }, 404);

      const at = now();
      // Typed as Db: the binding satisfies the same interface ingest uses over HTTP.
      const db: Db = env.DB;
      const batch = [
        db.prepare(
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
      await db.batch(batch);
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
      const raw = await jsonObject(req);
      if (!raw) return json({ error: 'Body must be a JSON object' }, 400);
      const b = raw as { title?: unknown; detail?: string; brand_id?: string; thread_id?: string; assignee?: string; due_at?: number };
      if (typeof b.title !== 'string' || !b.title) return json({ error: 'title required' }, 400);
      if (b.thread_id != null && !(await threadExists(env, String(b.thread_id)))) return json({ error: 'No such thread' }, 404);
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
      if (!/^\d+$/.test(id)) return json({ error: 'No such to-do' }, 404);
      const res = await env.DB.prepare('UPDATE todo SET done_at = ?2 WHERE id = ?1')
        .bind(Number(id), now()).run();
      return res.meta.changes ? json({ ok: true }) : json({ error: 'No such to-do' }, 404);
    }

    return json({ error: 'No such route' }, 404);
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

  // webhook-id is stable across Quo's retries: a delivery already processed is
  // acknowledged and not processed again. It is recorded only after processing
  // succeeds, so a delivery that failed here is processed when Quo retries it.
  const webhookId = req.headers.get('webhook-id') as string; // verified present above
  const seen = await env.DB.prepare('SELECT 1 AS seen FROM webhook_delivery WHERE webhook_id = ?1').bind(webhookId).first();
  if (seen) return json({ ok: true, result: 'duplicate' });

  const at = Math.floor(Date.now() / 1000);
  let result: 'synced' | 'ignored' | 'malformed';
  try {
    result = await ingestQuoWebhookEvent(env.DB, event, at);
  } catch (err) {
    console.error(`quo webhook ${webhookId} (${event.type}) failed; Quo will retry`, err);
    return json({ error: 'Could not record the event' }, 500);
  }
  if (result === 'malformed') return json({ error: 'Malformed event' }, 400);

  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO webhook_delivery (webhook_id, event_type, received_at) VALUES (?1, ?2, ?3)')
      .bind(webhookId, event.type ?? null, at),
    env.DB.prepare('DELETE FROM webhook_delivery WHERE received_at < ?1').bind(at - 7 * 86400),
  ]);
  return json({ ok: true, result });
}
