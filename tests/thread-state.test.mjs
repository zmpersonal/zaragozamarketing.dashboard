// Pure rules, tested directly: states the routes cannot easily reach but the
// database can still hold (older rows, manual fixes, future write paths).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveState } from '../src/lib/thread-state.ts';

const T0 = 1789480800, CALL = T0 + 3600, LATER = T0 + 7200;

test('a resolved contact (clock cleared) is never resurrected to waiting by the same inbound', () => {
  for (const status of ['answered', 'closed']) {
    const s = resolveState(
      { status, last_inbound_at: T0, last_outbound_at: CALL, awaiting_since: null },
      [{ at: T0, inbound: true }],
    );
    assert.equal(s.status, status, status);
    assert.equal(s.awaiting_since, null, status);
  }
});

test('an unresolved contact (voicemail: clock still set) does not stop the clock', () => {
  const s = resolveState(
    { status: 'waiting', last_inbound_at: T0, last_outbound_at: CALL, awaiting_since: T0 },
    [{ at: T0, inbound: true }],
  );
  assert.equal(s.status, 'waiting');
  assert.equal(s.awaiting_since, T0);
});

test('an inbound newer than a resolved contact starts the clock again', () => {
  const s = resolveState(
    { status: 'answered', last_inbound_at: T0, last_outbound_at: CALL, awaiting_since: null },
    [{ at: T0, inbound: true }, { at: LATER, inbound: true }],
  );
  assert.equal(s.status, 'waiting');
  assert.equal(s.awaiting_since, LATER);
});

test('after a voicemail the customer writes again: the clock still runs from the first message', () => {
  const s = resolveState(
    { status: 'waiting', last_inbound_at: T0, last_outbound_at: CALL, awaiting_since: T0 },
    [{ at: T0, inbound: true }, { at: LATER, inbound: true }],
  );
  assert.equal(s.status, 'waiting');
  assert.equal(s.awaiting_since, T0);
});
