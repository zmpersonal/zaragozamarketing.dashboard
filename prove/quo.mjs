#!/usr/bin/env node
/**
 * PROVE THE SOURCE — Quo (formerly OpenPhone)
 *
 * Lists your Quo numbers, then pulls recent conversations on the first one
 * and prints which are waiting on us. Proves the API key and the shape of
 * the data before the ingest worker gets written.
 *
 * Run:  node prove/quo.mjs
 * Needs: QUO_API_KEY  (Quo → Settings → API → Generate API key)
 *
 * Auth is the raw key in the Authorization header — no "Bearer " prefix.
 * The Quo-Api-Version header pins the response shape; leaving it off means
 * a Quo release can silently change your payload.
 */

const KEY = process.env.QUO_API_KEY;
const API_VERSION = '2026-03-30';

if (!KEY) fail('Missing QUO_API_KEY. Check for a truncated trailing "=".');

function fail(msg) {
  console.error('\n  FAILED: ' + msg + '\n');
  process.exit(1);
}

async function quo(path, params = {}) {
  const url = new URL('https://api.quo.com/' + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: KEY, 'Quo-Api-Version': API_VERSION },
  });
  if (!res.ok) fail('Quo ' + path + ' returned ' + res.status + ': ' + (await res.text()));
  return res.json();
}

const numbers = await quo('phone-numbers');
const list = numbers.data ?? [];
if (!list.length) fail('No phone numbers on this Quo account. Wrong key?');

console.log('\n  Quo numbers:');
for (const n of list) console.log('    ' + n.number + '  ' + (n.name ?? ''));

const first = list[0];
const convos = await quo('conversations', { phoneNumberId: first.id, limit: 10 });
const rows = convos.data ?? [];
if (!rows.length) fail('Zero conversations on ' + first.number + '. Not fatal, but nothing to prove.');

console.log('\n  ' + first.number + ' — newest ' + rows.length + ' conversations\n');

for (const c of rows) {
  const at = new Date(c.lastActivityAt ?? c.updatedAt);
  const hours = Math.round((Date.now() - at.getTime()) / 36e5);
  // Direction of the last activity tells us who owes a reply.
  const waiting = c.lastActivityDirection === 'incoming';
  console.log(
    '  ' + (waiting ? 'WAITING ' : 'answered') +
    '  ' + String(hours).padStart(4) + 'h  ' +
    String(c.name ?? c.participants?.[0] ?? 'unknown').padEnd(24) +
    String(c.lastActivityType ?? '').padEnd(10) +
    (c.previewText ?? '').slice(0, 40)
  );
}

console.log('\n  Source proved. Now wire the webhook so we stop polling.\n');
