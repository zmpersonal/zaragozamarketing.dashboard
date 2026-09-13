#!/usr/bin/env node
/**
 * PROVE LIVE INGEST
 *
 * Runs the real Gmail ingest (src/ingest/gmail.ts) against a mailbox into a
 * local database file, until the 30-day backfill has caught up, and prints
 * counts. Run it again later and the stored cursor makes it incremental: it
 * shows what the next cron run would fetch. Threads newly moved to Trash are
 * listed (date | tier | ingested? | subject) so the owner can confirm trashed
 * mail is still ingested.
 *
 * Run:  node prove/ingest-live.mjs support@inhousewellness.com \
 *         --state ~/Code/secrets/inhouse-ops-live.sqlite
 *
 * The state file holds customer mail metadata: owner-only (600), outside the
 * repo (refused otherwise). Delete it to start over.
 * Optional setup seeds, applied once when the state file is new:
 *   SENDER_RULES_FILE, KNOWN_SENDERS_FILE (paths to .sql files).
 * Auth: GOOGLE_SERVICE_ACCOUNT_FILE (never printed).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { liveIngest, formatReport } from './_ingest-live.mjs';

const args = process.argv.slice(2);
const MAILBOX = args[0]?.startsWith('--') ? undefined : args[0];
const i = args.indexOf('--state');
const STATE = i >= 0 ? args[i + 1] : undefined;

function fail(msg) {
  console.error('\n  FAILED: ' + msg + '\n');
  process.exit(1);
}
if (!MAILBOX) fail('Pass a mailbox: node prove/ingest-live.mjs support@inhousewellness.com --state <file outside the repo>');
if (!STATE) fail('Pass --state <file>: a path outside the repo.');
const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
if (!keyPath) fail('Set GOOGLE_SERVICE_ACCOUNT_FILE to the path of the service-account key file.');
let keyJson;
try { keyJson = readFileSync(keyPath, 'utf8'); } catch (err) { fail(`GOOGLE_SERVICE_ACCOUNT_FILE could not be read (${err.code ?? 'error'}): ${keyPath}`); }
const seedSql = [process.env.SENDER_RULES_FILE, process.env.KNOWN_SENDERS_FILE].filter(Boolean).map((p) => readFileSync(p, 'utf8'));

// Ingest's per-run log lines name only the mailbox; its per-thread error lines are counted, not shown.
const realError = console.error;
let errors = 0;
console.error = () => { errors++; };
let report;
try {
  report = await liveIngest({ mailbox: MAILBOX, keyJson, stateFile: resolve(STATE), seedSql });
} catch (err) {
  console.error = realError;
  fail(err.message);
}
console.error = realError;
console.log(formatReport(report));
console.log(`INGEST ERROR LINES: ${errors}`);
