/**
 * Google service-account auth with domain-wide delegation.
 *
 * Signs a JWT as the service account (RS256, WebCrypto — works in Workers
 * and Node), impersonating a mailbox via `sub`, and exchanges it for an
 * access token (RFC 7523 JWT-bearer grant). There are no refresh tokens: a
 * token is minted on demand and cached per subject until shortly before it
 * expires.
 *
 * The key is a secret. Nothing here logs or returns it, and errors carry
 * only Google's error code and the subject.
 *   Worker: GOOGLE_SERVICE_ACCOUNT_JSON secret holds the key JSON.
 *   Local:  GOOGLE_SERVICE_ACCOUNT_FILE holds a path to the key file.
 */

export const GMAIL_READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const LIFETIME_SECONDS = 3600;    // Google's maximum
const REFRESH_MARGIN_SECONDS = 60;

export interface ServiceAccountKey {
  type: 'service_account';
  client_email: string;
  private_key: string;
  private_key_id?: string;
  token_uri?: string;
}

/** Parse and sanity-check key JSON. Throws without echoing the input. */
export function parseServiceAccount(json: string | undefined): ServiceAccountKey {
  let key: Partial<ServiceAccountKey> & { type?: string };
  try {
    key = JSON.parse(json ?? '');
  } catch {
    throw new Error('Service-account key is not valid JSON');
  }
  if (key?.type !== 'service_account' || typeof key.client_email !== 'string'
      || typeof key.private_key !== 'string' || !key.private_key.includes('PRIVATE KEY')) {
    throw new Error('Service-account key is missing type "service_account", client_email or private_key');
  }
  return key as ServiceAccountKey;
}

const encoder = new TextEncoder();
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = (value: unknown) => b64url(encoder.encode(JSON.stringify(value)));

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

const cache = new Map<string, { token: string; expiresAt: number }>();

/** For tests. */
export function clearTokenCache() {
  cache.clear();
}

export async function serviceAccountToken(
  key: ServiceAccountKey, subject: string, scope: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const cacheKey = `${key.client_email}|${subject}|${scope}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt - REFRESH_MARGIN_SECONDS > nowSeconds) return hit.token;

  const tokenUri = key.token_uri ?? DEFAULT_TOKEN_URI;
  const header = { alg: 'RS256', typ: 'JWT', ...(key.private_key_id ? { kid: key.private_key_id } : {}) };
  const claims = {
    iss: key.client_email, sub: subject, scope, aud: tokenUri,
    iat: nowSeconds, exp: nowSeconds + LIFETIME_SECONDS,
  };
  const unsigned = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  const signature = new Uint8Array(await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', await importPrivateKey(key.private_key), encoder.encode(unsigned),
  ));

  const res = await fetchImpl(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${b64url(signature)}`,
    }).toString(),
  });
  const body = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(`Google token exchange for ${subject} failed: ${res.status} ${body.error ?? ''} ${body.error_description ?? ''}`.trim());
  }
  cache.set(cacheKey, { token: body.access_token, expiresAt: nowSeconds + (body.expires_in ?? LIFETIME_SECONDS) });
  return body.access_token;
}
