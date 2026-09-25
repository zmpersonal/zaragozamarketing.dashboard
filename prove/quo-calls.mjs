#!/usr/bin/env node
/**
 * PROVE THE SOURCE — what Quo actually returns for a CALL (round 14).
 *
 * Read-only. The phone queue is full of threads titled "Call" that are all in
 * Needs reply, so before changing any mapping we look at the real shapes:
 * which fields a call carries, whether a voicemail is exposed, whether a
 * transcript can be fetched, and what our own ingest makes of each one.
 *
 *   node prove/quo-calls.mjs [PN123abc] [--days 14] [--preview]
 *
 * Needs QUO_API_KEY (shell or .dev.vars). GETs only, no writes anywhere.
 * Prints field names, counts and codes. Customer numbers are masked to the
 * last 4 digits and message/transcript text is never printed unless you pass
 * --preview, which prints at most 60 characters.
 */
import { existsSync } from 'node:fs';
import { listPhoneNumbers, activeConversations, readConversation } from '../src/ingest/quo.ts';
import { resolveState } from '../src/lib/thread-state.ts';

const fail = (msg) => { console.error('\n  FAILED: ' + msg + '\n'); process.exit(1); };

if (process.env.QUO_API_KEY === undefined && existsSync('.dev.vars')) process.loadEnvFile('.dev.vars');
const QUO_API_KEY = process.env.QUO_API_KEY;
if (!QUO_API_KEY) fail('Missing QUO_API_KEY.');
const env = { QUO_API_KEY };

const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const DAYS = Number(flag('--days', 14));
const PREVIEW = args.includes('--preview');
const chosen = args.find((a, i) => a.startsWith('PN') && args[i - 1] !== '--days');

const mask = (s) => (typeof s === 'string' && s.length > 4 ? '…' + s.slice(-4) : String(s));
const snip = (s) => (!s ? '' : PREVIEW ? JSON.stringify(String(s).replace(/\s+/g, ' ').slice(0, 60)) : `<${String(s).length} chars>`);

const numbers = await listPhoneNumbers(env).catch((e) => fail(e.message));
console.log('\n  Quo numbers on this account:');
for (const n of numbers) console.log(`    ${n.id}  ${mask(n.number)}  ${n.name ?? ''}`);

const phone = chosen ? numbers.find((n) => n.id === chosen) : numbers[0];
if (!phone) fail(`${chosen} is not a number on this account.`);

const now = Math.floor(Date.now() / 1000);
const since = now - DAYS * 86400;
const conversations = await activeConversations(env, phone.id, since).catch((e) => fail(e.message));
console.log(`\n  ${phone.id} (${mask(phone.number)}): ${conversations.length} conversations with activity in the last ${DAYS} days\n`);

const callKeys = new Map();   // key -> count
const callValues = new Map(); // key -> Set of small-cardinality values
const messageKeys = new Map();
const counts = {
  conversations: 0, callOnly: 0, textOnly: 0, both: 0,
  callsTotal: 0, inboundAnswered: 0, inboundMissed: 0, outboundAnswered: 0, outboundUnanswered: 0,
  withVoicemailField: 0, withVoicemail: 0, textsIn: 0, textsOut: 0,
  ingestWaiting: 0, ingestAnswered: 0, ingestNoTimeline: 0,
};
const note = (map, obj) => { for (const [k, v] of Object.entries(obj)) {
  map.set(k, (map.get(k) ?? 0) + 1);
  if (v === null || typeof v !== 'object') {
    const seen = callValues.get(k) ?? new Set();
    if (seen.size < 8) seen.add(v === null ? 'null' : typeof v === 'string' && v.length > 24 ? `<${typeof v}>` : v);
    callValues.set(k, seen);
  }
} };

const callSamples = [];
const crossTab = new Map(); // direction/status/answered/duration -> count
const allCalls = [];
for (const c of conversations) {
  const { messages, calls, timeline } = await readConversation(env, c, since).catch((e) => fail(`${c.id}: ${e.message}`));
  counts.conversations++;
  if (calls.length && messages.length) counts.both++;
  else if (calls.length) counts.callOnly++;
  else if (messages.length) counts.textOnly++;

  for (const m of messages) {
    note(messageKeys, m);
    if (m.direction === 'incoming') counts.textsIn++; else counts.textsOut++;
  }
  for (const call of calls) {
    note(callKeys, call);
    counts.callsTotal++;
    const answered = call.answeredAt != null;
    if (call.direction === 'incoming') answered ? counts.inboundAnswered++ : counts.inboundMissed++;
    else answered ? counts.outboundAnswered++ : counts.outboundUnanswered++;
    if ('voicemail' in call) counts.withVoicemailField++;
    if (call.voicemail) counts.withVoicemail++;
    if (callSamples.length < 3) callSamples.push(call);
    allCalls.push(call);
    const bucket = call.duration === 0 ? 'duration=0' : call.duration < 30 ? 'duration<30s' : 'duration>=30s';
    const k = `${call.direction.padEnd(8)} status=${String(call.status).padEnd(12)} answeredAt=${call.answeredAt ? 'set ' : 'null'} ${bucket}`;
    crossTab.set(k, (crossTab.get(k) ?? 0) + 1);
  }

  const state = resolveState(null, timeline);
  if (!timeline.length) counts.ingestNoTimeline++;
  else if (state.status === 'waiting') counts.ingestWaiting++;
  else counts.ingestAnswered++;
}

console.log('  CALL OBJECT — every field seen, how often, and the values:');
for (const [k, n] of [...callKeys].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${k.padEnd(18)} ${String(n).padStart(4)}/${counts.callsTotal}   ${[...(callValues.get(k) ?? [])].slice(0, 8).join(' | ')}`);
}
console.log('\n  MESSAGE OBJECT — every field seen:');
for (const [k, n] of [...messageKeys].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(18)} ${String(n).padStart(4)}`);

console.log('\n  ONE RAW CALL (values masked):');
for (const s of callSamples.slice(0, 1)) {
  for (const [k, v] of Object.entries(s)) {
    const shown = v === null ? 'null'
      : Array.isArray(v) ? `[${v.map((x) => (typeof x === 'string' ? mask(x) : typeof x)).join(', ')}]`
      : typeof v === 'object' ? JSON.stringify(Object.fromEntries(Object.entries(v).map(([k2, v2]) => [k2, typeof v2 === 'string' && v2.length > 20 ? `<${typeof v2}>` : v2])))
      : typeof v === 'string' && /^\+?\d{7,}$/.test(v) ? mask(v) : JSON.stringify(v);
    console.log(`    ${k.padEnd(18)} ${shown}`);
  }
}

console.log('\n  CROSS-TAB — direction x status x answeredAt x duration:');
for (const [k, n] of [...crossTab].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)}  ${k}`);

console.log('\n  BREAKDOWN of the last ' + DAYS + ' days:');
for (const [k, v] of Object.entries(counts)) console.log(`    ${k.padEnd(20)} ${v}`);

// --- transcripts and voicemail: documented endpoints, probed by status code ---
const probe = async (path) => {
  const res = await fetch('https://api.quo.com/v1/' + path, { headers: { Authorization: QUO_API_KEY } });
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body };
};
// Probe the calls most likely to have audio: the longest ones, plus a duration-0 one.
const byDuration = [...allCalls].sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0));
const probes = [...byDuration.slice(0, 3), ...byDuration.filter((c) => c.duration === 0).slice(0, 1)];
for (const someCall of probes) {
  console.log(`\n  TRANSCRIPT / RECORDING probe — ${someCall.direction} ${someCall.status} duration=${someCall.duration}s answeredAt=${someCall.answeredAt ? 'set' : 'null'}:`);
  for (const path of [`call-transcripts/${someCall.id}`, `call-recordings/${someCall.id}`, `call-summaries/${someCall.id}`]) {
    const { status, body } = await probe(path);
    const data = body?.data;
    const keys = Array.isArray(data) ? `array[${data.length}]${data[0] ? ' of {' + Object.keys(data[0]).join(', ') + '}' : ''}`
      : data && typeof data === 'object' ? Object.keys(data).join(', ') : '';
    const message = body?.message ?? body?.error ?? '';
    console.log(`    GET /v1/${path.split('/')[0]}/<id>  ->  ${status}  ${keys ? `keys: ${keys}` : ''} ${message ? `(${message})` : ''}`);
    if (data?.dialogue?.length) console.log(`      dialogue: ${data.dialogue.length} segments, [0].content: ${snip(data.dialogue[0].content)}`);
    if (data?.status) console.log(`      status: ${data.status}`);
    if (data?.summary) console.log(`      summary: ${snip(Array.isArray(data.summary) ? data.summary.join(' ') : data.summary)}`);
    if (Array.isArray(data) && data[0]?.url) console.log(`      recording[0]: duration=${data[0].duration} type=${data[0].type} status=${data[0].status}`);
  }
}
// Voicemail: documented as GET /v1/call-voicemails/{callId}, with a transcript
// field, and (unlike call-transcripts) no plan note in the docs.
const unanswered = allCalls.filter((c) => c.direction === 'incoming' && c.answeredAt == null);
console.log(`\n  VOICEMAIL probe on ${Math.min(unanswered.length, 30)} of ${unanswered.length} unanswered incoming calls:`);
const vmStats = { 200: 0, other: 0, withTranscript: 0, transcriptChars: [], statuses: new Map() };
for (const call of unanswered.slice(0, 30)) {
  const { status, body } = await probe(`call-voicemails/${call.id}`);
  const d = body?.data;
  if (status === 200) vmStats[200]++; else vmStats.other++;
  const key = `${status} ${d ? `status=${d.status} transcript=${d.transcript ? 'yes' : d.transcript === null ? 'null' : 'absent'} recording=${d.recordingUrl ? 'yes' : 'no'} duration=${d.duration}` : (body?.message ?? '')}`;
  vmStats.statuses.set(key, (vmStats.statuses.get(key) ?? 0) + 1);
  if (d?.transcript) { vmStats.withTranscript++; vmStats.transcriptChars.push(String(d.transcript).length); }
}
for (const [k, n] of [...vmStats.statuses].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(3)}  ${k}`);
console.log(`    voicemails with a transcript: ${vmStats.withTranscript}; transcript lengths: ${vmStats.transcriptChars.join(', ') || '-'}`);
// Do the phrases Julian named actually appear? Counts only: the transcripts
// themselves are customer (and robocaller) content and stay on this machine.
const PHRASES = ['google listing', 'google verification', 'google business', 'google', 'verification code',
  'listing', 'appointment', 'order', 'refund', 'press 1', 'chiller', 'warranty',
  'business listing', 'google maps', 'google search', 'my business', 'business profile', 'seo', 'website'];
/** Rules to size before writing them: name -> test(lowercased transcript). */
const RULES = {
  'google + listing anywhere': (t) => t.includes('google') && t.includes('listing'),
  'google + (listing|maps|business|profile)': (t) => t.includes('google') && /listing|maps|business|profile/.test(t),
  'google, any context': (t) => t.includes('google'),
  'PROPOSED google_listing (same sentence, <=30 chars apart)': (t) =>
    /\bgoogle\b[^.?!]{0,30}\blisting/.test(t) || /\blisting\b[^.?!]{0,30}\bgoogle\b/.test(t),
  'PROPOSED google_verification (same sentence, <=30 chars apart)': (t) =>
    /\bgoogle\b[^.?!]{0,30}\bverif/.test(t) || /\bverif\w*\b[^.?!]{0,30}\bgoogle\b/.test(t),
  'PROPOSED both rules together (what would leave Needs reply)': (t) =>
    /\bgoogle\b[^.?!]{0,30}\blisting/.test(t) || /\blisting\b[^.?!]{0,30}\bgoogle\b/.test(t) ||
    /\bgoogle\b[^.?!]{0,30}\bverif/.test(t) || /\bverif\w*\b[^.?!]{0,30}\bgoogle\b/.test(t),
  'TIGHTER verification: google <-> "verificat*" only': (t) =>
    /\bgoogle\b[^.?!]{0,30}\bverificat/.test(t) || /\bverificat\w*\b[^.?!]{0,30}\bgoogle\b/.test(t),
  'TIGHTER: google (business)? (listing|verification), adjacent': (t) =>
    /\bgoogle('?s)?\s+(business\s+|my\s+business\s+)?(listing|verification)/.test(t),
  'neither google nor listing': (t) => !t.includes('google') && !t.includes('listing'),
};
const ruleHits = new Map(Object.keys(RULES).map((r) => [r, 0]));
const hits = new Map(PHRASES.map((p) => [p, 0]));
const callers = new Map();
let read = 0;
for (const call of unanswered) {
  const { body } = await probe(`call-voicemails/${call.id}`);
  const t = body?.data?.transcript;
  if (!t) continue;
  read++;
  const lower = String(t).toLowerCase();
  for (const phrase of PHRASES) if (lower.includes(phrase)) hits.set(phrase, hits.get(phrase) + 1);
  for (const [name, test] of Object.entries(RULES)) if (test(lower)) ruleHits.set(name, ruleHits.get(name) + 1);
  const who = call.participants?.[0] ?? 'unknown';
  callers.set(who, (callers.get(who) ?? 0) + 1);
  if (PREVIEW) console.log(`    transcript: ${snip(t)}`);
}
console.log(`\n  PHRASE COUNTS over all ${read} voicemail transcripts (counts only, never the text):`);
for (const [phrase, n] of [...hits].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(3)}/${read}  "${phrase}"`);
console.log(`\n  CANDIDATE RULES, matches over the same ${read} transcripts:`);
for (const [name, n] of ruleHits) console.log(`    ${String(n).padStart(3)}/${read}  ${name}`);
console.log(`\n  Distinct callers leaving voicemail: ${callers.size}; top: ${[...callers].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${mask(k)} x${n}`).join(', ')}`);

console.log('\n  Read-only: no writes were made.\n');
