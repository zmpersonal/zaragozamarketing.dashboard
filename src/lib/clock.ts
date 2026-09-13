/**
 * Business-hours clock — America/Chicago, Mon-Fri 08:00-17:00.
 *
 * Response time is measured in business minutes only. An email that
 * lands Friday at 16:50 is ten minutes old until Monday morning, so
 * the report never accuses the agent of a 62-hour response for mail
 * that arrived after close.
 *
 * We store the IANA zone name, never a UTC offset, so the CST/CDT
 * switch is handled by the platform rather than by us remembering.
 */

export const ZONE = 'America/Chicago';
export const OPEN_MIN = 8 * 60;    // 08:00
export const CLOSE_MIN = 17 * 60;  // 17:00
export const WORKDAYS = new Set([1, 2, 3, 4, 5]); // Mon-Fri

const FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hourCycle: 'h23',
});

/** Local wall-clock parts for a unix timestamp, in the support zone. */
function parts(unixSec: number) {
  const f: Record<string, string> = {};
  for (const p of FORMAT.formatToParts(new Date(unixSec * 1000))) f[p.type] = p.value;
  return {
    year: Number(f.year),
    month: Number(f.month),
    day: Number(f.day),
    dayIndex: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(f.weekday),
    minuteOfDay: Number(f.hour) * 60 + Number(f.minute),
    second: Number(f.second),
  };
}

/** Seconds the zone's wall clock is ahead of UTC at this instant (negative in Chicago). */
function offsetAt(unixSec: number): number {
  const p = parts(unixSec);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, 0, p.minuteOfDay, p.second) / 1000;
  return wallAsUtc - unixSec;
}

/**
 * Unix time of a local wall-clock moment on a calendar date. Two passes:
 * the offset is looked up at a first guess, then again at the corrected
 * instant, which settles it on either side of a transition. Only valid for
 * wall times that exist on that date. The ones we ask for (00:00, 08:00,
 * 17:00) always exist in Chicago, whose changes happen at 02:00.
 */
function localToUnix(year: number, month: number, day: number, minuteOfDay: number): number {
  const wallAsUtc = Date.UTC(year, month - 1, day, 0, minuteOfDay) / 1000;
  const guess = wallAsUtc - offsetAt(wallAsUtc);
  return wallAsUtc - offsetAt(guess);
}

/** Business minutes elapsed between two unix timestamps. */
export function businessMinutes(from: number, to: number): number {
  if (to <= from) return 0;
  let total = 0;

  // The cursor is a local CALENDAR DATE, not an instant. Stepping the date
  // with Date.UTC(y, m, d + 1) is pure calendar arithmetic (it rolls months
  // and years, and knows nothing about DST), so every iteration advances
  // exactly one local day however long that day is in seconds (23, 24 or 25h).
  // Each day's business window is then resolved from its own wall times.
  const start = parts(from);
  let date = new Date(Date.UTC(start.year, start.month - 1, start.day));

  for (;;) {
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    if (localToUnix(y, m, d, 0) >= to) break;

    // The weekday of a calendar date does not depend on the zone.
    if (WORKDAYS.has(date.getUTCDay())) {
      const a = Math.max(from, localToUnix(y, m, d, OPEN_MIN));
      const b = Math.min(to, localToUnix(y, m, d, CLOSE_MIN));
      if (b > a) total += (b - a) / 60;
    }

    date = new Date(Date.UTC(y, m - 1, d + 1));
  }
  return Math.round(total);
}

/** True when the support desk is open right now. */
export function isOpen(unixSec: number = Math.floor(Date.now() / 1000)): boolean {
  const p = parts(unixSec);
  return WORKDAYS.has(p.dayIndex) && p.minuteOfDay >= OPEN_MIN && p.minuteOfDay < CLOSE_MIN;
}

/** "3h 20m" / "18m" — business time, for the queue and the report. */
export function formatBusiness(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 9) return m ? `${h}h ${m}m` : `${h}h`;
  const days = Math.floor(h / 9);          // a 9-hour business day
  const remH = h % 9;
  return remH ? `${days}d ${remH}h` : `${days}d`;
}
