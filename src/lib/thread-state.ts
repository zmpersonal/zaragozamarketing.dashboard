/**
 * Thread state — who owes whom a reply, and since when.
 *
 * Pure: every ingest path observes a timeline of messages and asks this
 * module what status and awaiting_since the thread should have. The rules
 * live here once so Gmail, Quo and chat cannot drift apart.
 *
 *   conversation_started_at  when the conversation began. Set on insert, never moved.
 *   awaiting_since           the oldest inbound message with no outbound after it.
 *                            NULL when we are caught up. The response clock runs
 *                            from here, never from conversation_started_at.
 */
import { businessMinutes } from './clock.ts';

export interface Observed {
  at: number;        // unix seconds
  inbound: boolean;
}

/** The stored fields the rules depend on. */
export interface Existing {
  status: string;
  last_inbound_at: number;
  /** Includes contact an agent logged (a call, a reply sent outside the mailbox). */
  last_outbound_at: number | null;
  awaiting_since: number | null;
}

export interface ResolvedState {
  status: 'waiting' | 'answered' | 'blocked' | 'closed';
  awaiting_since: number | null;
  reopened: boolean;
}

const chronological = (timeline: Observed[]) =>
  [...timeline].sort((a, b) => a.at - b.at); // stable: same-second order is kept

/** Oldest inbound with no outbound after it, or null when the last word is ours. */
export function oldestUnanswered(timeline: Observed[]): number | null {
  let since: number | null = null;
  for (const m of chronological(timeline)) {
    if (!m.inbound) since = null;
    else if (since === null) since = m.at;
  }
  return since;
}

/**
 * The state a thread should have after observing `timeline`.
 *
 * - closed: stays closed unless an inbound arrives that we had not already
 *   recorded (newer than the stored last_inbound_at). Then it reopens, and
 *   awaiting_since counts only messages after that point. We compare against
 *   last_inbound_at rather than closed_at on purpose: a message that landed
 *   before the agent clicked close, but after the last sync, was never seen
 *   and must still reopen the thread.
 * - blocked: a human set it, so it stays blocked, but the clock still runs.
 * - otherwise: waiting if anything is unanswered, else answered.
 *
 * A contact the agent logged and RESOLVED (awaiting_since cleared, e.g. a
 * call marked answered) is treated as one more outbound event, so ingest
 * never resurrects 'waiting' from an inbound that contact already answered.
 * A contact the agent did not resolve (a voicemail: last_outbound_at set,
 * awaiting_since still running) does not stop the clock; the agent's status
 * choice is authoritative.
 *
 * Once a thread is awaiting, awaiting_since holds until we are seen to reply.
 * That keeps a reopened thread from sliding back to a pre-close message on
 * the next sync, and lets partial sources like Quo (which only report the
 * latest activity) keep the start of a run of unanswered texts.
 */
export function resolveState(existing: Existing | null, observed: Observed[]): ResolvedState {
  const resolvedContact = existing?.last_outbound_at != null && existing.awaiting_since === null;
  const timeline = resolvedContact
    ? [...observed, { at: existing.last_outbound_at as number, inbound: false }]
    : observed;

  if (existing?.status === 'closed') {
    const fresh = chronological(timeline).filter((m) => m.at > existing.last_inbound_at);
    if (!fresh.some((m) => m.inbound)) {
      return { status: 'closed', awaiting_since: null, reopened: false };
    }
    const since = oldestUnanswered(fresh);
    return { status: since === null ? 'answered' : 'waiting', awaiting_since: since, reopened: true };
  }

  let since = oldestUnanswered(timeline);
  const held = existing?.awaiting_since ?? null;
  if (since !== null && held !== null && !timeline.some((m) => !m.inbound && m.at >= held)) {
    since = held;
  }

  if (existing?.status === 'blocked') {
    return { status: 'blocked', awaiting_since: since, reopened: false };
  }
  return { status: since === null ? 'answered' : 'waiting', awaiting_since: since, reopened: false };
}

/** Business minutes this thread has been waiting on us, or null if caught up. */
export function responseMinutes(thread: { awaiting_since: number | null }, now: number): number | null {
  return thread.awaiting_since === null ? null : businessMinutes(thread.awaiting_since, now);
}
