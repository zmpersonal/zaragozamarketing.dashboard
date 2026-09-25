// Fake Quo v1 API (www.quo.com/docs/mdx/api-reference): conversations,
// messages and calls, filtered by createdAfter, with every request recorded.
// Also serves the unversioned /conversations the pre-round-3 ingest called,
// so the old code can run in a red test.
import { makeD1 } from './d1.mjs';

/** The real fetch, captured at load: an enclosing fake may take other hosts, the network never does. */
const NATIVE_FETCH = globalThis.fetch;

export const PHONE = 'PN1';
export const SOURCE_ID = 'quo:PN1';
export const CUSTOMER = '+15125550142';

export const iso = (unixSec) => new Date(unixSec * 1000).toISOString();

export function makeQuoEnv() {
  const DB = makeD1();
  DB.raw.exec(`INSERT INTO source (id, brand_id, channel, provider, address)
               VALUES ('${SOURCE_ID}', 'inhouse', 'phone', 'quo', '${PHONE}')`);
  return { DB, QUO_API_KEY: 'test-key' };
}

/**
 * A mutable Quo account. conversations: { CN1: { participants, name, createdAt } }.
 * Add activity with text()/call(); each keeps the conversation's lastActivity fields current.
 */
export function makeQuoAccount() {
  const account = { conversations: {}, messages: {}, calls: {}, voicemails: {}, requests: [], fail: new Set() };

  const touch = (cn, at, direction, type) => {
    const c = account.conversations[cn];
    if (!c.lastActivityAt || at >= Date.parse(c.lastActivityAt) / 1000) {
      Object.assign(c, { lastActivityAt: iso(at), lastActivityDirection: direction, lastActivityType: type });
    }
  };

  account.conversation = (cn, { participants = [CUSTOMER], name = 'Marcus Bell', createdAt }) => {
    account.conversations[cn] = { id: cn, phoneNumberId: PHONE, participants, name, createdAt: iso(createdAt), updatedAt: iso(createdAt) };
    account.messages[cn] = [];
    account.calls[cn] = [];
  };
  account.text = (cn, at, direction, { status = direction === 'incoming' ? 'received' : 'delivered', text } = {}) => {
    account.messages[cn].push({
      id: `AC-m-${cn}-${at}`, conversationId: cn, phoneNumberId: PHONE, direction, status,
      from: direction === 'incoming' ? account.conversations[cn].participants[0] : '+15125550100',
      to: [direction === 'incoming' ? '+15125550100' : account.conversations[cn].participants[0]],
      text: text ?? `${direction} at ${at}`, createdAt: iso(at), updatedAt: iso(at),
    });
    touch(cn, at, direction, 'message');
  };
  // Statuses are the ones the real API returns (round 14, measured on the live
  // line): 'no-answer' for a call nobody picked up, 'completed' otherwise —
  // including 3 of 72 incoming calls that were 'completed' with answeredAt null
  // and duration 0. answeredAt is what actually says a human answered.
  account.call = (cn, at, direction, { answeredAfter = null, status, voicemail = null } = {}) => {
    const id = `AC-c-${cn}-${at}`;
    account.calls[cn].push({
      id, phoneNumberId: PHONE, direction, participants: account.conversations[cn].participants,
      status: status ?? (answeredAfter === null ? 'no-answer' : 'completed'),
      createdAt: iso(at), answeredAt: answeredAfter === null ? null : iso(at + answeredAfter),
      completedAt: iso(at + (answeredAfter ?? 0) + 60), duration: answeredAfter === null ? 0 : 60,
      answeredBy: null, initiatedBy: null, callRoute: 'phone-number', forwardedFrom: null, forwardedTo: null,
      aiHandled: null, userId: 'US1', updatedAt: iso(at + 60),
    });
    // GET /v1/call-voicemails/{callId}: {duration, id, transcript, recordingUrl, status}.
    if (voicemail) account.voicemails[id] = { duration: 14, id: `VM-${id}`, recordingUrl: 'https://example.invalid/vm.mp3', status: 'completed', ...voicemail };
    touch(cn, at, direction, 'call');
    return id;
  };
  return account;
}

const after = (items, createdAfter) =>
  createdAfter ? items.filter((x) => Date.parse(x.createdAt) > Date.parse(createdAfter)) : items;

/** One page of `items`: honours maxResults (capped by opts.pageSize) and an offset pageToken. */
function paged(items, q, pageSize) {
  const size = Math.min(pageSize, Number(q.get('maxResults')));
  const start = Number(q.get('pageToken') ?? 0);
  const next = start + size < items.length ? String(start + size) : null;
  return { data: items.slice(start, start + size), nextPageToken: next };
}

/**
 * Run fn with fetch answering from `account`.
 * opts.pageSize caps every page (real Quo pages are up to 100), so paging is exercised.
 * account.failListingPageToken makes a conversations request that carries a pageToken fail.
 */
export async function withQuo(account, fn, { pageSize = 100 } = {}) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    account.requests.push(url);
    const ok = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    const q = url.searchParams;

    const byActivity = Object.values(account.conversations)
      .sort((a, b) => Date.parse(b.lastActivityAt ?? b.createdAt) - Date.parse(a.lastActivityAt ?? a.createdAt));

    if (url.origin !== 'https://api.quo.com') {
      account.requests.pop();
      if (realFetch !== NATIVE_FETCH) return realFetch(input, init); // e.g. a fake Gmail around this one
      throw new Error('unexpected fetch in test: ' + url.href);
    }

    // v1, per the docs.
    if (url.pathname === '/v1/phone-numbers') {
      return ok({ data: [{ id: PHONE, number: '+15125550100', formattedNumber: '(512) 555-0100', name: 'InHouse Support' }] });
    }
    if (url.pathname === '/v1/conversations') {
      if (!q.get('maxResults')) return new Response('maxResults required', { status: 400 });
      if (account.failListingPageToken && q.get('pageToken')) return new Response('page token expired', { status: 400 });
      return ok(paged(byActivity, q, pageSize));
    }
    if (url.pathname === '/v1/messages' || url.pathname === '/v1/calls') {
      const participants = q.getAll('participants');
      if (!q.get('phoneNumberId') || !participants.length || !q.get('maxResults')) {
        return new Response('phoneNumberId, participants and maxResults are required', { status: 400 });
      }
      const cn = Object.keys(account.conversations).find((id) =>
        account.conversations[id].participants.join() === participants.join());
      if (account.fail.has(cn)) return new Response('boom', { status: 500 });
      const store = url.pathname === '/v1/messages' ? account.messages : account.calls;
      return ok(paged(after(store[cn] ?? [], q.get('createdAfter')), q, pageSize));
    }

    // GET /v1/call-voicemails/{callId}. 404 is the normal answer for a call
    // that rang out, and the docs give no plan restriction (unlike transcripts).
    if (url.pathname.startsWith('/v1/call-voicemails/')) {
      const callId = url.pathname.slice('/v1/call-voicemails/'.length);
      if (account.failVoicemail) return new Response('boom', { status: 500 });
      const vm = account.voicemails[callId];
      if (!vm) return new Response(JSON.stringify({ message: 'Call voicemail not found' }), { status: 404 });
      return ok({ data: vm });
    }

    // What the pre-round-3 ingest called (not a documented v1 path).
    if (url.pathname === '/conversations') return ok({ data: byActivity });

    throw new Error('unexpected fetch in test: ' + url.href);
  };
  try { return await fn(); } finally { globalThis.fetch = realFetch; }
}
