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

// One mailbox, modelled on real Gmail labels. Only part of the received stream
// is still in the inbox: some is archived, filtered to a label, spam or trash.
const mail = {
  'm-inbox':    { labelIds: ['INBOX'], at: now - 1 * day, headers: [h('From', 'Dana Reyes <dana@example.com>'), h('Subject', 'Sauna heater tripping the breaker')] },
  'm-archived': { labelIds: ['CATEGORY_PERSONAL'], at: now - 2 * day, headers: [h('From', 'Sam Ortiz <sam@example.com>'), h('Subject', 'Re: chiller warranty question and the 220v wiring for the plunge tub')] },
  'm-filtered': { labelIds: ['Label_Suppliers', 'CATEGORY_PROMOTIONS'], at: now - 3 * day, headers: [h('From', 'Brand Weekly <news@brand.example>'), h('Subject', 'This week only'), h('List-Unsubscribe', '<mailto:u@brand.example>')] },
  'm-spam':     { labelIds: ['SPAM'], at: now - 4 * day, headers: [h('From', 'Prize Desk <win@prize.example>'), h('Subject', 'You have won')] },
  'm-trash':    { labelIds: ['TRASH'], at: now - 5 * day, headers: [h('From', 'Google Calendar <no-reply-calendar@google.com>'), h('Subject', 'Invitation: supplier call')] },
  'm-priya':    { labelIds: ['CATEGORY_UPDATES'], at: now - 6 * day, headers: [h('From', 'Priya Raman <priya@acme.example>'), h('Subject', 'Invoice 2214'), h('List-Unsubscribe', '<https://acme.example/u>')] },
  'm-known':    { labelIds: ['SPAM'], at: now - 7 * day, headers: [h('From', 'A Customer <verified.customer@example.com>'), h('Subject', 'Track A Shipment - Priority1 for A Customer')] },
  'm-spambulk': { labelIds: ['SPAM', 'CATEGORY_PROMOTIONS'], at: now - 8 * day, headers: [h('From', 'Deals <deals@spammy.example>'), h('Subject', 'Huge sale'), h('List-Unsubscribe', '<mailto:u@spammy.example>')] },
  'm-old':      { labelIds: ['INBOX'], at: now - 40 * day, headers: [h('From', 'Old Customer <old@example.com>'), h('Subject', 'Outside the window')] },
  'm-sent':     { labelIds: ['SENT'], at: now - 1 * day, headers: [h('From', 'InHouse <support@inhousewellness.com>'), h('Subject', 'Re: heater'), h('To', 'Dana Reyes <dana@example.com>')] },
  'm-draft':    { labelIds: ['DRAFT'], at: now - 1 * day, headers: [h('From', 'InHouse <support@inhousewellness.com>'), h('Subject', 'draft')] },
  'm-chat':     { labelIds: ['CHAT'], at: now - 1 * day, headers: [h('From', 'Teammate <team@inhousewellness.com>'), h('Subject', 'chat')] },
  // Sent over the last 180 days; the reply to Priya is on the SECOND page.
  's1': { labelIds: ['SENT'], at: now - 10 * day, headers: [h('To', 'Someone <someone@example.com>')] },
  's2': { labelIds: ['SENT'], at: now - 11 * day, headers: [h('To', 'Other <other@example.com>')] },
  's3': { labelIds: ['SENT'], at: now - 90 * day, headers: [h('To', 'Priya Raman <priya@acme.example>')] },
};
const threads = { t1: { id: 't1', messages: [{ id: 'm-inbox', internalDate: String(now - day), labelIds: ['INBOX'], payload: { headers: mail['m-inbox'].headers } }] } };

/** Gmail search semantics for the operators the scripts use. Unknown operators fail loudly. */
function search(q, includeSpamTrash) {
  const LABEL = { inbox: 'INBOX', sent: 'SENT', drafts: 'DRAFT', chats: 'CHAT', spam: 'SPAM', trash: 'TRASH' };
  let pool = Object.entries(mail);
  let anywhere = false;
  for (const token of q.trim().split(/\s+/)) {
    let m;
    if (token === 'in:anywhere') anywhere = true;
    else if ((m = token.match(/^in:(inbox|sent)$/))) pool = pool.filter(([, x]) => x.labelIds.includes(LABEL[m[1]]));
    else if ((m = token.match(/^-in:(sent|drafts|chats|spam|trash)$/))) pool = pool.filter(([, x]) => !x.labelIds.includes(LABEL[m[1]]));
    else if ((m = token.match(/^newer_than:(\d+)d$/))) pool = pool.filter(([, x]) => x.at >= now - Number(m[1]) * day);
    else throw new Error('fake Gmail does not understand query token: ' + token);
  }
  // messages.list leaves out SPAM and TRASH unless includeSpamTrash=true.
  if (!(anywhere && includeSpamTrash)) pool = pool.filter(([, x]) => !x.labelIds.some((l) => l === 'SPAM' || l === 'TRASH'));
  return pool.sort((a, b) => b[1].at - a[1].at).map(([id]) => id);
}
const PAGE_SIZE = 2; // real pages are larger; small pages make a missing pageToken loop visible

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
    let ids;
    try { ids = search(q, url.searchParams.get('includeSpamTrash') === 'true'); }
    catch (err) { return json({ error: { code: 400, message: err.message } }, 400); }
    const start = Number(url.searchParams.get('pageToken') ?? 0);
    const size = Math.min(PAGE_SIZE, Number(url.searchParams.get('maxResults') ?? 100));
    const page = ids.slice(start, start + size);
    const next = start + size < ids.length ? String(start + size) : undefined;
    return json({ messages: page.map((id) => ({ id })), resultSizeEstimate: ids.length, ...(next ? { nextPageToken: next } : {}) });
  }
  if (path.startsWith('messages/')) {
    const id = path.slice('messages/'.length);
    const m = mail[id];
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
