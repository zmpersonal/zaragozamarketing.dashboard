#!/usr/bin/env node
/**
 * SETUP: known_sender rows from the sent-mail backfill, own domain removed.
 *
 * Reads the file written by prove/backfill-known-senders.mjs and writes the
 * SQL that is actually applied. Addresses at our own domain (any subdomain,
 * any case) are dropped: a colleague copied on a thread says nothing about
 * whether a sender is a customer. The output also deletes own-domain rows an
 * earlier unfiltered apply left behind.
 *
 * Repeatable: the same input gives byte-identical output. Idempotent: applying
 * it any number of times leaves the same rows, keeping each sender's earliest reply.
 *
 *   node prove/apply-known-senders.mjs \
 *     --in  ~/Code/secrets/inhouse-ops-known-senders.sql \
 *     --out ~/Code/secrets/inhouse-ops-known-senders.filtered.sql \
 *     [--exclude-domain inhousewellness.com ...] [--sqlite <local database file>]
 *
 * Production (a human, at deploy):
 *   wrangler d1 execute inhouse-ops --remote --file=<out>
 *
 * Input and output are customer contact data: --out must be outside the repo,
 * it is written mode 600, and only counts are printed.
 */
import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isOutsideRepo } from './_outside-repo.mjs';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const flags = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));

function fail(msg) {
  console.error('\n  FAILED: ' + msg + '\n');
  process.exit(1);
}

const IN = flag('--in');
const OUT = flag('--out');
const SQLITE = flag('--sqlite');
const DOMAINS = (flags('--exclude-domain').length ? flags('--exclude-domain') : ['inhousewellness.com']).map((d) => String(d).toLowerCase());

if (!IN || !OUT) fail('Pass --in <backfill .sql> and --out <filtered .sql>, both outside the repo.');
for (const d of DOMAINS) if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) fail(`--exclude-domain is not a domain name: ${d}`);
const outPath = resolve(OUT);
if (!isOutsideRepo(outPath)) fail('--out must be outside the repo; customer addresses never go in it.');
if (!existsSync(IN)) fail(`--in not found: ${IN}`);

// Load the backfill into the real schema, so the input is read exactly as a database would read it.
const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const scratch = new DatabaseSync(':memory:');
scratch.exec(schema);
try {
  scratch.exec(readFileSync(IN, 'utf8'));
} catch (err) {
  fail(`--in did not apply to schema.sql: ${err.message}`);
}
const input = scratch.prepare('SELECT address, first_seen_at, replied_at FROM known_sender ORDER BY address').all();

const ownDomain = (address) => {
  const domain = address.toLowerCase().split('@').pop();
  return DOMAINS.some((d) => domain === d || domain.endsWith('.' + d));
};
const kept = input.filter((r) => !ownDomain(r.address));
const filtered = input.length - kept.length;

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const num = (n) => (n === null ? 'NULL' : String(Number(n)));
const ownPredicate = DOMAINS.map((d) => `lower(address) LIKE '%@${d}' OR lower(address) LIKE '%@%.${d}'`).join(' OR ');
const statements = [`DELETE FROM known_sender WHERE ${ownPredicate};`];
for (let i = 0; i < kept.length; i += 200) {
  const values = kept.slice(i, i + 200).map((r) => `(${q(r.address)}, ${num(r.first_seen_at)}, ${num(r.replied_at)})`).join(',\n  ');
  statements.push(
    `INSERT INTO known_sender (address, first_seen_at, replied_at) VALUES\n  ${values}\n` +
    `ON CONFLICT (address) DO UPDATE SET replied_at = MIN(COALESCE(known_sender.replied_at, excluded.replied_at), COALESCE(excluded.replied_at, known_sender.replied_at));`,
  );
}
const sql = `-- known_sender setup rows: sent-mail backfill minus own domain (${DOMAINS.join(', ')}).\n` +
  `-- Customer contact data: keep outside the repo. ${kept.length} rows.\n` + statements.join('\n') + '\n';
writeFileSync(outPath, sql, { mode: 0o600 });
chmodSync(outPath, 0o600);

console.log(`INPUT ROWS: ${input.length}`);
console.log(`FILTERED (own domain ${DOMAINS.join(', ')}): ${filtered}`);
console.log(`TO APPLY: ${kept.length}`);
console.log(`WROTE: ${outPath} (mode 600)`);

if (SQLITE) {
  if (!existsSync(SQLITE)) fail(`--sqlite not found: ${SQLITE}`);
  const db = new DatabaseSync(SQLITE);
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM known_sender').get().n;
  const own = () => db.prepare(`SELECT COUNT(*) AS n FROM known_sender WHERE ${ownPredicate}`).get().n;
  const before = [count(), own()];
  db.exec('BEGIN');
  try { db.exec(sql); db.exec('COMMIT'); } catch (err) { db.exec('ROLLBACK'); fail(`--sqlite apply failed: ${err.message}`); }
  console.log(`SQLITE ${resolve(SQLITE)}: known_sender before ${before[0]} (${before[1]} own domain), after ${count()} (${own()} own domain)`);
}
console.log(`Production, by a human at deploy: wrangler d1 execute inhouse-ops --remote --file=<the WROTE file>`);
