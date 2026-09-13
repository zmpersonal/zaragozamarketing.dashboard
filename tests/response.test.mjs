// Response time: every time a wait on us ends, record business minutes from
// awaiting_since to that moment. Every measurement is kept (a reopened
// thread produces a second one) in the append-only response table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { ingestGmail } from '../src/ingest/gmail.ts';
import { ingestQuo } from '../src/ingest/quo.ts';
import { businessMinutes } from '../src/lib/clock.ts';
import { responseInsert } from '../src/db/threads.ts';
import { insertThread } from './helpers/access.mjs';
import { withGmail, inbound, outbound, MAILBOX, at } from './helpers/gmail.mjs';
import { makeApiEnv, withAccess, mintToken, apiRequest } from './helpers/access.mjs';
import { makeQuoEnv, makeQuoAccount, withQuo } from './helpers/quo.mjs';

const DANA = 'Dana Reyes <dana@example.com>';
const TUE_0900 = '2026-09-15T09:00:00-05:00';
const TUE_1130 = '2026-09-15T11:30:00-05:00';
const WED_1000 = '2026-09-16T10:00:00-05:00';
const THU_1400 = '2026-09-17T14:00:00-05:00';
const THU_1500 = '2026-09-17T15:00:00-05:00';
const FRI_1650 = '2026-09-11T16:50:00-05:00';
const MON_0810 = '2026-09-14T08:10:00-05:00';

function env() {
  const e = makeApiEnv();
  e.GOOGLE_CLIENT_ID = 'x.apps.googleusercontent.com';
  e.GOOGLE_CLIENT_SECRET = 's';
  e.GOOGLE_REFRESH_TOKENS = JSON.stringify({ [MAILBOX]: 'r' });
  return e;
}
const responses = async (e, id = 'gmail:t1') => (await e.DB.prepare(
  'SELECT awaiting_since, responded_at, business_minutes, via, actor FROM response WHERE thread_id = ?1 ORDER BY awaiting_since'
).bind(id).all()).results;
const act = async (e, body) => {
  const res = await withAccess(async () => worker.fetch(apiRequest('actions', { method: 'POST', body, token: await mintToken() }), e));
  assert.equal(res.status, 200, await res.clone().text());
};
const sync = (e, mailbox) => withGmail(mailbox, () => ingestGmail(e));

test('a reply seen by ingest records business minutes from awaiting_since to the reply', async () => {
  const e = env();
  const mailbox = { t1: [inbound(TUE_0900, DANA)] };
  await sync(e, mailbox);
  assert.deepEqual(await responses(e), [], 'nothing until the wait ends');

  mailbox.t1.push(outbound(TUE_1130));
  await sync(e, mailbox);
  assert.deepEqual(await responses(e), [
    { awaiting_since: at(TUE_0900), responded_at: at(TUE_1130), business_minutes: 150, via: 'message', actor: 'system' },
  ]);
});

test('business minutes, not wall clock: Fri 16:50 -> Mon 08:10 is 20', async () => {
  const e = env();
  const mailbox = { t1: [inbound(FRI_1650, DANA)] };
  await sync(e, mailbox);
  mailbox.t1.push(outbound(MON_0810));
  await sync(e, mailbox);
  assert.equal((await responses(e))[0].business_minutes, 20);
});

test('a reopened thread produces a second measurement; the first is kept', async () => {
  const e = env();
  const mailbox = { t1: [inbound(TUE_0900, DANA)] };
  await sync(e, mailbox);
  mailbox.t1.push(outbound(TUE_1130));
  await sync(e, mailbox);
  await act(e, { thread_id: 'gmail:t1', kind: 'note', status: 'closed' });

  mailbox.t1.push(inbound(THU_1400, DANA));
  await sync(e, mailbox);
  mailbox.t1.push(outbound(THU_1500));
  await sync(e, mailbox);

  const rows = await responses(e);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.awaiting_since, r.business_minutes]), [
    [at(TUE_0900), 150],
    [at(THU_1400), 60],
  ]);
});

test('re-syncing the same mailbox does not duplicate measurements', async () => {
  const e = env();
  const mailbox = { t1: [inbound(TUE_0900, DANA), outbound(TUE_1130)] };
  await sync(e, mailbox);
  await sync(e, mailbox);
  await sync(e, mailbox);
  assert.equal((await responses(e)).length, 1);
});

test("a call marked 'answered' records a measurement by the agent; the next sync adds no duplicate", async () => {
  const e = env();
  const arrived = Math.floor(Date.now() / 1000) - 3 * 3600;
  const mailbox = { t1: [inbound(new Date(arrived * 1000).toISOString(), DANA)] };
  await sync(e, mailbox);

  const before = Math.floor(Date.now() / 1000);
  await act(e, { thread_id: 'gmail:t1', kind: 'called', status: 'answered' });
  await sync(e, mailbox);

  const rows = await responses(e);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].via, 'called');
  assert.equal(rows[0].actor, 'dana.agent@inhousewellness.com');
  assert.equal(rows[0].awaiting_since, arrived);
  assert.ok(rows[0].responded_at >= before);
  assert.equal(rows[0].business_minutes, businessMinutes(arrived, rows[0].responded_at));
});

test('a voicemail (still needs a reply) records nothing; the later answer does', async () => {
  const e = env();
  const mailbox = { t1: [inbound(new Date((Math.floor(Date.now() / 1000) - 3600) * 1000).toISOString(), DANA)] };
  await sync(e, mailbox);
  await act(e, { thread_id: 'gmail:t1', kind: 'called', status: 'waiting' });
  await sync(e, mailbox);
  assert.deepEqual(await responses(e), []);

  await act(e, { thread_id: 'gmail:t1', kind: 'replied', status: 'answered' });
  assert.equal((await responses(e)).length, 1);
});

test("a note marked 'answered' is not a response and records nothing", async () => {
  const e = env();
  const mailbox = { t1: [inbound(TUE_0900, DANA)] };
  await sync(e, mailbox);
  await act(e, { thread_id: 'gmail:t1', kind: 'note', status: 'answered' });
  assert.deepEqual(await responses(e), []);
});

test("closing an unanswered thread records the wait with via 'closed', so the report can tell it apart", async () => {
  const e = env();
  const mailbox = { t1: [inbound(TUE_0900, DANA)] };
  await sync(e, mailbox);
  await act(e, { thread_id: 'gmail:t1', kind: 'note', status: 'closed' });
  const rows = await responses(e);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].via, 'closed');
});

test('first sync of a thread that was already answered records that historical response', async () => {
  const e = env();
  await sync(e, { t1: [inbound(TUE_0900, DANA), outbound(TUE_1130), inbound(WED_1000, DANA)] });
  assert.deepEqual((await responses(e)).map((r) => [r.awaiting_since, r.responded_at]), [[at(TUE_0900), at(TUE_1130)]]);
});

test('Quo: an inbound answered between two polls is still measured', async () => {
  const e = makeQuoEnv();
  const account = makeQuoAccount();
  const T0 = at(TUE_0900);
  account.conversation('CN1', { createdAt: T0 - 3600 });
  account.text('CN1', T0, 'incoming');
  account.text('CN1', T0 + 600, 'outgoing');
  const poll = async (nowSec) => {
    const real = Date.now; Date.now = () => nowSec * 1000;
    try { await withQuo(account, () => ingestQuo(e)); } finally { Date.now = real; }
  };
  await poll(T0 + 900);

  account.text('CN1', T0 + 1800, 'incoming');   // 09:30
  account.text('CN1', T0 + 2100, 'outgoing');   // 09:35, before the next poll
  await poll(T0 + 2400);

  const rows = await responses(e, 'quo:CN1');
  assert.deepEqual(rows.map((r) => [r.awaiting_since, r.business_minutes]), [[T0, 10], [T0 + 1800, 5]]);
});

test('closed unanswered, then reopened and answered: the second wait starts at the new message, not before the close', async () => {
  const e = env();
  const mailbox = { t1: [inbound(TUE_0900, DANA)] };
  await sync(e, mailbox);
  await act(e, { thread_id: 'gmail:t1', kind: 'note', status: 'closed' });

  mailbox.t1.push(inbound(THU_1400, DANA), outbound(THU_1500));
  await sync(e, mailbox);

  const rows = await responses(e);
  assert.deepEqual(rows.map((r) => [r.awaiting_since, r.via]), [[at(TUE_0900), 'closed'], [at(THU_1400), 'message']]);
  assert.equal(rows[1].business_minutes, 60);
});

test('safety net: the same wait written twice (e.g. by an agent and by ingest) is stored once', async () => {
  const e = env();
  insertThread(e, { id: 'gmail:t1', awaiting_since: at(TUE_0900) });
  await responseInsert(e.DB, 'gmail:t1', at(TUE_0900), at(TUE_1130), 'called', 'dana.agent@inhousewellness.com', at(TUE_1130)).run();
  await responseInsert(e.DB, 'gmail:t1', at(TUE_0900), at(WED_1000), 'message', 'system', at(WED_1000)).run();
  const rows = await responses(e);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].via, 'called', 'the first measurement wins');
});
