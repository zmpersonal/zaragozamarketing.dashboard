#!/usr/bin/env node
/**
 * PROVE THE SOURCE — Quo (formerly OpenPhone)
 *
 * Lists your Quo numbers, then reads the last few days of conversations on
 * one of them the same way ingest does (src/ingest/quo.ts, Quo v1 API): every
 * message and call since a point in time, turned into a timeline, and judged
 * waiting or answered by the same rules (src/lib/thread-state.ts). Proves the
 * API key and the data shape before trusting the poller.
 *
 * Run:  node prove/quo.mjs                 # first number on the account, last 7 days
 *       node prove/quo.mjs PN123abc --days 14
 * Needs: QUO_API_KEY  (Quo → Settings → API → Generate API key), in the shell
 *        or .dev.vars. Auth is the raw key in Authorization — no "Bearer ".
 *
 * Uses the v1 API: the dated 2026-03-30 API does not list conversations or
 * messages yet, and v1 "remains fully supported".
 */
import { existsSync } from 'node:fs';
import { listPhoneNumbers, activeConversations, readConversation } from '../src/ingest/quo.ts';
import { resolveState } from '../src/lib/thread-state.ts';

function fail(msg) {
  console.error('\n  FAILED: ' + msg + '\n');
  process.exit(1);
}

if (process.env.QUO_API_KEY === undefined && existsSync('.dev.vars')) process.loadEnvFile('.dev.vars');
const QUO_API_KEY = process.env.QUO_API_KEY;
if (!QUO_API_KEY) fail('Missing QUO_API_KEY. Check for a truncated trailing "=".');
const env = { QUO_API_KEY };

const args = process.argv.slice(2);
const daysAt = args.indexOf('--days');
const DAYS = daysAt >= 0 ? Number(args[daysAt + 1]) : 7;
const chosen = args.find((a, i) => a.startsWith('PN') && args[i - 1] !== '--days');
const SHOW = 10;

const numbers = await listPhoneNumbers(env).catch((err) => fail(err.message));
if (!numbers.length) fail('No phone numbers on this Quo account. Wrong key?');

console.log('\n  Quo numbers:');
for (const n of numbers) console.log('    ' + n.id + '  ' + n.number + '  ' + (n.name ?? ''));

const phone = chosen ? numbers.find((n) => n.id === chosen) : numbers[0];
if (!phone) fail(`${chosen} is not a number on this account.`);

const now = Math.floor(Date.now() / 1000);
const since = now - DAYS * 86400;
const conversations = (await activeConversations(env, phone.id, since).catch((err) => fail(err.message))).slice(0, SHOW);
if (!conversations.length) fail(`No activity on ${phone.number} in the last ${DAYS} days. Not fatal, but nothing to prove.`);

console.log(`\n  ${phone.number} — ${conversations.length} most recent conversations, last ${DAYS} days\n`);

const hours = (t) => String(Math.round((now - t) / 3600)).padStart(4) + 'h';
for (const c of conversations) {
  const { messages, calls, timeline } = await readConversation(env, c, since).catch((err) => fail(`${c.id}: ${err.message}`));
  const state = resolveState(null, timeline);
  const age = state.awaiting_since !== null ? hours(state.awaiting_since) : timeline.length ? hours(timeline.at(-1).at) : '    -';
  const last = [...messages].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  console.log(
    '  ' + (state.status === 'waiting' ? 'WAITING ' : 'answered') + '  ' + age + '  ' +
    String(c.name ?? c.participants[0] ?? 'unknown').padEnd(24) +
    `${messages.length} texts, ${calls.length} calls`.padEnd(20) +
    (last?.text ?? '').replace(/\s+/g, ' ').slice(0, 40)
  );
}

console.log('\n  Source proved: v1 messages and calls read, waiting/answered by the ingest rules.\n');
