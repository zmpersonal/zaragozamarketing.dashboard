// businessTimeBefore is the inverse of businessMinutes, and the admin report
// needs it (round 15): bucketing open threads by business age one row at a time
// would run the day-stepping clock once per thread. Three boundary timestamps
// instead, computed once, and SQLite does the counting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { businessMinutes, businessTimeBefore } from '../src/lib/clock.ts';

const at = (iso) => Math.floor(Date.parse(iso) / 1000);
const H = 60;

test('it is the inverse of businessMinutes, inside and outside hours', () => {
  for (const nowIso of [
    '2026-09-25T15:30:00-05:00', // Friday afternoon, open
    '2026-09-25T19:30:00-05:00', // Friday evening, closed
    '2026-09-27T11:00:00-05:00', // Sunday
    '2026-09-28T08:00:00-05:00', // Monday, on the bell
    '2026-03-09T10:00:00-05:00', // the Monday after the spring change
    '2026-11-02T10:00:00-06:00', // the Monday after the autumn change
  ]) {
    const now = at(nowIso);
    for (const mins of [0, 1, 30, 2 * H, 8 * H, 24 * H, 100 * H]) {
      const then = businessTimeBefore(now, mins);
      assert.equal(businessMinutes(then, now), mins, `${nowIso} minus ${mins} business minutes`);
      assert.ok(then <= now);
    }
  }
});

test('zero is now, and a closed-hours now lands on the previous close', () => {
  const sundayNoon = at('2026-09-27T12:00:00-05:00');
  assert.equal(businessTimeBefore(sundayNoon, 0), sundayNoon);
  // One business minute before Sunday noon is 16:59 on Friday.
  assert.equal(businessTimeBefore(sundayNoon, 1), at('2026-09-25T16:59:00-05:00'));
});

test('a weekend is skipped, not counted', () => {
  const mondayNine = at('2026-09-28T09:00:00-05:00');
  // 2 business hours back from Monday 09:00 is Friday 16:00, not Sunday 07:00.
  assert.equal(businessTimeBefore(mondayNine, 2 * H), at('2026-09-25T16:00:00-05:00'));
});

test('it does not walk forever when there is nothing to find', () => {
  const now = at('2026-09-25T15:30:00-05:00');
  const t = businessTimeBefore(now, 5000 * H); // more than a year of business time
  assert.ok(t < now - 300 * 86400, 'goes back a long way');
  assert.ok(Number.isFinite(t));
});
