#!/usr/bin/env node
/**
 * PROVE THE SOURCE — what a List-Unsubscribe header actually offers (round 15).
 *
 * Read-only. Before building an unsubscribe action we need to know what the
 * real mail carries: a mailto, an https URL, both, and whether RFC 8058
 * one-click (List-Unsubscribe-Post) is offered. The answer decides whether an
 * agent can be given a button or only a link.
 *
 *   GOOGLE_SERVICE_ACCOUNT_FILE=~/Code/secrets/<key>.json node prove/unsubscribe.mjs [--days 30]
 *
 * Prints counts and header *shapes* only: never a customer address, never a
 * full unsubscribe URL (they identify the recipient).
 */
import { gmailAccessToken } from './_google.mjs';

const fail = (m) => { console.error('\n  FAILED: ' + m + '\n'); process.exit(1); };
const args = process.argv.slice(2);
const DAYS = Number(args[args.indexOf('--days') + 1]) || 30;
const MAILBOX = 'support@inhousewellness.com';

const token = await gmailAccessToken(MAILBOX, fail);
const auth = { Authorization: `Bearer ${token}` };
const api = 'https://gmail.googleapis.com/gmail/v1/users/me/';
const get = async (path) => {
  const res = await fetch(api + path, { headers: auth });
  if (!res.ok) fail(`Gmail ${path.split('?')[0]} -> ${res.status}`);
  return res.json();
};

// The same population ingest reads (CLAUDE.md invariant 5).
const q = encodeURIComponent(`in:anywhere newer_than:${DAYS}d -in:sent -in:drafts -in:chats`);
let pageToken = null, threads = [];
do {
  const page = await get(`threads?q=${q}&includeSpamTrash=true&maxResults=100${pageToken ? `&pageToken=${pageToken}` : ''}`);
  threads.push(...(page.threads ?? []));
  pageToken = page.nextPageToken;
} while (pageToken && threads.length < 500);

console.log(`\n  ${threads.length} threads in the last ${DAYS} days on ${MAILBOX}\n`);

const counts = { threads: 0, withHeader: 0, mailtoOnly: 0, httpsOnly: 0, both: 0, oneClick: 0, neither: 0 };
const hosts = new Map();
for (const { id } of threads) {
  const t = await get(`threads/${id}?format=metadata`);
  const first = (t.messages ?? []).find((m) => !(m.labelIds ?? []).includes('SENT'));
  if (!first) continue;
  counts.threads++;
  const h = {};
  for (const x of first.payload.headers ?? []) h[x.name.toLowerCase()] = x.value;
  const lu = h['list-unsubscribe'];
  if (!lu) { counts.neither++; continue; }
  counts.withHeader++;
  const links = [...lu.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
  const mailto = links.filter((l) => l.toLowerCase().startsWith('mailto:'));
  const https = links.filter((l) => /^https?:/i.test(l));
  if (mailto.length && https.length) counts.both++;
  else if (mailto.length) counts.mailtoOnly++;
  else if (https.length) counts.httpsOnly++;
  const post = h['list-unsubscribe-post'];
  if (post && /one-click/i.test(post)) counts.oneClick++;
  for (const u of https) { const host = new URL(u).host.split('.').slice(-2).join('.'); hosts.set(host, (hosts.get(host) ?? 0) + 1); }
}

console.log('  LIST-UNSUBSCRIBE:');
for (const [k, v] of Object.entries(counts)) console.log(`    ${k.padEnd(12)} ${v}`);
console.log('\n  https hosts (registrable domain only, no paths — a path identifies the recipient):');
for (const [h, n] of [...hosts].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`    ${String(n).padStart(3)}  ${h}`);
console.log('\n  Read-only: nothing was sent, nothing was written.\n');
