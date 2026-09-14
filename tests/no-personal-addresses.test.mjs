// No address at a consumer mail domain may appear in code, tests, UI or
// prove scripts. A private repo is not a safe place for a customer's (or
// anyone's) personal address: it leaks through clones, forks and later read
// access. Verified customers and reply history live in the database, seeded
// from files kept outside the repo. Tests use fabricated example.com addresses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SCANNED = ['src', 'tests', 'public', 'prove', 'scripts', '.github'];

// Built from parts so this file never contains an address itself.
const CONSUMER = ['icloud', 'me', 'mac', 'gmail', 'googlemail', 'yahoo', 'ymail', 'outlook', 'hotmail', 'live', 'msn', 'aol'];
const PERSONAL_ADDRESS = new RegExp(`[A-Za-z0-9._%+-]+@(?:${CONSUMER.join('|')})\\.[A-Za-z]{2,}(?:\\.[A-Za-z]{2,})?\\b`, 'i');

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const p = join(dir, name);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

test('the detector recognises consumer-domain addresses and ignores example ones', () => {
  const at = (local, domain) => `${local}${String.fromCharCode(64)}${domain}`;
  for (const d of ['gmail.com', 'iCloud.com', 'yahoo.co.uk', 'outlook.com', 'hotmail.com', 'msn.com', 'aol.com'])
    assert.match(`From: A Person <${at('first.last', d)}>`, PERSONAL_ADDRESS, d);
  for (const d of ['example.com', 'inhousewellness.com', 'mail.me.example', 'livestream.example'])
    assert.doesNotMatch(at('first.last', d), PERSONAL_ADDRESS, d);
});

test('no consumer-domain address anywhere under src/, tests/, public/ or prove/', () => {
  const offenders = SCANNED.flatMap((dir) => walk(join(ROOT, dir)))
    .filter((p) => PERSONAL_ADDRESS.test(readFileSync(p, 'utf8')))
    .map((p) => relative(ROOT, p));
  assert.deepEqual(offenders, [], 'replace with a fabricated address at example.com');
});
