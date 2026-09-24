/**
 * The Quo webhook, shared by the hooks Worker (src/hooks.ts).
 *
 * Public endpoint: nothing in the body is trusted until its Standard Webhooks
 * signature verifies (lib/quo-signature.ts). Anything else, including the
 * legacy openphone-signature header, gets a 401. Fails closed if the signing
 * secret is not configured.
 */
import type { Db } from './db/db.ts';
import { verifyQuoWebhook, webhookHeaders } from './lib/quo-signature.ts';
import { ingestQuoWebhookEvent } from './ingest/quo.ts';

export interface HooksEnv {
  DB: D1Database | Db;
  /** whsec_... signing key returned when the webhook is created (Standard Webhooks). */
  QUO_WEBHOOK_SECRET: string;
  /** Rate-limiting binding ([[ratelimits]] in wrangler.hooks.toml). Optional: see the note below. */
  HOOK_RATE_LIMIT?: RateLimit;
}

/** The `period` of that binding. Sent as Retry-After, so the two must agree. */
export const RATE_LIMIT_PERIOD_SECONDS = 10;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export async function handleQuoWebhook(req: Request, env: HooksEnv): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // A cost guard, and it has to sit here: verifying means reading the whole body
  // and running an HMAC over it, and this endpoint is public, so anyone can ask
  // us to do that as often as they like. Cloudflare's WAF can't do it for us —
  // rate-limiting rules run on zones and workers.dev is not in one (round 12).
  //
  // It is NOT a security control. The binding is permissive and eventually
  // consistent, and counts per Cloudflare location rather than globally, so the
  // real ceiling is a multiple of the configured one. The signature below stays
  // the trust boundary. An unconfigured binding passes through on purpose: a
  // cost guard must not turn a config slip into a phone outage.
  if (env.HOOK_RATE_LIMIT) {
    const { success } = await env.HOOK_RATE_LIMIT.limit({ key: req.headers.get('cf-connecting-ip') ?? 'no-client-ip' });
    if (!success) {
      return new Response(JSON.stringify({ error: 'Too many requests' }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': String(RATE_LIMIT_PERIOD_SECONDS) },
      });
    }
  }

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
  const db: Db = env.DB;
  const seen = await db.prepare('SELECT 1 AS seen FROM webhook_delivery WHERE webhook_id = ?1').bind(webhookId).first();
  if (seen) return json({ ok: true, result: 'duplicate' });

  const at = Math.floor(Date.now() / 1000);
  let result: 'synced' | 'ignored' | 'malformed';
  try {
    result = await ingestQuoWebhookEvent(db, event, at);
  } catch (err) {
    console.error(`quo webhook ${webhookId} (${event.type}) failed; Quo will retry`, err);
    return json({ error: 'Could not record the event' }, 500);
  }
  if (result === 'malformed') return json({ error: 'Malformed event' }, 400);

  await db.batch([
    db.prepare('INSERT OR IGNORE INTO webhook_delivery (webhook_id, event_type, received_at) VALUES (?1, ?2, ?3)')
      .bind(webhookId, event.type ?? null, at),
    db.prepare('DELETE FROM webhook_delivery WHERE received_at < ?1').bind(at - 7 * 86400),
  ]);
  return json({ ok: true, result });
}
