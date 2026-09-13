// An action that contacts the customer ('replied' or 'called') counts as a
// reply: it sets last_outbound_at and clears awaiting_since, and ingest must
// never resurrect 'waiting' while last_outbound_at is newer than the newest
// inbound message. Full round trip through the real route and a real sync.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { ingestGmail } from '../src/ingest/gmail.ts';
import { withGmail, inbound, MAILBOX, row } from './helpers/gmail.mjs';
import { makeApiEnv, withAccess, mintToken, apiRequest } from './helpers/access.mjs';

const DANA = 'Dana Reyes <dana@example.com>';
const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();

function env() {
  const e = makeApiEnv();
  e.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
  e.GOOGLE_CLIENT_SECRET = 'test-secret';
  e.GOOGLE_REFRESH_TOKENS = JSON.stringify({ [MAILBOX]: 'test-refresh' });
  return e;
}

const logAction = async (e, body) => {
  const res = await withAccess(async () =>
    worker.fetch(apiRequest('actions', { method: 'POST', token: await mintToken(), body }), e));
  assert.equal(res.status, 200, await res.clone().text());
};

for (const kind of ['called', 'replied']) {
  test(`round trip: inbound arrives, agent logs '${kind}', sync runs, thread stays answered`, async () => {
    const e = env();
    const mailbox = { t1: [inbound(hoursAgo(2), DANA)] };

    await withGmail(mailbox, () => ingestGmail(e));
    let t = await row(e, 't1');
    assert.equal(t.status, 'waiting');
    assert.notEqual(t.awaiting_since, null);

    const before = Math.floor(Date.now() / 1000);
    await logAction(e, { thread_id: 'gmail:t1', kind, body: 'Walked her through the breaker reset.', status: 'answered' });
    t = await row(e, 't1');
    assert.equal(t.status, 'answered');
    assert.equal(t.awaiting_since, null);
    assert.ok(t.last_outbound_at >= before, 'last_outbound_at set to the contact time');

    // Gmail still shows Dana's message as the last word. The sync must not flip it back.
    await withGmail(mailbox, () => ingestGmail(e));
    t = await row(e, 't1');
    assert.equal(t.status, 'answered');
    assert.equal(t.awaiting_since, null);
  });
}

test("a contact action with no status chosen records the contact but leaves the clock running", async () => {
  const e = env();
  const mailbox = { t1: [inbound(hoursAgo(2), DANA)] };
  await withGmail(mailbox, () => ingestGmail(e));
  const { awaiting_since } = await row(e, 't1');

  await logAction(e, { thread_id: 'gmail:t1', kind: 'called' });
  let t = await row(e, 't1');
  assert.notEqual(t.last_outbound_at, null, 'contact recorded');
  assert.equal(t.status, 'waiting');
  assert.equal(t.awaiting_since, awaiting_since);

  await withGmail(mailbox, () => ingestGmail(e));
  t = await row(e, 't1');
  assert.equal(t.status, 'waiting');
  assert.equal(t.awaiting_since, awaiting_since);
});

test('customer writes again after the call: sync reopens the clock from that message', async () => {
  const e = env();
  const mailbox = { t1: [inbound(hoursAgo(3), DANA)] };
  await withGmail(mailbox, () => ingestGmail(e));
  await logAction(e, { thread_id: 'gmail:t1', kind: 'called', status: 'answered' });

  // Dana emails again after the call. Her message is dated 1 minute in the future
  // so it is unambiguously newer than the call's now().
  const later = new Date(Math.floor(Date.now() / 1000) * 1000 + 60_000).toISOString(); // whole seconds, like Gmail
  mailbox.t1.push(inbound(later, DANA));
  await withGmail(mailbox, () => ingestGmail(e));

  const t = await row(e, 't1');
  assert.equal(t.status, 'waiting');
  assert.equal(t.awaiting_since, Date.parse(later) / 1000);
});

test("a note is not contact: it sets no last_outbound_at, and the sync keeps the thread waiting", async () => {
  const e = env();
  const mailbox = { t1: [inbound(hoursAgo(2), DANA)] };
  await withGmail(mailbox, () => ingestGmail(e));

  await logAction(e, { thread_id: 'gmail:t1', kind: 'note', body: 'Asked the supplier.', status: 'answered' });
  let t = await row(e, 't1');
  assert.equal(t.last_outbound_at, null);

  await withGmail(mailbox, () => ingestGmail(e));
  t = await row(e, 't1');
  assert.equal(t.status, 'waiting');
  assert.notEqual(t.awaiting_since, null);
});

test("calling and marking blocked records the contact, keeps it blocked, and does not stop the clock", async () => {
  const e = env();
  const mailbox = { t1: [inbound(hoursAgo(2), DANA)] };
  await withGmail(mailbox, () => ingestGmail(e));
  const { awaiting_since } = await row(e, 't1');

  await logAction(e, { thread_id: 'gmail:t1', kind: 'called', status: 'blocked', blocked_on: 'supplier' });
  await withGmail(mailbox, () => ingestGmail(e));

  const t = await row(e, 't1');
  assert.equal(t.status, 'blocked');
  assert.equal(t.awaiting_since, awaiting_since, "only 'answered' or 'closed' clears the clock");
  assert.notEqual(t.last_outbound_at, null);
});

test("voicemail: 'called' + 'still needs a reply' records contact, keeps the clock running, and the sync agrees", async () => {
  const e = env();
  const mailbox = { t1: [inbound(hoursAgo(2), DANA)] };
  await withGmail(mailbox, () => ingestGmail(e));
  const { awaiting_since } = await row(e, 't1');

  const before = Math.floor(Date.now() / 1000);
  await logAction(e, { thread_id: 'gmail:t1', kind: 'called', body: 'Left a voicemail.', status: 'waiting' });
  let t = await row(e, 't1');
  assert.ok(t.last_outbound_at >= before, 'the call is recorded as contact');
  assert.equal(t.status, 'waiting');
  assert.equal(t.awaiting_since, awaiting_since, 'clock not reset or cleared');

  await withGmail(mailbox, () => ingestGmail(e));
  t = await row(e, 't1');
  assert.equal(t.status, 'waiting', 'the sync does not treat the voicemail as a reply');
  assert.equal(t.awaiting_since, awaiting_since);
});

test("'replied' + 'closed' clears the clock", async () => {
  const e = env();
  const mailbox = { t1: [inbound(hoursAgo(2), DANA)] };
  await withGmail(mailbox, () => ingestGmail(e));

  await logAction(e, { thread_id: 'gmail:t1', kind: 'replied', status: 'closed' });
  const t = await row(e, 't1');
  assert.equal(t.status, 'closed');
  assert.equal(t.awaiting_since, null);
  assert.notEqual(t.last_outbound_at, null);
});
