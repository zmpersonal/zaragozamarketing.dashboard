// Cloudflare Access stand-in: mints RS256 JWTs the way Access does and serves
// the matching public key at the team's certs URL, so authenticate() runs its
// real signature, expiry and audience checks.
import { makeD1 } from './d1.mjs';

export const TEAM = 'inhouse-test';
export const AUD = 'aud-4f1c9e0b7d';
export const OWNER = 'Owner@InHouseWellness.com';
export const CERTS_URL = `https://${TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`;

const ALG = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };

export const accessKeys = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
export const strangerKeys = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
const publicJwk = { ...(await crypto.subtle.exportKey('jwk', accessKeys.publicKey)), kid: 'k1', alg: 'RS256' };

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * A signed Access-style JWT. Override claims or the signing key per test.
 * Pass null for email, aud or exp to OMIT that claim (undefined would just
 * fall back to the default).
 */
export async function mintToken({ email = 'dana.agent@inhousewellness.com', aud = [AUD], exp = nowSec() + 3600, key = accessKeys.privateKey, extra = {} } = {}) {
  const header = b64url(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const claims = { iat: nowSec(), iss: `https://${TEAM}.cloudflareaccess.com`, ...extra };
  if (email !== null) claims.email = email;
  if (aud !== null) claims.aud = aud;
  if (exp !== null) claims.exp = exp;
  const payload = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(sig)}`;
}

export const expiredAt = () => nowSec() - 60;

export function makeApiEnv() {
  const DB = makeD1();
  DB.raw.exec(`INSERT INTO source (id, brand_id, channel, provider, address)
               VALUES ('gmail:support@inhousewellness.com', 'inhouse', 'email', 'gmail', 'support@inhousewellness.com')`);
  return {
    DB,
    ACCESS_TEAM: TEAM,
    ACCESS_AUD: AUD,
    OWNERS: `someone@else.com, ${OWNER}`,
    ASSETS: { fetch: async () => new Response('asset') },
  };
}

/** Run fn with fetch serving Access certs (and nothing else). */
export async function withAccess(fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url ?? String(input);
    if (url === CERTS_URL) return new Response(JSON.stringify({ keys: [publicJwk] }), { headers: { 'content-type': 'application/json' } });
    throw new Error('unexpected fetch in test: ' + url);
  };
  try { return await fn(); } finally { globalThis.fetch = realFetch; }
}

/** An /api request, authenticated by header token unless opts.cookie is set. Writes are same-origin JSON, as the UI sends them. */
export function apiRequest(path, { token, cookie, method = 'GET', body } = {}) {
  const headers = {};
  if (token) headers['Cf-Access-Jwt-Assertion'] = token;
  if (cookie) headers.cookie = `other=1; CF_Authorization=${cookie}`;
  if (body !== undefined || method !== 'GET') headers['content-type'] = 'application/json';
  if (method !== 'GET') headers.origin = 'https://console.example';
  return new Request(`https://console.example/api/${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Insert a thread row directly (for route tests that don't need ingest). */
export function insertThread(env, { id, status = 'waiting', assignee = null, awaiting_since = 1789480800, started = 1789480800, blocked_since = undefined }) {
  const cols = ['id', 'source_id', 'brand_id', 'channel', 'subject', 'status', 'assignee',
    'conversation_started_at', 'last_inbound_at', 'awaiting_since'];
  const vals = [id, 'gmail:support@inhousewellness.com', 'inhouse', 'email', `Subject ${id}`, status, assignee,
    started, started, awaiting_since];
  if (blocked_since !== undefined) { cols.push('blocked_since'); vals.push(blocked_since); }
  env.DB.raw.prepare(`INSERT INTO thread (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
}
