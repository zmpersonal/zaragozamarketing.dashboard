// A throwaway service-account key generated per test run (never a real key),
// plus a fake Google token endpoint that verifies the JWT-bearer assertion the
// way Google does: RS256 signature by that key, iss/sub/scope/aud/iat/exp.
export const TOKEN_URI = 'https://oauth2.googleapis.com/token';
export const GMAIL_READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
export const CLIENT_EMAIL = 'console-ingest@inhouse-ops-test.iam.gserviceaccount.com';

const ALG = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
const keys = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64');
const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;

export const PUBLIC_JWK = await crypto.subtle.exportKey('jwk', keys.publicKey);

export const SERVICE_ACCOUNT = {
  type: 'service_account',
  project_id: 'inhouse-ops-test',
  private_key_id: 'test-key-id-1',
  private_key: pem,
  client_email: CLIENT_EMAIL,
  client_id: '1234567890',
  token_uri: TOKEN_URI,
};
export const SERVICE_ACCOUNT_JSON = JSON.stringify(SERVICE_ACCOUNT);

const fromB64url = (s) => Buffer.from(s, 'base64url');

/** Verify a JWT-bearer token request. Returns { ok, claims, header, error }. */
export async function verifyAssertion(body, publicJwk = PUBLIC_JWK) {
  const form = new URLSearchParams(body);
  if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
    return { ok: false, error: 'unsupported_grant_type:' + form.get('grant_type') };
  }
  const [h, p, s] = (form.get('assertion') ?? '').split('.');
  if (!s) return { ok: false, error: 'invalid_grant: malformed assertion' };
  const key = await crypto.subtle.importKey('jwk', publicJwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(s), new TextEncoder().encode(`${h}.${p}`));
  if (!valid) return { ok: false, error: 'invalid_grant: bad signature' };
  return { ok: true, header: JSON.parse(fromB64url(h)), claims: JSON.parse(fromB64url(p)) };
}

/** Token endpoint response for a verified assertion: one access token per subject. */
export async function tokenResponse(body, requests) {
  const v = await verifyAssertion(body);
  requests?.push(v);
  if (!v.ok) return new Response(JSON.stringify({ error: 'invalid_grant', error_description: v.error }), { status: 400 });
  return new Response(JSON.stringify({ access_token: `sa-token-for-${v.claims.sub}`, expires_in: 3600, token_type: 'Bearer' }),
    { headers: { 'content-type': 'application/json' } });
}
