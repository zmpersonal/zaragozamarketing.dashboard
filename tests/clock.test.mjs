// Hand-verified business-clock cases, all America/Chicago. These must keep passing.
// Timestamps carry an explicit local offset so each case is unambiguous:
// -05:00 is CDT (summer), -06:00 is CST (winter).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { businessMinutes } from '../src/lib/clock.ts';

const at = (iso) => Date.parse(iso) / 1000;

test('Tue 09:00 -> Tue 11:30 = 150', () => {
  assert.equal(businessMinutes(at('2026-09-15T09:00:00-05:00'), at('2026-09-15T11:30:00-05:00')), 150);
});

test('Fri 16:50 -> Mon 08:10 = 20', () => {
  assert.equal(businessMinutes(at('2026-09-11T16:50:00-05:00'), at('2026-09-14T08:10:00-05:00')), 20);
});

test('Sat 10:00 -> Sat 15:00 = 0', () => {
  assert.equal(businessMinutes(at('2026-09-12T10:00:00-05:00'), at('2026-09-12T15:00:00-05:00')), 0);
});

test('Tue 16:00 -> Wed 09:00 = 120', () => {
  assert.equal(businessMinutes(at('2026-09-15T16:00:00-05:00'), at('2026-09-16T09:00:00-05:00')), 120);
});

// US DST ends Sun 2026-11-01 02:00 CDT -> 01:00 CST.
// Fri 16:00-17:00 CDT (60) + Mon 08:00-09:00 CST (60) = 120.
// A fixed-offset clock would read Mon 09:00 CST as 10:00 and return 180.
test('span crossing the November DST change = 120', () => {
  assert.equal(businessMinutes(at('2026-10-30T16:00:00-05:00'), at('2026-11-02T09:00:00-06:00')), 120);
});
