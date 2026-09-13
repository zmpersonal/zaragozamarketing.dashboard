# HANDOFF

This file holds open questions and known-wrong things carried forward. Remove an item only once
it's fixed and proven, or once the owner decides it.

Last updated: round 2, 2026-09-13.

---

## Lessons carried forward

### DST tests must cover both transitions: they fail differently
In round 1 the November test passed while any span crossing the **March** change hung forever.
- **November** (fall back, a 25-hour day) only risks an off-by-an-hour count.
- **March** (spring forward, a 23-hour day where 02:00–02:59 doesn't exist) broke the old
  "overshoot 2h, snap back to midnight" stepping. The snap-back landed on 23:00 the previous day
  and the cursor never advanced.

A clock test suite with only one transition proves nothing about the other.
`tests/clock.test.mjs` now has both, plus a 21-week span across both. Every clock case runs in a
worker thread with a deadline, because `node:test`'s own timeout can't interrupt a synchronous
infinite loop.

---

## Accepted gaps (owner decision, not bugs to fix yet)

### No per-thread authorization
Accepted for now (round 2). Any signed-in agent can:
- act on any thread (`POST /api/actions`, `POST /api/threads/:id/rescue`)
- read any thread (`GET /api/threads/:id`)
- complete any to-do

Access decides who can sign in; nothing decides which threads they may touch. Revisit before a
second agent or brand team is added.

---

## Known wrong — correctness

### 1. The UI still measures age in wall-clock hours
Ages now run from `awaiting_since` (round 2), but `ageLabel`, `heatColor`, "Over 24h" and the
48h bar still use `Date.now()` hours. This breaks invariant 6 (business minutes only). Mail from
Friday 16:50 shows as "~64h" and red on Monday morning.

### 2. Triage isn't wired in
- Nothing calls `classify()`.
- `triage_score`, `triage_signals`, `sender_rule` and `known_sender` are never written.
- The UI has no demoted section and no rescue button. The `/rescue` route exists but nothing in
  the UI calls it.

Every thread is effectively a customer.

### 3. `first_response_mins` is never computed
`responseMinutes()` gives the live wait, but nothing records the first-response time for the
admin report.

### 4. Quo ingest only sees each conversation's latest activity
**Where:** `src/ingest/quo.ts`.
- `first_inbound_at` is the latest activity when first seen, not the conversation's first
  message.
- If a customer texts and we reply between two polls, the poller sees only our reply. A closed
  thread then won't reopen.
- A run of texts keeps the start of its `awaiting_since` only if a poll caught the first one.

A per-message source (the webhook, once it ingests, or the messages endpoint) would fix this.

### 5. Quo ingest passes `source.address` as `phoneNumberId`
**Where:** `src/ingest/quo.ts:32`.

The README seeds `source.address` as an E.164 number, while `prove/quo.mjs` passes the number's
`id`. One of the two is wrong. Settle it when Quo is proved.

### 6. `POST /api/actions` stamps `last_outbound_at = now()` on any status change
**Where:** `src/index.ts`.

That includes notes and marking something blocked. `status` and `kind` aren't validated, and an
unknown `thread_id` returns 500.

### 7. A human "answered" without an email is undone by the next sync
If an agent logs a phone call on an email thread and marks it answered, Gmail still shows the
customer's message as the last word. The next sync sets it back to `waiting` and the clock keeps
running from the original message. This predates round 2 (status behaved the same) but is now
more visible. It needs an owner decision on whether a logged call counts as a reply.

### 8. The UI renders `action.kind` unescaped
**Where:** `public/index.html` (history panel).

`kind` is free text from the API.

### 9. One bad thread stops the rest of that mailbox's sync
**Where:** `src/ingest/gmail.ts`, `quo.ts`.

The `try/catch` wraps the whole per-source loop, so any throw on one thread (a malformed message,
a SQL error) skips every later thread in that mailbox until the next cron.

### 10. The reopen action log isn't atomic with the reopen
**Where:** `src/db/threads.ts`.

`syncThread` writes the conditional UPDATE, then the `reopened` action row. If the second write
fails, the thread reopens without an audit entry.

### 11. `prove/gmail.mjs` uses the old logic
It still decides direction by substring match and ages threads from the first message. Its
output will disagree with ingest.

---

## Known wrong — security and hardening

1. **`authenticate()` weaknesses:**
   - It fetches the Access JWKS on every request, with no caching.
   - It doesn't check `iss`.
   - It checks `aud` with `.includes`, which does a substring match if `aud` is a string.
   - A malformed token returns 500, not 401.
2. **Possible CSRF, to be checked.** `req.json()` ignores `Content-Type`. Whether a cross-site
   `text/plain` POST carrying the Access cookie gets through depends on `CF_Authorization`'s
   SameSite setting.
3. **`GET /api/threads/:id` doesn't URL-decode the id.** The new `/rescue` route does.

---

## Unproven — needs a real system

- **Quo signature scheme against a real delivery.** Implemented from Quo's docs, with ms
  timestamps and raw-byte keys. The docs' two samples differ:
  - Python signs the raw body with the raw key bytes.
  - Node signs `JSON.stringify(parsed)`, and passes the key as a `'binary'` string, which Node's
    `createHmac` re-encodes as UTF-8. For a key with bytes ≥ 0x80, that gives a different MAC.

  We accept either payload form but use raw key bytes. **Before go-live:** point a Quo webhook at
  a dev endpoint and confirm a real delivery verifies. If it doesn't, check the key encoding
  first.
- **Quo retries on non-2xx for up to 3 days.** A missing or wrong `QUO_WEBHOOK_SECRET` means
  every delivery returns 401 and retries pile up. Watch the logs after setting the secret.
- **The webhook doesn't ingest yet.** A verified event is only logged.
- **Ingest SQL has only run on SQLite.** Tests run on `node:sqlite` through a shim, not on D1.
  The SQL is plain SQLite, but D1-specific behaviour (batch semantics, `meta.changes`) is
  unproven.
- **Gmail, Quo and OAuth** against real accounts (unchanged from round 1).
- **Closing via `POST /api/actions` sets `awaiting_since` NULL.** This isn't covered by a test,
  because route tests need a signed Access JWT, and none exist yet.

## Scale and cost — verify before go-live

- **Subrequest limit.** Gmail ingest makes 1 token call, 1 list call and up to 50 thread fetches
  per mailbox, every 5 minutes. With 3 mailboxes that's 150+ subrequests per invocation, against
  a Free plan that has historically capped subrequests at 50. Check the current limits.
- `source.sync_cursor` is unused, and there's no pagination.
- `syncThread` adds one SELECT per thread per sync. D1 queries are billed by rows read, so check
  this against the D1 free tier at real volume.

## Schema changes need migrations once a database exists

`schema.sql` uses `CREATE TABLE IF NOT EXISTS`. Adding `awaiting_since` there won't alter a table
that already exists. No D1 database exists yet (`database_id` is still a placeholder). Once one
does, schema changes should go through `wrangler d1 migrations`.

---

## Open questions for the owner

1. **Queue order changed.** It now sorts by `awaiting_since`, so open threads not awaiting us
   (for example blocked threads we've already replied to) drop below everything that is. The UI
   shows them with "—" instead of an age. Is that the ordering you want?
2. **Does a logged phone call count as a reply to an email thread?** (Known wrong #7.)
3. **`main` has no commits.** There's nothing to open a PR against, so a human needs to decide
   how `main` gets its first commit.
4. **Brands in scope.** `schema.sql` seeds `caliza` and `reachjulian`, but V1 is INH only and the
   planned tabs are INH/THI/ZM.
5. **Mock data uses a shared-looking login** (`agent@inhousewellness.com`). Confirm the real
   agent signs in as a named person (invariant 8).
6. **Gmail OAuth consent screen.** If it's External and in Testing, refresh tokens expire after
   7 days. For Workspace, use Internal.
7. **`prove/triage.mjs` duplicates the triage rules** and has drifted. It could import
   `src/lib/triage.ts` directly now. Approve?
8. **Stage vocabulary** and **weekend confirmation** (from README) are still open.
9. **`first_inbound_at` no longer matches its name.** It now means "conversation began", which
   can be our outbound message. Rename the column (for example `started_at`) while no database
   exists?

## Tooling notes
- npm 11 `allowScripts` skipped the `esbuild` and `workerd` postinstall scripts. `build` works;
  `wrangler dev` is untested.
- Wrangler telemetry is on by default (`wrangler telemetry disable` turns it off). That's the
  owner's call.
- The README says `npm install -g wrangler`. Use the pinned `npx wrangler` instead.
