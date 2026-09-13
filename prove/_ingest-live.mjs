/**
 * Live ingest check: the real src/ingest/gmail.ts against a real mailbox,
 * writing to a local SQLite file (the production schema, via the D1 shim)
 * that persists between runs. Runs ingest repeatedly until the backfill has
 * caught up, then reports counts. On later runs the stored cursor makes it
 * incremental, so it shows exactly what one cron run would pick up.
 *
 * Trash: lists the threads in Trash within the ingest window, checks each is
 * ingested, and names the ones that were not in Trash last time (date, tier,
 * subject; never a sender address).
 */
import { chmodSync } from 'node:fs';
import { makeD1 } from '../tests/helpers/d1.mjs';
import { ingestGmail, RECEIVED_QUERY } from '../src/ingest/gmail.ts';
import { GMAIL_READONLY, parseServiceAccount, serviceAccountToken } from '../src/lib/google-auth.ts';
import { isOutsideRepo } from './_outside-repo.mjs';

const MAX_RUNS = 500;
const TRASH_QUERY = RECEIVED_QUERY.replace('in:anywhere', 'in:trash');

export async function liveIngest({ mailbox, keyJson, stateFile, repoRoot, seedSql = [] }) {
  if (!isOutsideRepo(stateFile, repoRoot)) throw new Error('the state file must be outside the repo: it holds customer mail metadata');
  const DB = makeD1(stateFile);
  chmodSync(stateFile, 0o600);
  const db = DB.raw;
  const sourceId = `gmail:${mailbox}`;
  const fresh = !db.prepare('SELECT 1 FROM source WHERE id = ?').get(sourceId);
  if (fresh) {
    db.prepare(`INSERT INTO source (id, brand_id, channel, provider, address) VALUES (?, 'inhouse', 'email', 'gmail', ?)`).run(sourceId, mailbox);
    for (const sql of seedSql) db.exec(sql);
  }
  db.exec('CREATE TABLE IF NOT EXISTS _prove_trash (thread_id TEXT PRIMARY KEY)');

  const env = { DB, GOOGLE_SERVICE_ACCOUNT_JSON: keyJson };
  const modes = [];
  const refetched = new Set();
  const maxRun = { fetch: 0, d1: 0 };
  let runs = 0;

  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const realWarn = console.warn;
  const note = (line) => {
    const mode = line.match(/mode=(\w+)/)?.[1];
    if (mode && line.includes(`gmail ingest ${mailbox}:`) && !line.includes('re-seeding')) modes.push(mode);
    const sub = line.match(/subrequests fetch=(\d+) d1=(\d+)/);
    if (sub) { maxRun.fetch = Math.max(maxRun.fetch, Number(sub[1])); maxRun.d1 = Math.max(maxRun.d1, Number(sub[2])); }
  };
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    const m = url.pathname.match(/\/gmail\/v1\/users\/me\/threads\/([^/]+)$/);
    if (m) refetched.add(m[1]);
    return realFetch(input, init);
  };
  console.log = (...a) => { note(a.map(String).join(' ')); realLog(...a); };
  console.warn = (...a) => realWarn(...a);
  try {
    do {
      await ingestGmail(env);
      runs++;
      const c = JSON.parse(db.prepare('SELECT sync_cursor FROM source WHERE id = ?').get(sourceId).sync_cursor ?? 'null');
      if (!c || (!c.pending?.length && !c.backfillPageToken)) break;
    } while (runs < MAX_RUNS);

    // Trash in the window, listed straight from Gmail.
    const token = await serviceAccountToken(parseServiceAccount(keyJson), mailbox, GMAIL_READONLY);
    const trashIds = new Set();
    let pageToken;
    do {
      const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
      url.searchParams.set('q', TRASH_QUERY);
      url.searchParams.set('includeSpamTrash', 'true');
      url.searchParams.set('maxResults', '500');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const res = await realFetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Gmail messages.list (trash) -> ${res.status}`);
      const body = await res.json();
      for (const msg of body.messages ?? []) trashIds.add(msg.threadId);
      pageToken = body.nextPageToken;
    } while (pageToken);

    const before = new Set(db.prepare('SELECT thread_id FROM _prove_trash').all().map((r) => r.thread_id));
    const threadRow = db.prepare('SELECT subject, triage, last_inbound_at FROM thread WHERE id = ?');
    const newly = fresh ? [] : [...trashIds].filter((id) => !before.has(id)).sort().map((id) => {
      const t = threadRow.get(`gmail:${id}`);
      return { id, ingested: !!t, tier: t?.triage ?? null, subject: t?.subject ?? null, at: t?.last_inbound_at ?? null };
    });
    const ingestedTrash = [...trashIds].filter((id) => threadRow.get(`gmail:${id}`)).length;
    db.exec('DELETE FROM _prove_trash');
    const ins = db.prepare('INSERT INTO _prove_trash (thread_id) VALUES (?)');
    for (const id of trashIds) ins.run(id);

    const tiers = { customer: 0, bulk: 0, spam: 0 };
    for (const r of db.prepare(`SELECT triage, COUNT(*) AS n FROM thread WHERE source_id = ? GROUP BY triage`).all(sourceId)) tiers[r.triage] = r.n;
    return {
      runs, modes: [...new Set(modes)], refetched: [...refetched].sort(),
      threads: db.prepare('SELECT COUNT(*) AS n FROM thread WHERE source_id = ?').get(sourceId).n,
      failures: db.prepare('SELECT COUNT(*) AS n FROM ingest_failure WHERE source_id = ?').get(sourceId).n,
      tiers, maxRun,
      trash: { inWindow: trashIds.size, ingested: ingestedTrash, newly },
    };
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
    console.warn = realWarn;
  }
}

const ADDRESS = /[^\s<>"',;()]+@[^\s<>"',;()]+/g;
const day = (s) => (s ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(s * 1000)) : '----------');
const clip = (s) => [...(s ?? '(not ingested)').replace(ADDRESS, '[address]')].slice(0, 50).join('');

export function formatReport(r) {
  return [
    `RUNS: ${r.runs}`,
    `MODES: ${r.modes.join(', ')}`,
    `THREADS INGESTED: ${r.threads} (customer ${r.tiers.customer}, bulk ${r.tiers.bulk}, spam ${r.tiers.spam})`,
    `THREADS FETCHED THIS INVOCATION: ${r.refetched.length}`,
    `INGEST FAILURES RECORDED: ${r.failures}`,
    `MAX SUBREQUESTS IN ONE RUN: fetch ${r.maxRun.fetch}, d1 ${r.maxRun.d1}`,
    `TRASH IN WINDOW: ${r.trash.inWindow} threads, ${r.trash.ingested} ingested`,
    `NEWLY IN TRASH SINCE LAST RUN: ${r.trash.newly.length}`,
    ...r.trash.newly.map((t) => `  ${day(t.at)} | ${t.tier ?? '-'} | ${t.ingested ? 'ingested' : 'NOT INGESTED'} | ${clip(t.subject)}${r.refetched.includes(t.id) ? '' : ' | not re-fetched this run'}`),
  ].join('\n');
}
