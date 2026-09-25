// Phone threads must say what they are (round 14).
//
// Measured on the live line with prove/quo-calls.mjs, 14 days, 72 calls:
//   61 incoming 'no-answer', answeredAt null, duration 0
//    3 incoming 'completed',  answeredAt null, duration 0
//    2 incoming answered, 6 outgoing answered
//   50 of the 64 unanswered incoming calls had a voicemail, every one with a
//   transcript; the other 14 returned 404 "Call voicemail not found".
// So answeredAt is what says a human answered, and the voicemail (with its
// transcript) is a second request per unanswered incoming call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestQuo, phoneSummary } from '../src/ingest/quo.ts';
import { makeQuoAccount, makeQuoEnv, withQuo, PHONE, SOURCE_ID, CUSTOMER } from './helpers/quo.mjs';

const HOUR = 3600;
const now = () => Math.floor(Date.now() / 1000);
const threadOf = (env, cn = 'CN1') => env.DB.raw.prepare('SELECT * FROM thread WHERE id = ?').get(`quo:${cn}`);

async function run(build) {
  const env = makeQuoEnv();
  const account = makeQuoAccount();
  build(account);
  await withQuo(account, () => ingestQuo(env));
  return { env, account };
}
const conversation = (account, cn = 'CN1', at = now() - 6 * HOUR) => account.conversation(cn, { createdAt: at });

// --- what is waiting on us, and what is not ---------------------------------

test('an answered inbound call is not waiting on us: answered, with the call as last_outbound_at', async () => {
  const at = now() - 3 * HOUR;
  const { env } = await run((a) => { conversation(a); a.call('CN1', at, 'incoming', { answeredAfter: 20 }); });
  const t = threadOf(env);
  assert.equal(t.status, 'answered');
  assert.equal(t.awaiting_since, null, 'nothing is waiting');
  assert.equal(t.last_outbound_at, at + 20, 'answering the call is the outbound');
  assert.equal(t.subject, 'Call');
});

test('a missed inbound call with no voicemail is waiting, and says missed call', async () => {
  const at = now() - 2 * HOUR;
  const { env, account } = await run((a) => { conversation(a); a.call('CN1', at, 'incoming'); });
  const t = threadOf(env);
  assert.equal(t.status, 'waiting');
  assert.equal(t.awaiting_since, at);
  assert.equal(t.subject, 'Missed call');
  assert.equal(t.preview, null);
  assert.ok(account.requests.some((u) => u.pathname.startsWith('/v1/call-voicemails/')), 'it did look for a voicemail');
});

test('a voicemail says voicemail and carries the transcript as the preview', async () => {
  const at = now() - 2 * HOUR;
  const { env } = await run((a) => {
    conversation(a);
    a.call('CN1', at, 'incoming', { voicemail: { transcript: 'Hi, this is Rosa, my pump is leaking. Please call me back.' } });
  });
  const t = threadOf(env);
  assert.equal(t.status, 'waiting');
  assert.equal(t.subject, 'Voicemail');
  assert.match(t.preview, /pump is leaking/);
});

test('a missed call we called back and they answered is answered', async () => {
  const at = now() - 5 * HOUR;
  const { env } = await run((a) => {
    conversation(a);
    a.call('CN1', at, 'incoming', { voicemail: { transcript: 'Please call me back about the chiller.' } });
    a.call('CN1', at + HOUR, 'outgoing', { answeredAfter: 12 });
  });
  const t = threadOf(env);
  assert.equal(t.status, 'answered');
  assert.equal(t.awaiting_since, null);
  assert.equal(t.last_outbound_at, at + HOUR + 12);
  assert.equal(t.subject, 'Call', 'the newest activity is the call we made');
});

test('an inbound text with no reply is waiting, and says text', async () => {
  const at = now() - HOUR;
  const { env } = await run((a) => { conversation(a); a.text('CN1', at, 'incoming'); });
  const t = threadOf(env);
  assert.equal(t.status, 'waiting');
  assert.equal(t.subject, 'Text');
  assert.match(t.preview, /incoming at/);
});

test('an unanswered outgoing call is not contact: it reached nobody', async () => {
  const at = now() - 4 * HOUR;
  const { env } = await run((a) => {
    conversation(a);
    a.call('CN1', at, 'incoming');
    a.call('CN1', at + 600, 'outgoing');
  });
  const t = threadOf(env);
  assert.equal(t.status, 'waiting', 'trying to call back is not reaching them');
  assert.equal(t.awaiting_since, at);
  assert.equal(t.last_outbound_at, null);
  assert.equal(t.subject, 'Outgoing call');
});

test('"completed" does not mean answered: 3 of 72 real calls were completed, unanswered and 0 seconds', async () => {
  const at = now() - 2 * HOUR;
  const { env } = await run((a) => {
    conversation(a);
    a.call('CN1', at, 'incoming', { status: 'completed' }); // answeredAfter null: nobody picked up
  });
  const t = threadOf(env);
  assert.equal(t.status, 'waiting', 'answeredAt is what says a human answered, not status');
  assert.equal(t.last_outbound_at, null);
  assert.equal(t.subject, 'Missed call');
});

// --- triage on what was said ------------------------------------------------

test('a voicemail about a Google listing lands in the spam tier with its reason', async () => {
  const { env } = await run((a) => {
    conversation(a);
    a.call('CN1', now() - HOUR, 'incoming', { voicemail: { transcript: 'Calling about your Google listing. Press 1 to speak with a specialist.' } });
  });
  const t = threadOf(env);
  assert.equal(t.triage, 'spam');
  assert.match(t.triage_signals, /google_listing/);
  assert.equal(t.status, 'waiting', 'still a real thread, still visible: triage never hides anything');
});

test('a real voicemail stays in Needs reply', async () => {
  const { env } = await run((a) => {
    conversation(a);
    a.call('CN1', now() - HOUR, 'incoming', { voicemail: { transcript: 'I found you on Google, my chiller is leaking, can you call me?' } });
  });
  assert.equal(threadOf(env).triage, 'customer');
});

test('a spam text is judged the same way as a spam voicemail', async () => {
  const { env } = await run((a) => {
    conversation(a);
    a.text('CN1', now() - HOUR, 'incoming', { text: 'Your Google listing is unverified. Reply YES.' });
  });
  assert.equal(threadOf(env).triage, 'spam');
});

test('a later text with no keywords does not quietly promote a spam thread', async () => {
  const env = makeQuoEnv();
  const account = makeQuoAccount();
  conversation(account);
  account.call('CN1', now() - 3 * HOUR, 'incoming', { voicemail: { transcript: 'About your Google listing, press 1.' } });
  await withQuo(account, () => ingestQuo(env));
  assert.equal(threadOf(env).triage, 'spam');

  // Newer than the cursor the first run stored, so the second run really re-reads
  // the conversation — and sees only the text, not the voicemail behind it.
  account.text('CN1', now(), 'incoming', { text: 'Hello?' });
  await withQuo(account, () => ingestQuo(env));
  assert.match(threadOf(env).preview, /Hello\?/, 'the second run did re-read this conversation');
  assert.equal(threadOf(env).triage, 'spam', 'only a human takes a thread out of spam (rescue)');
});

test('an agent verdict is never overwritten by the content rules', async () => {
  const env = makeQuoEnv();
  const account = makeQuoAccount();
  conversation(account);
  account.call('CN1', now() - HOUR, 'incoming', { voicemail: { transcript: 'About your Google listing, press 1.' } });
  await withQuo(account, () => ingestQuo(env));
  env.DB.raw.exec(`UPDATE thread SET triage = 'customer', triage_by = 'marianne@example.com' WHERE id = 'quo:CN1'`);
  env.DB.raw.exec(`UPDATE source SET sync_cursor = NULL WHERE id = '${SOURCE_ID}'`);
  await withQuo(account, () => ingestQuo(env));
  assert.equal(threadOf(env).triage, 'customer', 'the rescue stands');
});

// --- the enrichment must never break ingest ---------------------------------

test('a 404 from the voicemail endpoint is the normal "it rang out": no failure, and no log noise', async () => {
  // 14 of 64 unanswered calls on the live line answer 404. If that warned, every
  // run would carry a dozen warnings and a real problem would be lost in them.
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  let env;
  try {
    ({ env } = await run((a) => { conversation(a); a.call('CN1', now() - HOUR, 'incoming'); }));
  } finally { console.warn = realWarn; }
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM ingest_failure').get().n, 0);
  assert.equal(threadOf(env).subject, 'Missed call');
  assert.deepEqual(warnings.filter((w) => /voicemail/i.test(w)), [], 'a 404 is an answer, not a problem');
});

test('a voicemail lookup that errors does not fail the conversation', async () => {
  const env = makeQuoEnv();
  const account = makeQuoAccount();
  conversation(account);
  account.call('CN1', now() - HOUR, 'incoming');
  account.failVoicemail = true;
  await withQuo(account, () => ingestQuo(env));
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM ingest_failure').get().n, 0, 'enrichment, not core');
  assert.equal(threadOf(env).status, 'waiting');
  assert.equal(threadOf(env).subject, 'Missed call');
});

test('voicemails are only looked up for unanswered incoming calls', async () => {
  const { account } = await run((a) => {
    conversation(a);
    a.call('CN1', now() - 3 * HOUR, 'incoming', { answeredAfter: 5 });
    a.call('CN1', now() - 2 * HOUR, 'outgoing', { answeredAfter: 5 });
    a.text('CN1', now() - HOUR, 'incoming');
  });
  assert.equal(account.requests.filter((u) => u.pathname.startsWith('/v1/call-voicemails/')).length, 0);
});

// --- the queue full of "Call" can be corrected in place ---------------------

test('re-scanning an existing thread fixes its title without moving the clock', async () => {
  const at = now() - 30 * HOUR;
  const env = makeQuoEnv();
  const account = makeQuoAccount();
  conversation(account, 'CN1', at);
  const callId = account.call('CN1', at, 'incoming');
  await withQuo(account, () => ingestQuo(env));
  // The old rows: everything was called "Call" and nothing was classified.
  env.DB.raw.exec(`UPDATE thread SET subject = 'Call', preview = NULL WHERE id = 'quo:CN1'`);
  const before = threadOf(env);

  // The voicemail finished processing, and the cursor is reset for one re-scan.
  account.voicemails[callId] = { transcript: 'About your Google listing. Press 1.', duration: 14, status: 'completed' };
  env.DB.raw.exec(`UPDATE source SET sync_cursor = NULL WHERE id = '${SOURCE_ID}'`);
  await withQuo(account, () => ingestQuo(env));

  const t = threadOf(env);
  assert.equal(t.subject, 'Voicemail');
  assert.equal(t.triage, 'spam');
  assert.equal(t.conversation_started_at, before.conversation_started_at, 'never moves');
  assert.equal(t.awaiting_since, before.awaiting_since, 'the customer waited from when they called');
  assert.equal(t.status, 'waiting');
});

// --- the pure part ----------------------------------------------------------

test('phoneSummary titles a thread from its newest activity', () => {
  const call = (at, direction, over = {}) => ({ direction, createdAt: new Date(at * 1000).toISOString(), answeredAt: null, ...over });
  const text = (at, direction, body) => ({ direction, createdAt: new Date(at * 1000).toISOString(), text: body });
  const answered = (at) => new Date((at + 10) * 1000).toISOString();

  assert.equal(phoneSummary([], [call(100, 'incoming')]).subject, 'Missed call');
  assert.equal(phoneSummary([], [call(100, 'incoming', { voicemail: { transcript: 'hi' } })]).subject, 'Voicemail');
  assert.equal(phoneSummary([], [call(100, 'incoming', { answeredAt: answered(100) })]).subject, 'Call');
  assert.equal(phoneSummary([], [call(100, 'outgoing')]).subject, 'Outgoing call');
  assert.equal(phoneSummary([text(100, 'incoming', 'hello')], []).subject, 'Text');
  // Newest wins, whichever kind it is.
  assert.equal(phoneSummary([text(100, 'incoming', 'hello')], [call(200, 'incoming')]).subject, 'Missed call');
  assert.equal(phoneSummary([text(300, 'incoming', 'hello')], [call(200, 'incoming')]).subject, 'Text');
  // The transcript is the preview, and the text ingest sees for triage is the customer's words only.
  const vm = phoneSummary([text(100, 'outgoing', 'ours')], [call(200, 'incoming', { voicemail: { transcript: 'theirs' } })]);
  assert.equal(vm.preview, 'theirs');
  assert.equal(vm.contentForTriage.includes('ours'), false);
  assert.equal(vm.contentForTriage.includes('theirs'), true);
});
