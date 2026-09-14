// scripts/ingest.mjs is what GitHub Actions runs every hour: Gmail then Quo,
// each under its own deadline, writing to D1 over the REST API. It must fail
// loudly (non-zero exit, ::error:: annotation) when a source can't be read,
// warn on item failures, and never print a secret, including on failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runIngest, redactor, RUN_LIMITS } from '../scripts/_ingest-run.mjs';
import { makeD1Rest, ACCOUNT, DATABASE, TOKEN } from './helpers/d1-rest.mjs';
import { withGmail, inbound, SERVICE_ACCOUNT_JSON, MAILBOX, SOURCE_ID } from './helpers/gmail.mjs';
import { makeQuoAccount, withQuo, PHONE, SOURCE_ID as QUO_SOURCE } from './helpers/quo.mjs';

const QUO_KEY = 'quo-key-SECRET-9d2e';
const DAY = 86400_000;
const ago = (days) => new Date(Math.floor((Date.now() - days * DAY) / 1000) * 1000).toISOString();

function setup({ gmail = true, quo = true } = {}) {
  const api = makeD1Rest();
  if (gmail) api.db.raw.exec(`INSERT INTO source (id, brand_id, channel, provider, address) VALUES ('${SOURCE_ID}', 'inhouse', 'email', 'gmail', '${MAILBOX}')`);
  if (quo) api.db.raw.exec(`INSERT INTO source (id, brand_id, channel, provider, address) VALUES ('${QUO_SOURCE}', 'inhouse', 'phone', 'quo', '${PHONE}')`);
  const env = {
    CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_D1_DATABASE_ID: DATABASE,
    GOOGLE_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT_JSON, QUO_API_KEY: QUO_KEY,
  };
  const threads = { a: [inbound(ago(1), 'Dana <dana@example.com>')] };
  const account = makeQuoAccount();
  const T0 = Math.floor(Date.now() / 1000) - 600;
  account.conversation('CN1', { participants: ['+15125550101'], createdAt: T0 - 3600 });
  account.text('CN1', T0, 'incoming');
  return { api, env, threads, account };
}

async function run({ api, env, threads, account }, opts = {}) {
  const out = [];
  const code = await withQuo(account, () => withGmail(threads, () => runIngest(env, {
    d1Fetch: api.fetch, sleep: async () => {}, print: (line) => out.push(line), ...opts,
  })));
  return { code, out: out.join('\n') };
}

const SECRETS = [TOKEN, QUO_KEY, JSON.parse(SERVICE_ACCOUNT_JSON).private_key_id, JSON.parse(SERVICE_ACCOUNT_JSON).private_key.split('\n')[1]];
const noSecrets = (text) => { for (const s of SECRETS) assert.ok(!text.includes(s), `printed a secret: ${s.slice(0, 6)}…`); };

test('a normal run ingests Gmail and Quo over the REST API, prints a summary and exits 0', async () => {
  const s = setup();
  const r = await run(s);
  assert.equal(r.code, 0, r.out);
  const threads = s.api.db.raw.prepare('SELECT id FROM thread ORDER BY id').all().map((x) => x.id);
  assert.deepEqual(threads, ['gmail:a', 'quo:CN1']);
  assert.match(r.out, /^ingest gmail: processed 1, failed items 0, failed sources 0/m);
  assert.match(r.out, /^ingest quo: processed 1, failed items 0, failed sources 0/m);
  assert.doesNotMatch(r.out, /::error|::warning/);
  noSecrets(r.out);
});

test('missing configuration fails before touching anything, naming the variables and not their values', async () => {
  const s = setup();
  delete s.env.CLOUDFLARE_API_TOKEN;
  s.env.CLOUDFLARE_D1_DATABASE_ID = '';
  const r = await run(s);
  assert.equal(r.code, 1);
  assert.match(r.out, /::error title=ingest::Missing required environment: CLOUDFLARE_API_TOKEN, CLOUDFLARE_D1_DATABASE_ID/);
  assert.equal(s.api.requests.length, 0);
  noSecrets(r.out);
});

test('a source that cannot be read makes the run red (::error::, exit 1), and the other source still runs', async () => {
  const s = setup();
  s.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{"not":"a key"}';
  const r = await run(s);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /::error title=ingest gmail::/);
  assert.ok(s.api.db.raw.prepare("SELECT 1 FROM thread WHERE id = 'quo:CN1'").get(), 'Quo still ran');
  noSecrets(r.out);
});

test('item failures (recorded in ingest_failure) warn but do not fail the run', async () => {
  const s = setup();
  s.account.fail.add('CN1');
  const r = await run(s);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /::warning title=ingest quo::1 item/);
  assert.match(r.out, /quo ingest skipped conversation CN1/, "ingest's own console output goes through the runner's (redacting) printer");
});

test('a database error while Gmail runs is a red run with the reason, and Quo still runs', async () => {
  const s = setup();
  s.api.failures.push(null, { status: 400, message: 'D1_ERROR: database is locked' }); // self-check passes, Gmail's first query fails
  const r = await run(s);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /::error title=ingest gmail::could not read all: D1 API 400: .*database is locked/);
  assert.ok(s.api.db.raw.prepare("SELECT 1 FROM thread WHERE id = 'quo:CN1'").get(), 'Quo still ran');
});

test('the D1 API unreachable or refusing the token fails the run at the self-check, without the token', async () => {
  const s = setup();
  s.env.CLOUDFLARE_API_TOKEN = 'wrong-token-SECRET-1234';
  const r = await run(s);
  assert.equal(r.code, 1);
  assert.match(r.out, /::error title=ingest::.*401/);
  assert.ok(!r.out.includes('wrong-token-SECRET-1234'));
});

test('secrets are redacted from everything printed, even when an error message carries one', async () => {
  const s = setup();
  s.api.failures.push({ status: 400, message: `bad request for Bearer ${TOKEN} and key ${QUO_KEY}` });
  const r = await run(s);
  assert.equal(r.code, 1);
  assert.match(r.out, /\*\*\*/);
  noSecrets(r.out);

  const redact = redactor({ A: 'abcdefghijklmnop', B: SERVICE_ACCOUNT_JSON, SHORT: 'x' });
  const pem = JSON.parse(SERVICE_ACCOUNT_JSON).private_key;
  assert.equal(redact('token abcdefghijklmnop end'), 'token *** end');
  assert.ok(!redact(`key ${pem.split('\n')[2]}`).includes(pem.split('\n')[2]), 'each line of a multi-line secret');
  assert.equal(redact('x marks'), 'x marks', 'values too short to be secrets are left alone');
});

test('each source gets its own deadline, and the run finishes well inside a 2-minute job', async () => {
  assert.ok(RUN_LIMITS.gmailSeconds < RUN_LIMITS.quoSeconds, 'Gmail stops first, leaving Quo its share');
  assert.ok(RUN_LIMITS.quoSeconds <= 85, 'room for setup, the last item, and cursor writes');
  const s = setup();
  let clock = 0;
  const budgets = [];
  await run(s, { now: () => clock, onBudget: (name, b) => budgets.push([name, b.deadline]) });
  assert.deepEqual(budgets, [['gmail', RUN_LIMITS.gmailSeconds * 1000], ['quo', RUN_LIMITS.quoSeconds * 1000]]);
});
