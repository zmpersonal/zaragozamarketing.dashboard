/**
 * InHouse / THI support console — Cloudflare Worker
 *
 * Serves the dashboard and the API, behind Cloudflare Access. The Quo webhook
 * runs as a separate Worker (src/hooks.ts). Scheduled ingest (Gmail, and Quo polling as the backstop) runs
 * hourly on GitHub Actions (scripts/ingest.mjs) against the same D1 database
 * over the REST API. No dependency on any AI provider.
 */

import { rescueThread, responseInsert } from './db/threads.ts';
import type { Db } from './db/db.ts';
import { listFailures } from './db/failures.ts';
import { businessTimeBefore } from './lib/clock.ts';
import { parseUnsubscribe } from './lib/unsubscribe.ts';
import { threadLink } from './lib/links.ts';
import { buildReport, DEFAULT_DAYS, MAX_DAYS } from './report.ts';

export interface Env {
  DB: D1Database;
  ACCESS_AUD: string;      // Cloudflare Access application audience tag
  ACCESS_TEAM: string;     // e.g. "inhouse" for inhouse.cloudflareaccess.com
  OWNERS: string;          // comma-separated emails that get the owner view
  /**
   * Comma-separated emails a thread may be assigned to (round 15). Config, not
   * a table: identity is the Access JWT and this list, and a person who cannot
   * sign in should not be assignable. Unset means nobody, so the picker is
   * empty rather than wrong.
   */
  AGENTS?: string;
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

const emails = (list: string | undefined) =>
  (list ?? '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => s.includes('@'));

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

/** Channels the schema knows. The nav shows email and phone; chat is real but not wired to a source yet. */
const CHANNELS = new Set(['email', 'phone', 'chat']);
const MAX_BRAND_ID = 64;

export interface QueueFilter { channel: string | null; brand: string | null }

/**
 * Who and what the queue is being asked for, as a WHERE fragment and its binds
 * (round 15). Channel and brand are applied by the database, not by the
 * browser: 60 phone threads filled the first 50-row page, so a client-side
 * "Email" filter would have shown an empty list with 12 emails behind it, and
 * every "N of M" would have been a lie.
 */
function queueWhere(user: User, mine: boolean, f: QueueFilter, extra?: string) {
  const clauses = [OPEN];
  const args: unknown[] = [];
  const next = () => `?${args.length}`;
  if (mine) { args.push(user.email); clauses.push(`(t.assignee = ${next()} OR t.assignee IS NULL)`); }
  if (f.channel) { args.push(f.channel); clauses.push(`t.channel = ${next()}`); }
  if (f.brand) { args.push(f.brand); clauses.push(`t.brand_id = ${next()}`); }
  if (extra) clauses.push(extra);
  return { where: clauses.join(' AND '), args };
}

/** The filters on a queue request, or an error response. */
function readFilter(url: URL): QueueFilter | Response {
  const channel = url.searchParams.get('channel');
  const brand = url.searchParams.get('brand');
  if (channel !== null && !CHANNELS.has(channel)) return json({ error: `channel must be one of ${[...CHANNELS].join(', ')}` }, 400);
  if (brand !== null && (brand === '' || brand.length > MAX_BRAND_ID)) return json({ error: 'brand is not a brand id' }, 400);
  return { channel, brand };
}

/**
 * What a queue row needs to render, and no more (round 11). Every row returned
 * is decoded into an object inside the Worker by the D1 binding, which was the
 * largest share of /api/queue's CPU; preview and notes load with the thread
 * (GET /api/threads/:id) when it is opened.
 */
// Slim rows (round 11): only what the list renders. The preview joined them in
// round 14, truncated in SQL — a phone row's subject is just "Voicemail", and
// the transcript is what tells one row from another. Notes and the full preview
// still come with GET /api/threads/:id.
const LIST_COLUMNS = `t.id, t.brand_id, t.channel, t.subject, t.customer_name, t.customer_handle,
           t.status, t.blocked_on, t.assignee, t.conversation_started_at, t.awaiting_since,
           t.blocked_since, t.is_automated, t.triage, t.triage_signals, substr(t.preview, 1, 120) AS preview`;

/**
 * One page of one tier, in two groups:
 *   1. waiting: longest-waiting first, from awaiting_since (the oldest
 *      unanswered inbound), never conversation_started_at.
 *   2. blocked: below every waiting thread, longest-blocked first, from
 *      blocked_since. Blocked is a different kind of waiting, not ageless.
 * Priority orders within each group; the id breaks ties so pages don't overlap.
 */
async function queuePage(env: Env, user: User, mine: boolean, f: QueueFilter, tier: Tier, offset: number) {
  const { where, args } = queueWhere(user, mine, f, TIER_SQL[tier]);
  const sql = `
    SELECT ${LIST_COLUMNS}
    FROM thread t
    WHERE ${where}
    ORDER BY t.status = 'blocked',
             t.priority DESC,
             CASE WHEN t.status = 'blocked' THEN t.blocked_since ELSE t.awaiting_since END IS NULL,
             CASE WHEN t.status = 'blocked' THEN t.blocked_since ELSE t.awaiting_since END ASC,
             t.conversation_started_at ASC,
             t.id ASC
    LIMIT ${QUEUE_PAGE} OFFSET ${offset}`;
  const stmt = args.length ? env.DB.prepare(sql).bind(...args) : env.DB.prepare(sql);
  return (await stmt.all()).results;
}

/** Open threads per tier, in one statement. */
async function tierTotals(env: Env, user: User, mine: boolean, f: QueueFilter): Promise<Record<Tier, number>> {
  const { where, args } = queueWhere(user, mine, f);
  const sql = `SELECT ${TIER_OF_ROW} AS tier, COUNT(*) AS n FROM thread t WHERE ${where} GROUP BY 1`;
  const stmt = args.length ? env.DB.prepare(sql).bind(...args) : env.DB.prepare(sql);
  const totals = { customer: 0, bulk: 0, spam: 0 };
  for (const r of (await stmt.all<{ tier: Tier; n: number }>()).results) totals[r.tier] = r.n;
  return totals;
}

async function queue(env: Env, user: User, mine: boolean, f: QueueFilter) {
  const [totals, ...pages] = await Promise.all([tierTotals(env, user, mine, f), ...TIERS.map((tier) => queuePage(env, user, mine, f, tier, 0))]);
  return {
    threads: pages.flat(),
    tiers: Object.fromEntries(TIERS.map((tier, i) => [tier, { shown: pages[i].length, total: totals[tier] }])),
    page_size: QUEUE_PAGE,
  };
}

/** Open to-dos are paged with a total, like the queue (round 11: a 101st to-do used to vanish). */
export const TODO_PAGE = 100;

async function todos(env: Env, user: User, mine: boolean, offset: number) {
  const where = `done_at IS NULL ${mine ? 'AND (assignee = ?1 OR assignee IS NULL)' : ''}`;
  const b = (sql: string) => (mine ? env.DB.prepare(sql).bind(user.email) : env.DB.prepare(sql));
  const [rows, count] = await Promise.all([
    b(`SELECT id, brand_id, thread_id, title, detail, assignee, due_at, created_at
       FROM todo WHERE ${where}
       ORDER BY due_at IS NULL, due_at ASC, created_at DESC, id DESC
       LIMIT ${TODO_PAGE} OFFSET ${offset}`).all(),
    b(`SELECT COUNT(*) AS n FROM todo WHERE ${where}`).first<{ n: number }>(),
  ]);
  return { todos: rows.results, total: count?.n ?? 0, offset, page_size: TODO_PAGE };
}

// ---------------------------------------------------------------
// Router
// ---------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // The Quo webhook is not served here: this Worker sits behind Cloudflare
    // Access, which can't exempt a path. It runs as its own Worker (src/hooks.ts).
    if (url.pathname.startsWith('/hooks/')) {
      return json({ error: 'Webhooks are served by the inhouse-ops-hooks Worker' }, 404);
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
      // sources + now: the UI shows each source's last successful sync against the server's clock.
      const sources = (await env.DB.prepare('SELECT id, brand_id, provider, channel, address, last_synced_at FROM source ORDER BY channel, id').all()).results;
      return json({
        user, board: await board(env), ingest_failures: await listFailures(env.DB), sources, now: now(),
        // Who a thread can be assigned to (round 15), and the two business-time
        // boundaries the queue colours and the "over 24h" filter use, so the
        // browser never has to do business-hour arithmetic (invariant 6).
        agents: emails(env.AGENTS),
        business_thresholds: { h4: businessTimeBefore(now(), 4 * 60), h24: businessTimeBefore(now(), 24 * 60) },
      });
    }
    if (req.method === 'GET' && path === 'queue') {
      const filter = readFilter(url);
      if (filter instanceof Response) return filter;
      const tier = url.searchParams.get('tier');
      const offsetParam = url.searchParams.get('offset');
      if (tier === null) {
        if (offsetParam !== null) return json({ error: 'offset needs a tier' }, 400);
        return json(await queue(env, user, mine, filter));
      }
      if (!(TIERS as string[]).includes(tier)) return json({ error: `tier must be one of ${TIERS.join(', ')}` }, 400);
      if (offsetParam !== null && !/^\d+$/.test(offsetParam)) return json({ error: 'offset must be a whole number' }, 400);
      const offset = Number(offsetParam ?? 0);
      const [totals, threads] = await Promise.all([tierTotals(env, user, mine, filter), queuePage(env, user, mine, filter, tier as Tier, offset)]);
      return json({ tier, offset, threads, shown: threads.length, total: totals[tier as Tier], page_size: QUEUE_PAGE, channel: filter.channel, brand: filter.brand });
    }
    // The admin view. Owners only: it is about how the people answering are doing.
    if (req.method === 'GET' && path === 'report') {
      if (user.role !== 'owner') return json({ error: 'Owners only' }, 403);
      const daysParam = url.searchParams.get('days');
      if (daysParam !== null && !/^\d+$/.test(daysParam)) return json({ error: 'days must be a whole number' }, 400);
      const days = Number(daysParam ?? DEFAULT_DAYS);
      if (days < 1 || days > MAX_DAYS) return json({ error: `days must be between 1 and ${MAX_DAYS}` }, 400);
      const sources = new Map(
        (await env.DB.prepare('SELECT id, address FROM source').all<{ id: string; address: string }>()).results
          .map((r) => [r.id, r.address]),
      );
      return json({ user, ...(await buildReport(env.DB, sources, now(), days)) });
    }
    if (req.method === 'GET' && path === 'todos') {
      const offsetParam = url.searchParams.get('offset');
      if (offsetParam !== null && !/^\d+$/.test(offsetParam)) return json({ error: 'offset must be a whole number' }, 400);
      return json(await todos(env, user, mine, Number(offsetParam ?? 0)));
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
      // Parsed here rather than at ingest, so a parsing change reaches threads
      // already stored. Nothing but http(s) and mailto survives it, and we hold
      // gmail.readonly: this is a link for the agent, never an action we take.
      const stored = (thread as { unsubscribe?: string | null }).unsubscribe;
      let unsubscribe = null;
      if (stored) {
        try {
          const raw = JSON.parse(stored) as { h?: unknown; post?: unknown };
          unsubscribe = parseUnsubscribe(raw?.h, raw?.post);
        } catch { unsubscribe = null; }
      }
      const source = await env.DB.prepare('SELECT address FROM source WHERE id = ?1')
        .bind((thread as { source_id?: string }).source_id ?? '').first<{ address: string }>();
      return json({ thread, actions, unsubscribe, link: threadLink(thread as { id: string }, source?.address ?? null) });
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

    // Assignment. No agent table: the people here are config (AGENTS), and who
    // assigned whom is an action row like every other human touch, so the admin
    // report can attribute the work.
    if (req.method === 'POST' && path.startsWith('threads/') && path.endsWith('/assign')) {
      const id = decodeURIComponent(path.slice('threads/'.length, -'/assign'.length));
      const raw = await jsonObject(req);
      if (!raw) return json({ error: 'Body must be a JSON object' }, 400);
      if (!('assignee' in raw)) return json({ error: 'assignee is required (null to unassign)' }, 400);
      const value = raw.assignee;
      if (value !== null && typeof value !== 'string') return json({ error: 'assignee must be an email or null' }, 400);
      const assignee = value === null ? null : value.trim().toLowerCase();
      if (assignee !== null && !emails(env.AGENTS).includes(assignee)) {
        return json({ error: 'assignee must be one of the people in AGENTS' }, 400);
      }
      if (!(await threadExists(env, id))) return json({ error: 'No such thread' }, 404);
      const at = now();
      const db: Db = env.DB;
      await db.batch([
        db.prepare('UPDATE thread SET assignee = ?2 WHERE id = ?1').bind(id, assignee),
        db.prepare(`INSERT INTO action (thread_id, actor, kind, body, created_at) VALUES (?1, ?2, 'assigned', ?3, ?4)`)
          .bind(id, user.email, assignee ? `Assigned to ${assignee}.` : 'Unassigned.', at),
      ]);
      return json({ ok: true, assignee });
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
