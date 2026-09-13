// Hand-verified business-clock cases, all America/Chicago. These must keep passing.
// Timestamps carry an explicit local offset so each case is unambiguous:
// -05:00 is CDT (summer), -06:00 is CST (winter).
//
// Every case runs in a worker thread with a deadline. node:test's own timeout
// cannot interrupt a synchronous infinite loop, so without this a clock that
// never returns hangs the whole suite instead of failing one test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

const at = (iso) => Date.parse(iso) / 1000;
const DEADLINE_MS = 3000;

function businessMinutesWithDeadline(fromIso, toIso) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./helpers/clock-worker.mjs', import.meta.url), {
      workerData: { from: at(fromIso), to: at(toIso) },
    });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`businessMinutes did not return within ${DEADLINE_MS}ms (${fromIso} -> ${toIso})`));
    }, DEADLINE_MS);
    worker.once('message', (mins) => { clearTimeout(timer); worker.terminate(); resolve(mins); });
    worker.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

const expectMinutes = async (fromIso, toIso, expected) =>
  assert.equal(await businessMinutesWithDeadline(fromIso, toIso), expected);

test('Tue 09:00 -> Tue 11:30 = 150', () =>
  expectMinutes('2026-09-15T09:00:00-05:00', '2026-09-15T11:30:00-05:00', 150));

test('Fri 16:50 -> Mon 08:10 = 20', () =>
  expectMinutes('2026-09-11T16:50:00-05:00', '2026-09-14T08:10:00-05:00', 20));

test('Sat 10:00 -> Sat 15:00 = 0', () =>
  expectMinutes('2026-09-12T10:00:00-05:00', '2026-09-12T15:00:00-05:00', 0));

test('Tue 16:00 -> Wed 09:00 = 120', () =>
  expectMinutes('2026-09-15T16:00:00-05:00', '2026-09-16T09:00:00-05:00', 120));

// DST ends Sun 2026-11-01 02:00 CDT -> 01:00 CST (the day is 25h long).
// Fri 16:00-17:00 CDT (60) + Mon 08:00-09:00 CST (60) = 120.
// A fixed-offset clock would read Mon 09:00 CST as 10:00 and return 180.
test('span crossing the November DST change = 120', () =>
  expectMinutes('2026-10-30T16:00:00-05:00', '2026-11-02T09:00:00-06:00', 120));

// DST starts Sun 2027-03-14 02:00 CST -> 03:00 CDT (the day is 23h long,
// 02:00-02:59 does not exist). Fri 16:00-17:00 CST (60) + Mon 08:00-09:00 CDT (60) = 120.
// The two transitions fail differently: November passed while this one hung.
test('span crossing the March DST change = 120', () =>
  expectMinutes('2027-03-12T16:00:00-06:00', '2027-03-15T09:00:00-05:00', 120));

// Mon 2026-10-26 08:00 CDT to Mon 2027-03-22 08:00 CDT is exactly 21 weeks and
// crosses both transitions: 21 x 5 workdays x 540 business minutes = 56700.
test('21 weeks spanning both DST changes = 56700', () =>
  expectMinutes('2026-10-26T08:00:00-05:00', '2027-03-22T08:00:00-05:00', 21 * 5 * 540));
