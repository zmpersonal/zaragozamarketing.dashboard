// Fake Gmail API for ingest tests: the token endpoint, messages.list (with
// Gmail's search semantics for the operators ingest uses, includeSpamTrash
// and small pages), threads.list and threads.get, from an in-memory mailbox
// the test mutates between ingest runs.
import { makeD1 } from './d1.mjs';
import { SERVICE_ACCOUNT_JSON, TOKEN_URI, verifyAssertion, tokenResponse } from './google-sa.mjs';

export { SERVICE_ACCOUNT_JSON };

export const MAILBOX = 'support@inhousewellness.com';
export const SOURCE_ID = `gmail:${MAILBOX}`;

export const at = (iso) => Date.parse(iso) / 1000;

/** Inbound message from a customer. opts.labelIds replaces ['INBOX'] (e.g. archived: [], spam: ['SPAM']). */
export const inbound = (iso, from, subject = 'Sauna heater tripping the breaker', opts = {}) => ({
  iso, from, subject, labelIds: opts.labelIds ?? ['INBOX'], headers: opts.headers ?? {},
});

/** Message we sent. Gmail puts SENT on everything sent from the mailbox, aliases included. */
export const outbound = (iso, from = `InHouse Support <${MAILBOX}>`, subject = 'Re: Sauna heater tripping the breaker') => ({
  iso, from, subject, labelIds: ['SENT'],
});

export function makeEnv() {
  const DB = makeD1();
  DB.raw.exec(`
    INSERT INTO source (id, brand_id, channel, provider, address)
    VALUES ('${SOURCE_ID}', 'inhouse', 'email', 'gmail', '${MAILBOX}');
  `);
  return {
    DB,
    GOOGLE_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT_JSON,
  };
}

export const PAGE_SIZE = 2; // small pages make a missing pageToken loop visible

/** Gmail search over the fake mailbox. Unknown operators throw, so an untested query fails loudly. */
function search(threads, q, includeSpamTrash) {
  const LABEL = { inbox: 'INBOX', sent: 'SENT', drafts: 'DRAFT', chats: 'CHAT', spam: 'SPAM', trash: 'TRASH' };
  let pool = [];
  for (const [threadId, msgs] of Object.entries(threads)) {
    if (msgs.raw) { pool.push({ id: `${threadId}-raw`, threadId, labelIds: ['INBOX'], at: Infinity, raw: true }); continue; }
    msgs.forEach((m, i) => pool.push({ id: `${threadId}-${i}`, threadId, labelIds: m.labelIds, at: Date.parse(m.iso) }));
  }
  let anywhere = false;
  for (const token of q.trim().split(/\s+/)) {
    let m;
    if (token === 'in:anywhere') anywhere = true;
    else if ((m = token.match(/^in:(inbox|sent)$/))) pool = pool.filter((x) => x.raw || x.labelIds.includes(LABEL[m[1]]));
    else if ((m = token.match(/^-in:(sent|drafts|chats|spam|trash)$/))) pool = pool.filter((x) => !x.labelIds.includes(LABEL[m[1]]));
    else if ((m = token.match(/^newer_than:(\d+)d$/))) pool = pool.filter((x) => x.raw || x.at >= Date.now() - Number(m[1]) * 86400_000);
    else throw new Error('fake Gmail does not understand query token: ' + token);
  }
  if (!(anywhere && includeSpamTrash)) pool = pool.filter((x) => !x.labelIds.some((l) => l === 'SPAM' || l === 'TRASH'));
  return pool;
}

/**
 * Run fn with fetch answering from `threads` ({ [threadId]: message[] }).
 * The token endpoint only accepts a valid service-account JWT-bearer assertion.
 * Gmail calls must carry the token minted for the impersonated mailbox.
 * opts.requests collects every Gmail URL requested.
 */
export async function withGmail(threads, fn, { onToken, onGmail, requests } = {}) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    const ok = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

    if (url.href === TOKEN_URI) {
      const body = String(init?.body ?? '');
      onToken?.(await verifyAssertion(body));
      return tokenResponse(body);
    }
    requests?.push(url);
    const headers = new Headers(init?.headers);
    onGmail?.(headers);
    if (!/^Bearer sa-token-for-/.test(headers.get('authorization') ?? '')) {
      return new Response(JSON.stringify({ error: { code: 401, message: 'no service-account token' } }), { status: 401 });
    }

    const path = url.pathname.replace('/gmail/v1/users/me/', '');
    const q = url.searchParams.get('q') ?? '';
    if (path === 'messages') {
      let hits;
      try { hits = search(threads, q, url.searchParams.get('includeSpamTrash') === 'true'); }
      catch (err) { return new Response(JSON.stringify({ error: { code: 400, message: err.message } }), { status: 400 }); }
      const start = Number(url.searchParams.get('pageToken') ?? 0);
      const size = Math.min(PAGE_SIZE, Number(url.searchParams.get('maxResults') ?? 100));
      const page = hits.slice(start, start + size);
      const next = start + size < hits.length ? String(start + size) : undefined;
      return ok({ messages: page.map(({ id, threadId }) => ({ id, threadId })), ...(next ? { nextPageToken: next } : {}) });
    }
    if (path === 'threads') {
      // threads.list: a thread matches if any of its messages match.
      let hits;
      try { hits = search(threads, q, url.searchParams.get('includeSpamTrash') === 'true'); }
      catch (err) { return new Response(JSON.stringify({ error: { code: 400, message: err.message } }), { status: 400 }); }
      return ok({ threads: [...new Set(hits.map((h) => h.threadId))].map((id) => ({ id })) });
    }
    if (path.startsWith('threads/')) {
      const id = path.slice('threads/'.length);
      const msgs = threads[id];
      if (!msgs) return new Response('not found', { status: 404 });
      if (msgs.raw) return ok({ id, ...msgs.raw }); // a thread served exactly as given, e.g. malformed
      return ok({
        id,
        snippet: msgs.at(-1).subject,
        messages: msgs.map((m, i) => ({
          id: `${id}-${i}`,
          threadId: id,
          internalDate: String(Date.parse(m.iso)),
          labelIds: m.labelIds,
          payload: { headers: [
            { name: 'From', value: m.from }, { name: 'Subject', value: m.subject },
            ...Object.entries(m.headers ?? {}).map(([name, value]) => ({ name, value })),
          ] },
        })),
      });
    }
    throw new Error('unexpected fetch in test: ' + url.href);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

export const row = (env, threadId) =>
  env.DB.prepare('SELECT * FROM thread WHERE id = ?1').bind(`gmail:${threadId}`).first();
