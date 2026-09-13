// Pure rules, tested directly: states the routes cannot easily reach but the
// database can still hold (older rows, manual fixes, future write paths).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveState } from '../src/lib/thread-state.ts';

const T0 = 1789480800, CALL = T0 + 3600, LATER = T0 + 7200;

test('never resurrects waiting while last_outbound_at is newer than the newest inbound', () => {
  // A clock left running on the row, but a logged contact came after the only inbound.
  for (const status of ['waiting', 'answered']) {
    const s = resolveState(
      { status, last_inbound_at: T0, last_outbound_at: CALL, awaiting_since: T0 },
      [{ at: T0, inbound: true }],
    );
    assert.deepEqual(s, { status: 'answered', awaiting_since: null, reopened: false }, status);
  }
});

test('an inbound newer than last_outbound_at does start the clock again', () => {
  const s = resolveState(
    { status: 'answered', last_inbound_at: T0, last_outbound_at: CALL, awaiting_since: null },
    [{ at: T0, inbound: true }, { at: LATER, inbound: true }],
  );
  assert.deepEqual(s, { status: 'waiting', awaiting_since: LATER, reopened: false });
});

test('a logged contact ends a held clock: the next inbound starts a new one', () => {
  // Row still says awaiting since T0, a call was logged after it, then the customer wrote again.
  const s = resolveState(
    { status: 'waiting', last_inbound_at: T0, last_outbound_at: CALL, awaiting_since: T0 },
    [{ at: T0, inbound: true }, { at: LATER, inbound: true }],
  );
  assert.deepEqual(s, { status: 'waiting', awaiting_since: LATER, reopened: false });
});
