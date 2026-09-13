/**
 * Quo (formerly OpenPhone) webhook signature verification.
 *
 * Per support.quo.com/core-concepts/integrations/webhooks:
 *   header   openphone-signature: <scheme>;<version>;<timestamp>;<signature>
 *            scheme "hmac", version "1", timestamp in unix milliseconds,
 *            signature = base64(HMAC-SHA256(key, timestamp + "." + payload))
 *   key      the webhook's signing secret, base64-decoded to raw bytes
 *   payload  JSON with whitespace removed
 *   replay   reject timestamps outside a tolerance (they suggest 5 minutes)
 *
 * Quo's Python sample signs the raw request bytes and its Node sample signs
 * JSON.stringify(parsed body). Those agree when the body arrives compact; we
 * accept a match on either, so neither sample's reading can lock us out.
 * Both still require the secret, so accepting two forms admits no forgery.
 */

export const SIGNATURE_HEADER = 'openphone-signature';
export const TOLERANCE_MS = 5 * 60 * 1000;

function base64ToBytes(b64: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export async function verifyQuoSignature(
  header: string | null,
  rawBody: string,
  secretBase64: string,
  nowMs: number,
): Promise<boolean> {
  if (!header || !secretBase64) return false;

  const fields = header.split(';');
  if (fields.length !== 4) return false;
  const [scheme, version, timestamp, signature] = fields;
  if (scheme !== 'hmac' || version !== '1' || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowMs - Number(timestamp)) > TOLERANCE_MS) return false;

  const mac = base64ToBytes(signature);
  const keyBytes = base64ToBytes(secretBase64);
  if (!mac || !mac.length || !keyBytes || !keyBytes.length) return false;

  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
  );

  const candidates = [rawBody];
  try {
    const compact = JSON.stringify(JSON.parse(rawBody));
    if (compact !== rawBody) candidates.push(compact);
  } catch {
    // Not JSON: only the raw bytes can match.
  }

  const encoder = new TextEncoder();
  for (const payload of candidates) {
    // subtle.verify compares in constant time.
    if (await crypto.subtle.verify('HMAC', key, mac, encoder.encode(`${timestamp}.${payload}`))) {
      return true;
    }
  }
  return false;
}
