# HANDOFF

This file holds open questions and known-wrong things carried forward. Remove an item only once
it's fixed and proven, or once the owner decides it.

Last updated: round 1, 2026-09-13.

---

## Known wrong — correctness

### 1. `businessMinutes()` loops forever across the March DST change
**Where:** `src/lib/clock.ts:58-59`.

**What happens:** it hangs for any span that includes the spring-forward Sunday (for example
Fri 2027-03-12 → Mon 2027-03-15). I reproduced it: the process was still running after 8s. The
November change works, and that case is tested.

**Why:**
- From Saturday 00:00 CST, `dayStartUnix + 86400 + 7200` lands on Sunday 03:00 CDT, because
  02:00 doesn't exist that night.
- Snapping back by `minuteOfDay * 60` (180 min in real seconds) lands on Saturday 23:00.
- So `t` never leaves Saturday.

**Impact today:** none, because nothing calls the function yet. Once it's wired into ingest or
the report, the first March weekend would burn the Worker's CPU limit on every cron run.

**Suggested fix (not applied):** advance by calendar date instead of seconds. For example, find
the next local midnight by adding a day to the `dateKey` and resolving that date's 00:00 in the
zone. Add a March test and prove it bites.

**Minor, same function:** `dayStartUnix` ignores the seconds of `from`, so a sub-minute offset
carries through every day window. The final `Math.round` hides it (≤1 min).

### 2. The UI measures age in wall-clock time
In `public/index.html`, `ageLabel`, `heatColor`, the "Over 24h" filter, the 48h heat bar and
the subtitle count all use `Date.now()` hours. This breaks invariant 5 (business minutes only).
Mail from Friday 16:50 shows as "~64h" and red on Monday morning.

### 3. Triage isn't wired in
- Nothing calls `classify()`.
- `thread.triage*`, `sender_rule` and `known_sender` are never read or written.
- The UI has no demoted section or reason codes.

Every inbox thread currently lands in the queue as a customer. That's safe, since nothing is
hidden, but the filter the owner approved does nothing yet.

### 4. Gmail ingest takes the customer from the *last* message's From
**Where:** `src/ingest/gmail.ts:55,79-80`.

**What happens:** if the last message is ours, `customer_name` and `customer_handle` are set to
our own support address. `ON CONFLICT` never updates those columns, so if the first sighting was
after our reply, the thread shows us as the customer permanently.

### 5. Gmail ingest `first_inbound_at` and `last_inbound_at` aren't inbound-specific
**Where:** `src/ingest/gmail.ts:57,83-84`.
- `first_inbound_at = msgs[0].internalDate` even when that first message is outbound, for
  example a thread we started.
- When the last message is outbound, `last_inbound_at` is set to `firstAt` rather than the
  latest inbound time.
- `first_inbound_at` is only ever set on insert, so this doesn't launder anything. It can still
  be wrong from the start.

### 6. Quo ingest `first_inbound_at` is the conversation's latest activity at first sight
**Where:** `src/ingest/quo.ts:36,59`.

A conversation with history the poller has never seen gets a "first inbound" of its most recent
event. That understates the wait. Outbound-last conversations get `last_inbound_at` = an
outbound time.

### 7. Quo ingest passes `source.address` as `phoneNumberId`
**Where:** `src/ingest/quo.ts:31`.

The README says `source.address` holds an E.164 number, but `prove/quo.mjs` passes the number's
`id` (`first.id`) as `phoneNumberId`, not `first.number`. One of the two is wrong. Settle it when
Quo is proved.

### 8. Gmail direction detection is a substring match
**Where:** `src/ingest/gmail.ts:56`.

`from.includes(src.address)` has two failure modes:
- Replies sent from a send-as alias count as inbound.
- An address that merely contains the support address counts as outbound.

### 9. `POST /api/actions` stamps `last_outbound_at = now()` on any status change
**Where:** `src/index.ts:188-201`.

That includes internal notes and marking something blocked. Beyond that:
- `status` and `kind` aren't validated.
- A thread id that doesn't exist fails the foreign key and returns a 500.

### 10. The UI renders `action.kind` unescaped
**Where:** `public/index.html:566`.

`kind` is free text accepted by the API, so a crafted value could inject HTML into the history
panel.

---

## Known wrong — security and hardening

1. **`/hooks/quo` accepts anything.** There's no signature check (TODO in the code). It only
   logs today, but it must be verified before it writes anything.
2. **`authenticate()` weaknesses:**
   - It fetches the Access JWKS on every API request, with no caching.
   - It doesn't check `iss`.
   - It checks `aud` with `.includes`, which does a substring match if `aud` is ever a string.
   - A malformed token throws inside `JSON.parse` and returns 500 instead of 401.
3. **No write authorization beyond sign-in.** Any agent can act on any thread and complete any
   to-do.
4. **Possible CSRF, to be checked.** `req.json()` parses the body whatever its `Content-Type`,
   so a cross-site `text/plain` form POST carrying the Access cookie might be accepted. Whether
   that's reachable depends on the `CF_Authorization` cookie's SameSite setting.

---

## Scale and cost — verify before go-live

- Gmail ingest makes 1 token call, 1 list call and up to 50 thread fetches per mailbox, every 5
  minutes. With 3 mailboxes that's 150+ outbound subrequests in one cron invocation. The Workers
  **Free** plan has historically capped subrequests at 50 per invocation. That conflicts with
  the README's "free tier covers this". Check the current limits.
- `source.sync_cursor` is never used, so every run re-reads 30 days of threads.
- There's no pagination in ingest or in the `prove/` scripts.

---

## Open questions for the owner

1. **Closed or blocked threads that get a new customer message.** Ingest keeps them
   closed/blocked (invariant 6), so a customer writing back on a closed thread never reappears
   in the queue. Is that intended? Or should new inbound after `closed_at` reopen the thread, or
   at least be flagged, without touching a human-set `blocked`?
2. **What "waiting how long" measures.** Once a thread goes answered → waiting again,
   `first_inbound_at` still points at the original message. The queue ranks and ages by it. Does
   the admin need a separate `waiting_since` for follow-ups, keeping `first_inbound_at` for
   first response only?
3. **`main` has no commits.** `claude/inh-round-1` is the only branch, so there's nothing to
   open a PR against. Decide how `main` gets its first commit (a human action).
4. **Wrong-project instructions load in this repo.** `/Users/convertcoldmedia/Desktop/CLAUDE.md`
   is the THI Autoposter's CLAUDE.md. Because it sits in an ancestor folder, every Claude session
   in this repo loads it, including its rules about the THI repo, Blotato and Slack. The
   `Claude Master/CLAUDE.md` router also doesn't list `zaragozamarketing.dashboard`. Should those
   files change? They're outside this repo and weren't touched.
5. **Brands in scope.** `schema.sql` seeds `inhouse`, `thi`, `caliza` and `reachjulian`, and the
   README registers Caliza and Reach Julian mailboxes. V1 is INH only, and the console's planned
   tabs are INH/THI/ZM. Should Caliza and Reach Julian be seeded at all, and where does ZM fit?
6. **Mock data uses a shared-looking agent login.** The UI mock uses `agent@inhousewellness.com`.
   Confirm the real agent signs in as a named individual (invariant 7).
7. **Gmail OAuth consent screen type.** If it's External and left in Testing, refresh tokens
   expire after 7 days and ingest dies silently. For a Workspace mailbox, use Internal.
8. **`prove/triage.mjs` keeps its own copy of the rules.** It's what the owner reads to approve
   the filter, and it has already drifted from `src/lib/triage.ts`. Node now strips types, so it
   could import `src/lib/triage.ts` directly. Approve that change for round 2?
9. **Stage vocabulary** (from README): waiting on the owner's real list.
10. **Weekend confirmation** (from README): the clock assumes Saturday and Sunday are fully
    closed.

## Tooling notes
- npm 11 `allowScripts` skipped the `esbuild` and `workerd` postinstall scripts. `build` works
  without them, but `wrangler dev` is untested. Approving them (`npm approve-scripts`) is the
  owner's call.
- Wrangler telemetry is on by default. It's disabled with `wrangler telemetry disable`, which is
  a machine-level setting, so that's the owner's call.
- The README tells you to `npm install -g wrangler`. Wrangler is now a pinned dev dependency, so
  use `npx wrangler`.
