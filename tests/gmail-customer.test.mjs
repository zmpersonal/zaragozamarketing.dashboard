// Gmail ingest: the customer on a thread is always the sender of the FIRST
// INBOUND message, never whoever sent the newest one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestGmail } from '../src/ingest/gmail.ts';
import { makeEnv, withGmail, inbound, outbound, row, MAILBOX } from './helpers/gmail.mjs';

const DANA = 'Dana Reyes <dana@example.com>';

test('newest message is our reply -> customer is still the first inbound sender', async () => {
  const env = makeEnv();
  await withGmail({
    t1: [inbound('2026-09-15T09:00:00-05:00', DANA), outbound('2026-09-15T10:00:00-05:00')],
  }, () => ingestGmail(env));

  const t = await row(env, 't1');
  assert.equal(t.customer_name, 'Dana Reyes');
  assert.equal(t.customer_handle, 'dana@example.com');
});

test('first seen after our reply, customer is not frozen as our address', async () => {
  const env = makeEnv();
  const mailbox = {
    t1: [inbound('2026-09-15T09:00:00-05:00', DANA), outbound('2026-09-15T10:00:00-05:00')],
  };
  await withGmail(mailbox, () => ingestGmail(env));
  mailbox.t1.push(inbound('2026-09-15T11:00:00-05:00', DANA, 'Re: Sauna heater tripping the breaker'));
  await withGmail(mailbox, () => ingestGmail(env));

  const t = await row(env, 't1');
  assert.equal(t.customer_handle, 'dana@example.com');
  assert.notEqual(t.customer_handle, MAILBOX);
});

test('a colleague replying later does not replace the original customer', async () => {
  const env = makeEnv();
  await withGmail({
    t1: [
      inbound('2026-09-15T09:00:00-05:00', DANA),
      inbound('2026-09-15T09:30:00-05:00', 'Sam Ortiz <sam@example.com>', 'Re: Sauna heater tripping the breaker'),
    ],
  }, () => ingestGmail(env));

  const t = await row(env, 't1');
  assert.equal(t.customer_name, 'Dana Reyes');
  assert.equal(t.customer_handle, 'dana@example.com');
});

test('our reply sent from a send-as alias is outbound, not the customer', async () => {
  const env = makeEnv();
  await withGmail({
    t1: [
      inbound('2026-09-15T09:00:00-05:00', DANA),
      outbound('2026-09-15T10:00:00-05:00', 'Julian <julian@inhousewellness.com>'),
    ],
  }, () => ingestGmail(env));

  const t = await row(env, 't1');
  assert.equal(t.customer_handle, 'dana@example.com');
  assert.equal(t.status, 'answered');
});
