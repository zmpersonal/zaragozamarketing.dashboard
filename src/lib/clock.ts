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

/** Local wall-clock parts for a unix timestamp, in the support zone. */
function parts(unixSec: number) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE,
    weekday: 'short', hour: '2-digit', minute: '2-digit',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour12: false,
  });
  const f: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(unixSec * 1000))) f[p.type] = p.value;
  const dayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(f.weekday);
  return {
    dayIndex,
    minuteOfDay: Number(f.hour) * 60 + Number(f.minute),
    dateKey: `${f.year}-${f.month}-${f.day}`,
  };
}

/** Business minutes elapsed between two unix timestamps. */
export function businessMinutes(from: number, to: number): number {
  if (to <= from) return 0;
  let total = 0;
  const DAY = 86400;

  // Walk day by day. At a handful of messages a day this is nowhere
  // near hot enough to justify anything cleverer.
  for (let t = from; t < to; ) {
    const p = parts(t);
    const dayStartUnix = t - p.minuteOfDay * 60;

    if (WORKDAYS.has(p.dayIndex)) {
      const windowStart = dayStartUnix + OPEN_MIN * 60;
      const windowEnd = dayStartUnix + CLOSE_MIN * 60;
      const a = Math.max(t, windowStart);
      const b = Math.min(to, windowEnd);
      if (b > a) total += (b - a) / 60;
    }

    // Jump to the next local midnight. Adding a flat 24h would drift an
    // hour twice a year, so we re-anchor off the day we just measured.
    t = dayStartUnix + DAY + 7200;       // overshoot into the next day
    t = t - parts(t).minuteOfDay * 60;   // then snap back to its midnight
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
