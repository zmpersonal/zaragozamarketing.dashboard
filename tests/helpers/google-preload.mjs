// Preloaded with `node --import` so a prove/ CLI runs against a fake Google:
// the token endpoint verifies the JWT-bearer assertion against the public key
// in PROVE_SA_PUBLIC_JWK (the test process holds the private key), and Gmail
// answers only with the token minted for the impersonated mailbox.
// Token claims are appended to PROVE_TOKEN_LOG as JSON lines.
import { appendFileSync } from 'node:fs';
import { verifyAssertion } from './google-sa.mjs';

const publicJwk = JSON.parse(process.env.PROVE_SA_PUBLIC_JWK);
const now = Date.now();
const day = 86400_000;
const h = (name, value) => ({ name, value });

const inbox = {
  m1: { labelIds: ['INBOX'], at: now - 1 * day, headers: [h('From', 'Dana Reyes <dana@example.com>'), h('Subject', 'Sauna heater tripping the breaker')] },
  m2: { labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'], at: now - 2 * day, headers: [h('From', 'Brand Weekly <news@brand.example>'), h('Subject', 'This week only'), h('List-Unsubscribe', '<mailto:u@brand.example>')] },
  m3: { labelIds: ['INBOX'], at: now - 3 * day, headers: [h('From', 'Priya Raman <priya@acme.example>'), h('Subject', 'Invoice 2214'), h('List-Unsubscribe', '<https://acme.example/u>')] },
};
const sent = { s1: { labelIds: ['SENT'], at: now - 20 * day, headers: [h('To', 'Priya Raman <priya@acme.example>')] } };
const threads = { t1: { id: 't1', messages: [{ id: 'm1', internalDate: String(now - day), labelIds: ['INBOX'], payload: { headers: inbox.m1.headers } }] } };

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
  if (url.href === 'https://oauth2.googleapis.com/token') {
    const v = await verifyAssertion(String(init?.body ?? ''), publicJwk);
    if (process.env.PROVE_TOKEN_LOG) appendFileSync(process.env.PROVE_TOKEN_LOG, JSON.stringify(v) + '\n');
    if (!v.ok) return json({ error: 'invalid_grant', error_description: v.error }, 400);
    return json({ access_token: `sa-token-for-${v.claims.sub}`, expires_in: 3600 });
  }
  if (url.origin !== 'https://gmail.googleapis.com') throw new Error('unexpected fetch: ' + url.href);
  const auth = new Headers(init?.headers).get('authorization') ?? '';
  if (auth !== 'Bearer sa-token-for-support@inhousewellness.com') return json({ error: { code: 401 } }, 401);

  const path = url.pathname.replace('/gmail/v1/users/me/', '');
  const q = url.searchParams.get('q') ?? '';
  if (path === 'messages') {
    const set = q.includes('in:sent') ? sent : inbox;
    return json({ messages: Object.keys(set).map((id) => ({ id })) });
  }
  if (path.startsWith('messages/')) {
    const id = path.slice('messages/'.length);
    const m = inbox[id] ?? sent[id];
    if (!m) return json({}, 404);
    // Real Gmail (verified against support@, round 4): with format=metadata,
    // metadataHeaders must be repeated once per header name. A value is matched
    // as one header name, so "From,Subject" matches nothing, and a payload with
    // no matching headers has no `headers` key at all.
    const wanted = url.searchParams.getAll('metadataHeaders').map((n) => n.toLowerCase());
    const headers = wanted.length ? m.headers.filter((x) => wanted.includes(x.name.toLowerCase())) : m.headers;
    return json({ id, labelIds: m.labelIds, internalDate: String(m.at), payload: headers.length ? { headers } : {} });
  }
  if (path === 'threads') return json({ threads: Object.keys(threads).map((id) => ({ id })) });
  if (path.startsWith('threads/')) return json(threads[path.slice('threads/'.length)] ?? {});
  throw new Error('unexpected Gmail path: ' + path);
};
