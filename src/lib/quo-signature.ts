/**
 * Quo webhook signature verification — Standard Webhooks.
 *
 * This follows Quo's current versioned docs (API 2026-03-30,
 * www.quo.com/docs/2026-03-30/webhooks-overview and webhooks-quickstart),
 * which specify one scheme, compatible with the Svix SDK:
 *   webhook-id         delivery id (idempotency key, stable across retries)
 *   webhook-timestamp  unix SECONDS when Quo signed
 *   webhook-signature  space-separated "v1,<base64>" entries
 *   signed content     `${webhook-id}.${webhook-timestamp}.${raw body}`
 *   key                the "whsec_..." secret, base64-decoded after the prefix
 *   mac                HMAC-SHA256; reject timestamps > 5 minutes off
 * (Standard Webhooks spec: github.com/standard-webhooks/standard-webhooks)
 *
 * The legacy `openphone-signature` scheme (support.quo.com) is NOT accepted:
 * its two published samples disagree on key handling, so a delivery signed
 * that way fails closed with 401. See HANDOFF.
 */

export const TOLERANCE_SECONDS = 5 * 60;

export interface WebhookHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

export const webhookHeaders = (h: Headers): WebhookHeaders => ({
  id: h.get('webhook-id'),
  timestamp: h.get('webhook-timestamp'),
  signature: h.get('webhook-signature'),
});

function base64ToBytes(b64: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export async function verifyQuoWebhook(
  headers: WebhookHeaders,
  rawBody: string,
  secret: string,
  nowSeconds: number,
): Promise<boolean> {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !secret) return false;

  if (!/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) return false;

  const keyBytes = base64ToBytes(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret);
  if (!keyBytes || !keyBytes.length) return false;
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const content = new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`);

  // Several entries allow key rotation. Only symmetric v1 entries are ours;
  // anything else (e.g. asymmetric v1a) is ignored, not trusted.
  for (const entry of signature.split(' ')) {
    const comma = entry.indexOf(',');
    if (comma < 0 || entry.slice(0, comma) !== 'v1') continue;
    const mac = base64ToBytes(entry.slice(comma + 1));
    if (!mac || !mac.length) continue;
    // subtle.verify compares in constant time.
    if (await crypto.subtle.verify('HMAC', key, mac, content)) return true;
  }
  return false;
}
