// Fake Gmail API for ingest tests: the token endpoint, messages.list (with
// Gmail's search semantics for the operators ingest uses, includeSpamTrash
// and small pages), threads.list and threads.get, from an in-memory mailbox
// the test mutates between ingest runs.
import { makeD1 } from './d1.mjs';
import { SERVICE_ACCOUNT_JSON, TOKEN_URI, verifyAssertion, tokenResponse } from './google-sa.mjs';

export { SERVICE_ACCOUNT_JSON };

/** The real fetch, captured at load: an enclosing fake may take other hosts, the network never does. */
const NATIVE_FETCH = globalThis.fetch;

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

export const PAGE_SIZE = 2; // pass { pageSize: PAGE_SIZE } to make a missing pageToken loop visible

// --- history ledger ---------------------------------------------------------
// Real Gmail (verified on support@, round 7): users.getProfile returns a numeric
// historyId; history.list returns records {id, messages[{id, threadId}],
// messagesAdded[{message{id, threadId, labelIds}}], labelsAdded/labelsRemoved}
// with increasing ids; an expired or future startHistoryId is 404, a
// non-numeric one is 400. The fake keeps a ledger per mailbox object and
// records a change whenever a test adds a message or changes its labels.
const ledgers = new WeakMap();
const ledgerOf = (threads) => {
  if (!ledgers.has(threads)) ledgers.set(threads, { historyId: 1000, seen: new Map(), records: [], expiredBefore: 0 });
  return ledgers.get(threads);
};

function scanLedger(threads) {
  const L = ledgerOf(threads);
  for (const [threadId, msgs] of Object.entries(threads)) {
    const list = msgs.raw ? [{ key: `${threadId}-raw`, labelIds: ['INBOX'] }] : msgs.map((m, i) => ({ key: `${threadId}-${i}`, labelIds: m.labelIds }));
    for (const { key, labelIds } of list) {
      const now = JSON.stringify([...labelIds].sort());
      const before = L.seen.get(key);
      if (before === now) continue;
      L.historyId += 1;
      const ref = { id: key, threadId };
      if (before === undefined) {
        L.records.push({ id: String(L.historyId), messages: [ref], messagesAdded: [{ message: { ...ref, labelIds } }] });
      } else {
        const was = JSON.parse(before);
        const added = labelIds.filter((l) => !was.includes(l));
        const removed = was.filter((l) => !labelIds.includes(l));
        L.records.push({
          id: String(L.historyId), messages: [ref],
          ...(added.length ? { labelsAdded: [{ message: { ...ref, labelIds }, labelIds: added }] } : {}),
          ...(removed.length ? { labelsRemoved: [{ message: { ...ref, labelIds }, labelIds: removed }] } : {}),
        });
      }
      L.seen.set(key, now);
    }
  }
  return L;
}

/** Make every history id so far unavailable, like Gmail after its retention window. */
export function expireHistory(threads) {
  const L = scanLedger(threads);
  L.expiredBefore = L.historyId + 1;
}

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
    else if ((m = token.match(/^in:(inbox|sent|trash|spam)$/))) {
      pool = pool.filter((x) => !x.raw && x.labelIds.includes(LABEL[m[1]]));
      if (m[1] === 'trash' || m[1] === 'spam') anywhere = true; // asking for trash/spam by name, with includeSpamTrash, returns it
    }
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
export async function withGmail(threads, fn, { onToken, onGmail, requests, pageSize = 100 } = {}) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    const ok = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

    if (url.href === TOKEN_URI) {
      const body = String(init?.body ?? '');
      onToken?.(await verifyAssertion(body));
      return tokenResponse(body);
    }
    if (url.origin !== 'https://gmail.googleapis.com') {
      if (realFetch !== NATIVE_FETCH) return realFetch(input, init); // e.g. a fake Quo or D1 API around this one
      throw new Error('unexpected fetch in test: ' + url.href);
    }
    requests?.push(url);
    const headers = new Headers(init?.headers);
    onGmail?.(headers);
    if (!/^Bearer sa-token-for-/.test(headers.get('authorization') ?? '')) {
      return new Response(JSON.stringify({ error: { code: 401, message: 'no service-account token' } }), { status: 401 });
    }

    const path = url.pathname.replace('/gmail/v1/users/me/', '');
    const q = url.searchParams.get('q') ?? '';
    if (path === 'profile') {
      return ok({ emailAddress: MAILBOX, historyId: String(scanLedger(threads).historyId) });
    }
    if (path === 'history') {
      const L = scanLedger(threads);
      const start = url.searchParams.get('startHistoryId') ?? '';
      if (!/^\d+$/.test(start)) return new Response(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT' } }), { status: 400 });
      if (Number(start) < L.expiredBefore || Number(start) > L.historyId) {
        return new Response(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND' } }), { status: 404 });
      }
      // historyTypes filters records to those carrying a matching change (Gmail returns all types when absent).
      const KEY = { messageAdded: 'messagesAdded', messageDeleted: 'messagesDeleted', labelAdded: 'labelsAdded', labelRemoved: 'labelsRemoved' };
      const types = url.searchParams.getAll('historyTypes').map((t) => KEY[t]);
      const after = L.records.filter((r) => Number(r.id) > Number(start) && (!types.length || types.some((k) => r[k])));
      const offset = Number(url.searchParams.get('pageToken') ?? 0);
      const size = Math.min(pageSize, Number(url.searchParams.get('maxResults') ?? 100));
      const page = after.slice(offset, offset + size);
      const next = offset + size < after.length ? String(offset + size) : undefined;
      return ok({ history: page, historyId: String(L.historyId), ...(next ? { nextPageToken: next } : {}) });
    }
    if (path === 'messages') {
      let hits;
      try { hits = search(threads, q, url.searchParams.get('includeSpamTrash') === 'true'); }
      catch (err) { return new Response(JSON.stringify({ error: { code: 400, message: err.message } }), { status: 400 }); }
      const start = Number(url.searchParams.get('pageToken') ?? 0);
      const size = Math.min(pageSize, Number(url.searchParams.get('maxResults') ?? 100));
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
