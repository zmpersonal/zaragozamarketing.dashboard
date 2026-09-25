// The admin response-time view (round 15). The measurements have been recorded
// in `response` since round 4; this is the first thing that reads them.
//
// Median, not mean: at two real emails a day one 40-hour outlier makes a mean
// meaningless. Business minutes throughout (invariant 6). Bulk and spam are
// excluded everywhere — they are not customers waiting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { makeApiEnv, withAccess, mintToken, apiRequest, insertThread, OWNER } from './helpers/access.mjs';
import { businessTimeBefore, businessMinutes } from '../src/lib/clock.ts';

const AGENT = 'dana.agent@inhousewellness.com';
const nowSec = () => Math.floor(Date.now() / 1000);

async function get(env, query = '', email = OWNER) {
  const token = await mintToken({ email });
  const res = await withAccess(() => worker.fetch(apiRequest(`report${query}`, { token }), env));
  return { status: res.status, body: await res.json() };
}

/** A thread that was answered `mins` business minutes after the customer wrote, `daysAgo`. */
function answered(env, { id, channel = 'email', mins, daysAgo, actor = AGENT, via = 'replied', body = null, triage = undefined }) {
  const respondedAt = nowSec() - Math.round(daysAgo * 86400);
  const awaitingSince = businessTimeBefore(respondedAt, mins);
  insertThread(env, { id, channel, status: 'answered', awaiting_since: null, started: awaitingSince, triage });
  env.DB.raw.prepare('UPDATE thread SET last_inbound_at = ?, last_outbound_at = ? WHERE id = ?').run(awaitingSince, respondedAt, id);
  env.DB.raw.prepare(`INSERT INTO response (thread_id, awaiting_since, responded_at, business_minutes, via, actor, created_at)
                      VALUES (?,?,?,?,?,?,?)`).run(id, awaitingSince, respondedAt, businessMinutes(awaitingSince, respondedAt), via, actor, respondedAt);
  if (body !== null) {
    env.DB.raw.prepare(`INSERT INTO action (thread_id, actor, kind, body, created_at) VALUES (?,?,?,?,?)`)
      .run(id, actor, via, body, respondedAt);
  }
  return { respondedAt, awaitingSince };
}

/** A thread still waiting, `mins` business minutes in. */
function waiting(env, { id, channel = 'email', mins, triage = undefined, status = 'waiting' }) {
  const since = businessTimeBefore(nowSec(), mins);
  insertThread(env, { id, channel, status, awaiting_since: since, started: since, triage });
}

test('only owners see it', async () => {
  const env = makeApiEnv();
  assert.equal((await get(env, '', AGENT)).status, 403);
  assert.equal((await get(env)).status, 200);
});

test('the median is the median, per channel and overall', async () => {
  const env = makeApiEnv();
  // email: 10, 20, 300 -> median 20 (a mean would say 110)
  answered(env, { id: 'gmail:a', mins: 10, daysAgo: 1 });
  answered(env, { id: 'gmail:b', mins: 20, daysAgo: 2 });
  answered(env, { id: 'gmail:c', mins: 300, daysAgo: 3 });
  // phone: 4, 8 -> median 6 (even count: the two middle values)
  answered(env, { id: 'quo:a', channel: 'phone', mins: 4, daysAgo: 1 });
  answered(env, { id: 'quo:b', channel: 'phone', mins: 8, daysAgo: 2 });

  const { body } = await get(env);
  const by = Object.fromEntries(body.channels.map((c) => [c.channel, c]));
  assert.equal(by.email.median_business_minutes, 20);
  assert.equal(by.email.answered, 3);
  assert.equal(by.phone.median_business_minutes, 6);
  assert.equal(by.phone.answered, 2);
  assert.equal(by.all.median_business_minutes, 10, 'all five: 4, 8, 10, 20, 300');
  assert.equal(by.all.answered, 5);
});

test('bulk and spam are not customers waiting, and never count', async () => {
  const env = makeApiEnv();
  answered(env, { id: 'gmail:real', mins: 30, daysAgo: 1 });
  answered(env, { id: 'gmail:junk', mins: 600, daysAgo: 1, triage: 'bulk' });
  answered(env, { id: 'quo:robo', channel: 'phone', mins: 900, daysAgo: 1, triage: 'spam' });
  waiting(env, { id: 'gmail:junk2', mins: 5000, triage: 'spam' });

  const { body } = await get(env);
  const all = body.channels.find((c) => c.channel === 'all');
  assert.equal(all.answered, 1);
  assert.equal(all.median_business_minutes, 30);
  assert.equal(body.outstanding.all.total, 0);
});

test('only the period counts', async () => {
  const env = makeApiEnv();
  answered(env, { id: 'gmail:in', mins: 30, daysAgo: 10 });
  answered(env, { id: 'gmail:out', mins: 30, daysAgo: 40 });
  assert.equal((await get(env)).body.channels.find((c) => c.channel === 'all').answered, 1);
  assert.equal((await get(env, '?days=60')).body.channels.find((c) => c.channel === 'all').answered, 2);
});

test('outstanding is bucketed by business age, not one number', async () => {
  const env = makeApiEnv();
  waiting(env, { id: 'gmail:w1', mins: 30 });        // under 2h
  waiting(env, { id: 'gmail:w2', mins: 100 });       // under 2h
  waiting(env, { id: 'gmail:w3', mins: 300 });       // 2-8h
  waiting(env, { id: 'gmail:w4', mins: 900 });       // 8-24h
  waiting(env, { id: 'gmail:w5', mins: 3000 });      // over 24h
  waiting(env, { id: 'quo:w6', channel: 'phone', mins: 3000, status: 'blocked' });

  const { body } = await get(env);
  assert.deepEqual(body.outstanding.email, { under_2h: 2, h2_8: 1, h8_24: 1, over_24h: 1, total: 5 });
  assert.deepEqual(body.outstanding.phone, { under_2h: 0, h2_8: 0, h8_24: 0, over_24h: 1, total: 1 }, 'blocked is still waiting on us');
  assert.equal(body.outstanding.all.over_24h, 2);
  assert.deepEqual(body.bucket_minutes, [120, 480, 1440]);
});

test('the last 7 days list says who answered, how, and links into the real thread', async () => {
  const env = makeApiEnv();
  answered(env, { id: 'gmail:18f2c1a9b', mins: 45, daysAgo: 2, body: 'Sent the replacement gasket, tracking follows.' });
  answered(env, { id: 'quo:CN9', channel: 'phone', mins: 12, daysAgo: 3, via: 'called', body: 'Called back, walked her through the reset.' });
  answered(env, { id: 'gmail:old', mins: 45, daysAgo: 12, body: 'Too long ago for this list.' });

  const { body } = await get(env);
  assert.equal(body.recent.length, 2);
  const [first, second] = body.recent;
  assert.equal(first.thread_id, 'gmail:18f2c1a9b');
  assert.equal(first.business_minutes, 45);
  assert.equal(first.actor, AGENT);
  assert.equal(first.action_kind, 'replied');
  assert.match(first.action_body, /replacement gasket/);
  assert.equal(first.link, 'https://mail.google.com/mail/u/support@inhousewellness.com/#all/18f2c1a9b');
  assert.equal(second.link, 'https://my.quo.com/inbox/PN1/c/CN9');
  assert.equal(second.action_kind, 'called');
});

test('a reply ingest found, with no logged action, is still in the list and says so', async () => {
  const env = makeApiEnv();
  answered(env, { id: 'gmail:x', mins: 60, daysAgo: 1, actor: 'system', via: 'message', body: null });
  const [row] = (await get(env)).body.recent;
  assert.equal(row.via, 'message');
  assert.equal(row.actor, 'system');
  assert.equal(row.action_kind, null, 'nobody logged it; the mail itself is the evidence');
  assert.ok(row.link);
});

test('days is validated, and the window is reported back', async () => {
  const env = makeApiEnv();
  for (const q of ['?days=0', '?days=366', '?days=x', '?days=-5']) {
    assert.equal((await get(env, q)).status, 400, q);
  }
  const { body } = await get(env, '?days=14');
  assert.equal(body.days, 14);
  assert.equal(body.recent_days, 7);
  assert.ok(body.since < body.now);
});

test('an empty period is empty, not zero', async () => {
  const env = makeApiEnv();
  const { body } = await get(env);
  assert.deepEqual(body.channels.find((c) => c.channel === 'all'), { channel: 'all', median_business_minutes: null, answered: 0 });
  assert.deepEqual(body.recent, []);
  assert.equal(body.outstanding.all.total, 0);
});
