# HANDOFF

This file holds open questions and known-wrong things carried forward. Remove an item only once
it's fixed and proven, or once the owner decides it.

Last updated: round 3, 2026-09-13.

---

## Lessons carried forward

### DST tests must cover both transitions: they fail differently
In round 1 the November test passed while any span crossing the **March** change hung forever.
- **November** (fall back, a 25-hour day) only risks an off-by-an-hour count.
- **March** (spring forward, a 23-hour day) broke the old "overshoot 2h, snap back to midnight"
  stepping, and the cursor never advanced.

`tests/clock.test.mjs` covers both, and every clock case runs in a worker with a deadline.

### A test that passes on the old code proves nothing until a break makes it fail
In round 3, several new tests passed against the code they were meant to guard:
- the five auth cases the owner asked for
- the webhook rejection tests against the legacy verifier
- "blocked_since is left alone by a sync" (the column didn't exist yet)
- "old conversations are not re-read" (the old code read no messages at all)

Each one was proven with a deliberate break instead. Test helpers can also make a failing test
fail for the wrong reason. Round 3 hit three cases:
- A default parameter swallowed `undefined`, so a "no exp" token still had `exp`.
- A fractional expected timestamp could never match Gmail's whole seconds.
- A race test matched SQL by exact text, and silently stopped intercepting when a column was
  added.

Check that the failing output shows the bug you're testing, not a mistake in the harness.

---

## Accepted gaps (owner decision, not bugs to fix yet)

### No per-thread authorization
Accepted in round 2. Any signed-in agent can:
- act on any thread (`POST /api/actions`, `POST /api/threads/:id/rescue`)
- read any thread (`GET /api/threads/:id`)
- complete any to-do

Access decides who can sign in; nothing decides which threads they may touch. Revisit before a
second agent or brand team is added.

---

## Decisions made this round that the owner should confirm

1. **A logged call with "still needs a reply" is stored as `answered`.** The rule "contact is a
   reply" wins over the dropdown. If the agent means "I called but they still need something",
   they have no way to keep the clock running. Add an explicit "follow-up needed" state?
2. **A new customer message on a blocked thread stays in the blocked group.** The blocked group
   sorts below every waiting thread. A customer writing again on a thread blocked on a supplier
   won't rise to the top, even though `awaiting_since` is set. Should blocked threads with a new
   inbound message be surfaced?
3. **An answered incoming Quo call counts as inbound followed by contact.** It never shows as
   waiting. A missed incoming call is waiting. An outgoing call counts as contact only if
   answered, and an undelivered outgoing text doesn't count.
4. **Quo polling reads 30 days back on a source's first poll,** matching Gmail.

---

## Unproven — needs a real system

### Quo webhook signature scheme (unproven until we have a real key)
Implemented as the scheme in Quo's **current versioned docs**, API 2026-03-30
(`www.quo.com/docs/2026-03-30/webhooks-overview`, `…/webhooks-quickstart`): Standard Webhooks.
- **Headers:** `webhook-id`, `webhook-timestamp` (seconds), and `webhook-signature` (`v1,<b64>`,
  space-separated).
- **Signature:** HMAC-SHA256 over `id.timestamp.rawbody`, with the `whsec_` secret
  base64-decoded as the key.
- **Replay window:** 5 minutes.
- **Fails closed.**

The ambiguity it replaces: round 2 implemented the **legacy** `openphone-signature` scheme from
`support.quo.com`. Its two samples disagree on key handling:
- Python uses the raw decoded key bytes.
- Node passes `toString('binary')` to `createHmac`, which re-encodes the key as UTF-8.

Those give different MACs for any key byte ≥ 0x80. That scheme is no longer accepted: a legacy
delivery gets a 401.

What is still unproven:
- **No real delivery has been verified** against either scheme.
- **Beta status is unclear.** Quo's changelog (May 11, 2026) calls the Standard Webhooks API
  "open beta" and says it is not interchangeable with the legacy header. The 2026-03-30 pages
  don't mention beta.
- **Webhooks created in the Quo dashboard or through v1 may still send the legacy header,** and
  would be rejected. Create the subscription with `POST https://api.quo.com/webhooks` and
  `Quo-Api-Version: 2026-03-30`, and store the returned `whsec_…` key as `QUO_WEBHOOK_SECRET`.
  Then send one real event and confirm a 200.
- **A misconfigured secret piles up retries.** Every delivery would get a 401, and Quo retries 8
  times over about 27.5 hours. Watch the logs.
- **The webhook doesn't ingest yet** and doesn't deduplicate by `webhook-id`. Delivery is
  at-least-once and events can arrive out of order, so both are needed before it writes
  anything.

### Quo v1 polling
Built from the v1 API reference (`www.quo.com/docs/mdx/api-reference`). Unverified against the
real API:
- **Array parameters** are sent as repeated `participants=` and `phoneNumbers=` keys. The OpenAPI
  default; not confirmed.
- **Early stop relies on the documented sort order.** `/v1/conversations` is assumed to return
  newest activity first, and paging stops at the first conversation older than the cursor. It's
  also unconfirmed whether `lastActivityAt` moves for calls as well as texts.
- **`createdAfter` is assumed exclusive.** The 5-minute overlap makes an inclusive boundary
  harmless.
- **Rate limit:** 2 requests per active conversation per poll, against a documented
  10 requests/second. A busy 5-minute window could hit it.
- **A permanently failing conversation pins the cursor.** Every later poll re-reads from the old
  cursor, a window that grows over time. Consider moving on after N failures and recording the
  item as skipped.
- **Group conversations have no call history,** because `/v1/calls` accepts one participant.
- **The dated API doesn't list messages yet.** Only users and webhooks are live in 2026-03-30;
  v1 "remains fully supported". Revisit when messages ship in the dated API.

### Other
- **D1 itself.** All SQL has run only on `node:sqlite` via the shim.
- **Gmail and OAuth** against real accounts.

---

## Known wrong — correctness

### 1. Response time is not recorded anywhere
- `first_response_mins` is never written, and there is no per-message response log.
- `awaiting_since` is a live snapshot: an inbound answered before the next sync never sets it at
  all.
- Every inbound is now observed (round 3), but the admin report needs a record of each
  inbound → first-reply pair, written when ingest sees the pair.

### 2. The UI still measures age in wall-clock hours
`ageLabel`, `heatColor`, "Over 24h", the 48h bar and the new "blocked 6d" all use `Date.now()`
hours. This breaks invariant 6 for response ages.

### 3. Triage isn't wired in
- Nothing calls `classify()`.
- `triage_score`, `triage_signals`, `sender_rule` and `known_sender` are never written.
- The UI has no demoted section and no rescue button.

### 4. `prove/quo.mjs` calls endpoints that don't exist in the version it sends
It calls unversioned `/phone-numbers` and `/conversations` with `Quo-Api-Version: 2026-03-30`,
which likely fails against the real API. It also reads only each conversation's latest activity.
It should use `/v1/…` like ingest.

### 5. `prove/gmail.mjs` uses the old direction and age logic
It decides direction by substring match and ages threads from the first message.

### 6. `POST /api/actions` doesn't validate `status` or `kind`
An unknown `thread_id` returns 500 (foreign key).

### 7. The UI renders `action.kind` unescaped
In the history panel.

### 8. The reopen action log isn't atomic with the reopen
**Where:** `src/db/threads.ts`.

### 9. Gmail ingest has no pagination
It reads 50 threads per mailbox, and `sync_cursor` is unused for Gmail.

### 10. The README is stale
It still says `/hooks/quo` "accepts anything today", describes the legacy signing secret, and
seeds Quo `source.address` as an E.164 number. Ingest now accepts the `PN…` id (preferred, since
messages and calls need `phoneNumberId`), and the conversations endpoint accepts either form.

---

## Known wrong — security and hardening

1. **`authenticate()` remaining gaps** (round 3 fixed `exp`, `aud`, malformed tokens and missing
   email):
   - It fetches the Access certs on every request, with no caching.
   - It doesn't check `iss` or `nbf`.
2. **Possible CSRF, to be checked.** `req.json()` ignores `Content-Type`. Whether a cross-site
   `text/plain` POST carrying the Access cookie gets through depends on `CF_Authorization`'s
   SameSite setting.
3. **`GET /api/threads/:id` doesn't URL-decode the id.** `/rescue` does.

## Scale and cost — verify before go-live

- **Subrequest limit.** Gmail makes 1 token call, 1 list call and up to 50 thread fetches per
  mailbox, every 5 minutes. Quo adds 1+ conversation page plus 2 requests per active
  conversation. Check both against the Workers plan's subrequest limit, historically 50 on Free.
- **D1 reads.** `syncThread` adds one SELECT per thread per sync. Check against the D1 free tier.

## Schema changes need migrations once a database exists

`schema.sql` uses `CREATE TABLE IF NOT EXISTS`. Round 3 renamed `first_inbound_at` →
`conversation_started_at` and added `blocked_since` while no database exists. After the first
real deploy, schema changes must go through `wrangler d1 migrations`.

---

## Open questions for the owner

1. Confirm the four decisions listed above.
2. **`main` has no commits.** There's nothing to open a PR against, so a human needs to decide
   how `main` gets its first commit.
3. **Brands in scope.** `schema.sql` seeds `caliza` and `reachjulian`, but V1 is INH only and the
   planned tabs are INH/THI/ZM.
4. **Mock data uses a shared-looking login** (`agent@inhousewellness.com`). Confirm the real agent
   signs in as a named person (invariant 8).
5. **Gmail OAuth consent screen.** If it's External and in Testing, refresh tokens expire after
   7 days. For Workspace, use Internal.
6. **`prove/triage.mjs` duplicates the triage rules** and has drifted. It could import
   `src/lib/triage.ts` directly. Approve?
7. **Stage vocabulary** and **weekend confirmation** (from README) are still open.

## Tooling notes
- npm 11 `allowScripts` skipped the `esbuild` and `workerd` postinstall scripts. `build` works;
  `wrangler dev` is untested.
- Wrangler telemetry is on by default. It's the owner's call.
