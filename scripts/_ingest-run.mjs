/**
 * One ingest run, as GitHub Actions executes it (scripts/ingest.mjs).
 *
 *   1. Check configuration (names only are ever printed).
 *   2. D1 REST self-check: parameters must round-trip with their types.
 *   3. Gmail, then Quo. Each gets its own Budget (src/lib/budget.ts) with a
 *      wall-clock deadline measured from the start of the run, so the job ends
 *      inside its timeout and the Actions minutes math holds.
 *   4. Summary per source. A source that couldn't be read at all -> ::error::
 *      and exit 1 (red in the Actions tab). Items that failed are recorded in
 *      ingest_failure and on the board -> ::warning::, exit 0, so one poison
 *      record doesn't turn every hourly run red.
 *
 * Everything printed, including ingest's own console output and error stacks,
 * passes through a redactor holding every secret value. GitHub also masks
 * registered secrets; this covers values derived from them (lines of the key)
 * and errors that echo a credential back.
 */
import { format } from 'node:util';
import { D1HttpClient } from '../src/db/d1-http.ts';
import { Budget } from '../src/lib/budget.ts';
import { ingestGmail, GMAIL_LIMITS } from '../src/ingest/gmail.ts';
import { ingestQuo, QUO_LIMITS } from '../src/ingest/quo.ts';

/**
 * Seconds from the start of the run after which each source starts no new work.
 * The workflow's job timeout is 2 minutes; setup takes ~15 s, and the item in
 * flight plus cursor writes need a few more.
 */
export const RUN_LIMITS = { gmailSeconds: 45, quoSeconds: 80 };

const REQUIRED = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_D1_DATABASE_ID'];
const SECRET_NAMES = ['CLOUDFLARE_API_TOKEN', 'QUO_API_KEY', 'GOOGLE_SERVICE_ACCOUNT_JSON'];

/** Replaces every secret value (and each line of a multi-line one, and a JSON key's private fields) with ***. */
export function redactor(secrets) {
  const values = new Set();
  const add = (v) => { if (typeof v === 'string' && v.trim().length >= 8) values.add(v.trim()); };
  for (const v of Object.values(secrets)) {
    if (typeof v !== 'string') continue;
    add(v);
    for (const line of v.split(/\r?\n|\\n/)) add(line);
    try {
      const key = JSON.parse(v);
      for (const field of ['private_key', 'private_key_id']) {
        add(key[field]);
        for (const line of String(key[field] ?? '').split('\n')) if (!/^-----/.test(line)) add(line);
      }
    } catch { /* not JSON */ }
  }
  const sorted = [...values].sort((a, b) => b.length - a.length);
  return (text) => sorted.reduce((t, v) => t.split(v).join('***'), String(text));
}

const annotation = (text) => String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

export async function runIngest(env, opts = {}) {
  const redact = redactor(Object.fromEntries(SECRET_NAMES.map((n) => [n, env[n]])));
  const print = (line) => (opts.print ?? ((l) => process.stdout.write(l + '\n')))(redact(line));
  const now = opts.now ?? Date.now;

  const missing = REQUIRED.filter((n) => !env[n]);
  if (missing.length) {
    print(`::error title=ingest::Missing required environment: ${missing.join(', ')}`);
    return 1;
  }

  // Ingest's own logging goes through the redactor too.
  const real = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => print(format(...a));
  console.warn = (...a) => print(format(...a));
  console.error = (...a) => print(format(...a));
  const start = now();
  let exitCode = 0;
  try {
    const db = new D1HttpClient({
      accountId: env.CLOUDFLARE_ACCOUNT_ID, databaseId: env.CLOUDFLARE_D1_DATABASE_ID, token: env.CLOUDFLARE_API_TOKEN,
      fetch: opts.d1Fetch, sleep: opts.sleep,
    });
    try {
      await db.selfCheck();
    } catch (err) {
      print(`::error title=ingest::${annotation(redact(err.message))}`);
      return 1;
    }
    const ingestEnv = { DB: db, GOOGLE_SERVICE_ACCOUNT_JSON: env.GOOGLE_SERVICE_ACCOUNT_JSON, QUO_API_KEY: env.QUO_API_KEY,
      INGEST_MAX_SUBREQUESTS: env.INGEST_MAX_SUBREQUESTS, INGEST_MAX_D1_QUERIES: env.INGEST_MAX_D1_QUERIES };

    for (const [name, ingest, limits, seconds] of [
      ['gmail', ingestGmail, GMAIL_LIMITS, RUN_LIMITS.gmailSeconds],
      ['quo', ingestQuo, QUO_LIMITS, RUN_LIMITS.quoSeconds],
    ]) {
      const budget = Budget.from(ingestEnv, limits, { deadline: start + seconds * 1000, now });
      opts.onBudget?.(name, budget);
      const requestsBefore = db.requests;
      let summary;
      try {
        summary = await ingest(ingestEnv, budget);
      } catch (err) {
        summary = { processed: 0, failedItems: 0, failedSources: ['all'], error: err };
      }
      print(`ingest ${name}: processed ${summary.processed}, failed items ${summary.failedItems}, failed sources ${summary.failedSources.length}, d1 requests ${db.requests - requestsBefore}, elapsed ${((now() - start) / 1000).toFixed(1)}s${budget.pastDeadline ? ' (stopped at its deadline; the rest runs next hour)' : ''}`);
      if (summary.failedSources.length) {
        exitCode = 1;
        const why = summary.error ? `: ${summary.error.message}` : ' (see the log above)';
        print(`::error title=ingest ${name}::could not read ${summary.failedSources.join(', ')}${annotation(redact(why))}`);
      } else if (summary.failedItems) {
        print(`::warning title=ingest ${name}::${summary.failedItems} item(s) failed and were recorded in ingest_failure`);
      }
    }
  } finally {
    Object.assign(console, real);
  }
  return exitCode;
}
