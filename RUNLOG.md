# RUNLOG

One entry per round, newest first. Each entry covers what changed, what was proved, and what is
still unproven.

---

## Round 9 — the queue bug, and ingest moves to GitHub Actions (2026-09-14, branch `claude/inh-round-9`, cut from `claude/inh-round-8`)

Nothing was deployed, merged, pushed, or PR'd. Mid-round the owner changed the round: the
security fixes, deleted-mail handling and UI wiring moved to round 10, and ingest moved off
Workers. Deleted-mail work already started (tests only) is in `git stash`, not on the branch.

### What changed
1. **Queue separation** (`edf947c`): each tier of `/api/queue` is its own query with its own
   limit (500 / 200 / 200). The response carries `tiers: {shown, total}`, and a cut section says
   "N of M" in the UI. Unknown tiers are served with Needs reply.
2. **Database abstraction** (`c22d7ae`): `src/db/db.ts` (`Db`, which the binding satisfies) and
   `src/db/d1-http.ts` (the same surface over the D1 REST API).
   - The client retries 429 (Retry-After, capped at 30 s) and retries 5xx and network errors for
     read-only statements only. It never retries 4xx, and the token never appears in an error.
   - `selfCheck()` confirms parameters round-trip with their types.
   - Ingest and the thread writes take `Db`; queries, triage, clock and state rules are unchanged.
   - Ingest now returns a summary (failed sources, failed items, processed).
3. **Caps for a runner** (same commit): Gmail 150 threads / 600 D1 statements, Quo 80
   conversations / 400 statements, larger pages. `Budget` takes a wall-clock deadline. The
   Worker lost its scheduled handler and cron triggers; `wrangler.toml` has the account and D1 IDs.
4. **Runner and workflow** (`5d05b58`):
   - `scripts/ingest.mjs` checks configuration, then the self-check, then runs Gmail (to 45 s)
     and Quo (to 80 s), and prints a summary per source.
   - A source it can't read gives `::error::` and exit 1; failed items give `::warning::`.
   - Every printed line is redacted.
   - `.github/workflows/ingest.yml`: hourly at :17 plus manual runs, one job, 2-minute timeout,
     secrets only as step environment, no overlapping runs, and a keepalive empty commit after
     45 quiet days.
5. **Docs:** CLAUDE.md, README and HANDOFF describe the split runtime and remove the Workers
   Paid requirement. The trade is recorded: hourly email, 15–60 minute schedule delays, and
   phone not real-time until the webhook writes threads.

### Failing first, then passing
- **Queue separation:** 4/4 failed on the old single query (with only the limits constant
  added), including "customer thread c0 missing from the queue". The UI "N of M" test: 1 failed,
  then 9/9. After: 4/4. 7/7 breaks caught, including a single query with a 100,000 limit
  ("headroom, not separation").
- **D1 REST client:** the module was missing, so the file failed to load. After: 11/11.
  - 18 breaks, 15 caught first time.
  - Two misses got new tests: `first()` returning the last row, and a statement-level
    `success: false`. Both are now caught.
  - One is equivalent: with string params, `?1 = 7` already fails the self-check, so dropping
    the numeric-type check changes nothing.
- **Binding vs HTTP parity:** the same Gmail and Quo scenarios leave identical databases. Its
  breaks (changes always 0, first row wrong) are caught.
- **Run limits:** 5/5 failed (no deadline, Workers-sized caps). After: 5/5. The deadline and cap
  breaks are caught.
- **Worker has no cron:** failed while `scheduled` existed; passes after removal.
- **Runner:** failed to load (no module); 8/8 after. The workflow tests were written with the
  workflow, so their proof is the breaks.
  - 20 breaks, 17 caught first time.
  - Two misses got new tests (Gmail throwing mid-run, ingest logs bypassing the redactor); the
    third was a break that didn't move the keepalive step, now replaced by one that does.
  - All 3 are now caught.
- **Existing tests:** two fixtures assumed the old small caps (page smaller than a run). They
  were fixed to model the real page sizes. The cap assertions tied to Workers Paid now assert
  finiteness, with the real justification in `tests/run-limits.test.mjs`.
- **Totals:** 240 tests, 240 pass, 0 fail. Check and build are clean, verified after staging.

### Actions minutes
730 runs a month. Expected ~740 billed minutes (1 per normal run, plus a few 2-minute backfill
runs): 37% of the free 2,000. Worst case with every run hitting the 2-minute timeout: 1,460 (73%).

### Still unproven
- The workflow on GitHub (it runs only once merged to the default branch).
- The D1 REST API itself: parameter types (self-check on every run), batch atomicity, latency.
- Workers Free CPU for API requests.

---

## Round 8 — deploy blockers: known senders, Quo budget, cost (2026-09-14, branch `claude/inh-round-8`, cut from `claude/inh-round-7`)

Nothing was deployed, merged, pushed, or PR'd. No history was rewritten.

### What changed
1. **`prove/apply-known-senders.mjs`:** takes the sent-mail backfill, drops our own domain (any
   case, any subdomain; lookalike domains kept) and writes the SQL that is applied. It also
   deletes own-domain rows left by an earlier unfiltered apply. Output is byte-identical for the
   same input, and applying it again changes nothing. `--sqlite` applies it to a local file;
   production is `wrangler d1 execute --remote` by a human.
2. **Quo ingest is bounded per run** (`src/ingest/quo.ts`), with the same shape as Gmail: a
   `{highWater, scan}` cursor, at most 2 listing pages and 20 conversations per run, a page cap
   per conversation, and the shared fetch and query `Budget`. The cursor becomes the completed
   scan's start time. The fake Quo API now pages.
3. **Docs:** Workers Paid ($5/month) is required, in CLAUDE.md and README, from Cloudflare's docs.
   HANDOFF notes that RUNLOG commit IDs for rounds 1–6 don't resolve after the rewrite, plus
   this round's findings.

### Failing first, then passing
- **Apply known senders:** 7/7 failed first (no script); 7/7 after. 12/12 breaks caught.
- **Quo budget:** the new file failed to load on the old code. With only `QUO_LIMITS` added,
  5 of 7 failed. The 2 that passed were the constants check and the multi-run-activity test,
  which old code passes only by reading everything in one run. After: 10/10.
  - 15 breaks: 13 caught first time.
  - The misses were no per-run conversation cap (the listing cap hid it at page size 10) and
    uncounted fetches (the D1 limit bit first). A test was added for each and both are caught.
  - My first break for the cursor rule was too weak. The sharper one (cursor = scan end time)
    was missed while the scan fit inside the 5-minute overlap; the test now spans three runs
    and it is caught.
- **Existing Quo tests:** assertions on the old cursor format (a plain number of the newest
  event) were updated to `highWater`. Same intent: held on failure, advances after success.
- **Totals:** 203 tests, 203 pass, 0 fail. Check and build are clean, verified after staging.

### Real runs
- **Trash re-run (before touching the state):** incremental, 6 threads changed, 262 → 267
  threads (customer 45 → 46, bulk 39 → 40, spam 178 → 181). **Trash in window: 0; newly
  trashed: 0.** support@ Trash is empty. History shows 5 permanent deletions: 4 were ingested
  spam from 14–15 August (Gmail's 30-day purge) and 1 was never ingested. See HANDOFF.
- **Known senders:** 723 in, 8 filtered, 715 applied. Local database 724 → 716 rows, 0
  own-domain. A second apply left it at 716.
- **Queue check on local data:** `/api/queue`'s query returns 37 of 45 Needs-reply threads
  (HANDOFF, Known wrong 0).

### Still unproven
- Trash ingest on real mail.
- Anything on Cloudflare: D1, cron, Access, the UI against the real API.
- Quo against the real API (paging, page-token lifetime).

---

## Round 7 — privacy, incremental ingest, known senders, counts (2026-09-13, branch `claude/inh-round-7`, cut from `claude/inh-round-6`)

Nothing was deployed, merged, pushed, or PR'd. Every change was done test-first. No database
was written except local files outside the repo.

### What changed
1. **Customer addresses out of the repo.**
   - `src/lib/known-customers.ts` deleted. Verified customers are `sender_rule` rows from a seed
     kept outside the repo; `seeds/sender_rule.example.sql` shows the shape with fabricated rows.
   - Tests and the UI mock use fabricated addresses.
   - `tests/no-personal-addresses.test.mjs` fails on any consumer-mail-domain address under
     `src/`, `tests/`, `public/` or `prove/`, with a self-test for its detector.
   - Docs no longer name the customer or list individual outreach senders.
   - This branch's history was rewritten to remove them (see HANDOFF, Known wrong 8).
2. **Gmail ingest is incremental** (`history.list` from `source.sync_cursor`), with a bounded
   backfill on an empty cursor, a bounded window fallback on 404/400, and a per-invocation
   `Budget` over fetches and D1 statements. Gmail and Quo have separate cron triggers.
   - Drafts and chats are ignored when working out direction.
   - A non-contact `answered` on a thread still awaiting a reply stays `waiting`.
3. **`prove/backfill-known-senders.mjs`**, a one-off (not in cron): every To/Cc/Bcc recipient of
   all sent mail becomes a `known_sender` row, written as SQL to a file outside the repo.
4. **Header and per-brand counts are Needs reply only** (`headerCounts`, `brandCell`,
   `/api/board`).
5. **`prove/ingest-live.mjs`** runs the real ingest into a local SQLite file outside the repo and
   reports tiers, trash and newly-trashed threads. The fake Gmail history now honours
   `historyTypes` and records label removals.

### Failing first, then passing
- **Personal-address guard:** 1 of 2 failed first (the scan found the address; the detector
  self-test passed). 9/9 breaks caught once the harness copied `seeds/`.
- **Header counts:** failed first (no module). 4/4 after; 4/4 breaks caught.
- **Incremental ingest:** 9/9 failed first. 10/10 after, with a test that the defaults stay
  under Workers Paid caps.
  - 12 breaks: 8 caught first time. One miss was an invalid mutant (a syntax error).
  - Removing either budget check alone is not caught, because the other check still stops the
    run. Removing both is caught.
  - Budget-above-cap and one-cron-for-both are caught after the new test and a valid mutant.
- **Known-sender backfill:** 4 of 6 failed first; the other 2 (prints no addresses, not in
  cron) passed vacuously with no script. 12/12 breaks caught after the earliest-send test was
  given a recipient written to twice (it missed at first).
- **Live ingest check:** failed first (no module). 4/4 after; 9/9 breaks caught, plus 2/2 on the
  shared outside-repo guard.
- **Totals:** 186 tests, 186 pass, 0 fail. Check and build are clean, verified after staging.

### Real runs (support@)
- **Backfill:** 2,192 sent messages scanned back to 2024-11-22 (under the cap), giving
  723 known senders. The file applies cleanly to `schema.sql` twice.
- **Live ingest baseline:** 262 threads (45 customer, 39 bulk, 178 spam) in 11 runs; the
  heaviest run used 28 fetches and 87 D1 statements. 0 failures. Trash in the window: 0.
- **Trash:** empty on support@. Waiting for the owner to move a junk message to Trash, then
  `prove/ingest-live.mjs` is re-run against the same state file.

### Still unproven
- Trash ingest on real mail (pending the owner's hand move).
- Anything on real Cloudflare: D1, cron triggers, limits.
- Quo ingest budget.

---

## Round 6 — spam becomes its own tier; ingest sees the real stream (2026-09-13, branch `claude/inh-round-6`, cut from `claude/inh-round-5`)

Nothing was deployed, merged, pushed, or PR'd. Every change was done test-first.

### What changed
1. **`d8e0ef7` — `NOREPLY`** allows a hyphen, underscore, dot, or nothing between words
   (`testflight_no_reply@`). No other rule changed.
2. **`e275f76` — `classify()` returns a tier:** `customer` / `bulk` / `spam`.
   - Gmail's SPAM label routes to `spam` only, with weight 0, and adds nothing to the bulk
     score. Spam plus bulk is `spam`.
   - Agent-marked spam is `spam`.
   - Exemptions beat Gmail spam. A known-customer list held one verified customer address
     (removed in round 7: customer addresses never go in the repo).
3. **`24af341` — Gmail ingest reads the round-5 population,** paged, with `includeSpamTrash`,
   and logs the query.
   - It fetches each distinct thread, classifies it from the first inbound message, and stores
     the tier and reasons, never over a human verdict.
   - Exemptions come from `sender_rule`, the known-customer list, `known_sender` and
     replied-to threads. Replying records the sender in `known_sender`.
4. **`70d5e28` — UI** (`public/queue-sections.mjs`): Needs reply, Probably not customers (reason
   chips), and Spam at the bottom with a count, always expanded, with full sender and subject.
   `/api/queue` returns the triage fields.
5. **`a740bce` — `prove/triage.mjs`:** three tiers and the known-customer list, via
   `prove/_triage-rules.mjs` with a 343-shape parity test. Prints SPAM / BULK / CUSTOMER.
6. **Docs:** CLAUDE.md invariant 5, README, HANDOFF ("Why the spam tier exists", and decisions
   8–12), and this entry.

### Failing first, then passing
- **No-reply separators:** 5 new shapes failed. After: 20/20 triage tests, with a real-name
  guard (`noah.replyman@`) added after an over-broad break was missed. 5 breaks caught.
- **Tiers:** 10 tests, all failing first. There was no `tier`, SPAM added 2 to the bulk score,
  and the list was empty. After: 10/10. 8 breaks caught.
- **Ingest population:** 7 tests, 6 failing first. Archived and spam mail wasn't ingested, and
  there was no log, no tiers and no exemptions; the sent-only guard passed vacuously. After:
  7/7. 10 breaks caught.
- **UI sections:** 8 tests. The module was missing, and the queue API returned no triage
  fields. After: 8/8. 9 breaks run, 8 caught; the 9th keeps the tested header, so it violates
  nothing. Checked in the browser over HTTP with no console errors.
- **Prove script:** CLI and parity failed first; the old script printed
  `3 kept, 5 demoted` and demoted the verified customer. After: passing. 7 breaks caught.
- **Totals:** 160 tests, 160 pass, 0 fail. Check and build are clean, verified after staging.
  39 breaks caught out of 40 run.

### Real run (support@, 30 days)
- `TOTAL: 284 messages, 40 customer, 58 bulk, 186 spam`. It reconciles with round 5.
- The output was scanned for key material: none.

### Still unproven
- Trash threads in ingest.
- Ingest volume on Workers (a go-live blocker).
- `known_sender` backfill.
- Everything from round 5.

---

## Round 5 — prove the filter against the real stream (2026-09-13, branch `claude/inh-round-5`, cut from `claude/inh-round-4`)

Nothing was deployed, merged, pushed, or PR'd. Both changes were done test-first.

### What changed
1. **`61f703f` — no-reply rule.** `NOREPLY` matches anywhere in the local part, never the
   domain. `prove/triage.mjs` carries an identical copy, checked by a parity test. No other
   triage rule changed.
2. **`08a0474` — `prove/triage.mjs` sampling.**
   - **Query:** `in:anywhere newer_than:30d -in:sent -in:drafts -in:chats`, with
     `includeSpamTrash=true`.
   - **Paging:** both lists are paged to the end. The received list had been one 400-message
     page; the sent list behind the exemption set had been capped at 200. That second cap was
     also an input-completeness fix; the exemption rule is unchanged.
   - `messages.get` runs 8 at a time.
   - **Output:** TOTAL and QUERY first, then `date | sender | subject(50) [| reasons]`.

### Failing first, then passing
- **No-reply rule:** 9 new tests, 5 failing first. The 4 in-the-middle shapes (`no-reply-calendar@`,
  `notifications-noreply@`, `noreply-apps-scripts-notifications@`, `workspace-noreply@`) weren't
  flagged, and the parity check failed.
  - The 4 false-positive guards (`sarah.kreplin@`, `repairs@`, `replyguy.jones@`, `noreply` in
    the domain) passed on the anchored rule and are proven by breaks.
  - After: 14/14 triage tests.
- **Sampling:** the fake Gmail now models a mailbox with inbox, archived, filtered, spam,
  trash, sent, draft, chat and out-of-window mail. It uses 2-message pages, and the exemption
  lives on page 2 of sent mail.
  - Before: 2 tests failed. On that mailbox the old script counted 1 of 6 messages and 2 exempt
    senders, missing the page-2 one. The truncation test passed vacuously, so a subject longer
    than 50 characters was added.
  - After: 4/4.
- **Breaks:** no-reply 7, sampling 7 = **14 caught**. The unmodified copies passed 128/128,
  then 129/129.
- **Totals:** 129 tests, 129 pass, 0 fail. Check and build are clean.

### Real run (support@, 30 days)
- `TOTAL: 284 messages, 39 kept, 245 demoted`, in 10.6 seconds.
- 47 exempt senders from 147 sent messages.
- The output was scanned for key material: none.
- Round-4 conclusions are withdrawn. Findings are in HANDOFF.

### Still unproven
The same as round 4. Also: whether 284 is the whole stream, compared with the 300–600
estimate.

---

## Round 4 — real data (2026-09-13, branch `claude/inh-round-4`, cut from `claude/inh-round-3`)

Nothing was deployed, merged, pushed, or PR'd. Every change was done test-first.

### Part A — what changed

1. **`844e746` — the agent's status is authoritative.**
   - Contact always stamps `last_outbound_at`, but only `answered` or `closed` clears
     `awaiting_since`.
   - Ingest counts a stored contact as a reply only when the clock was cleared. Otherwise the
     next sync would have silently stopped a voicemail's clock.
   - 3 round-3 tests were rewritten to the new rule.
2. **`9ef02fa` — a customer chasing a blocked thread moves it back to waiting.**
   - `awaiting_since` is set, `blocked_since` is cleared, and `blocked_on` / `blocked_note` are
     kept.
   - A `system` / `unblocked` action is logged.
3. **`6771a54` — an append-only `response` table,** with UNIQUE(`thread_id`, `awaiting_since`).
   - Ingest records every completed wait, including ones between syncs.
   - The route records a wait when the agent stops the clock (`via` = `replied`, `called` or
     `closed`).
   - Why a table: a column loses the first measurement when a thread reopens.
4. **`73a1f46` — `ingest_failure` table.**
   - A Quo conversation is skipped after 3 consecutive failures, so the cursor moves on. A
     success clears the row.
   - Gmail threads are recorded too.
   - `GET /api/board` returns `ingest_failures`.
5. **`01d55bf` — `prove/quo.mjs`** uses `/v1/phone-numbers` plus the exported ingest helpers
   and `resolveState`.
6. **`92eb471` — README** rewritten to match the code.

### Part A — failing first, then passing

| Item | Before | After |
|---|---|---|
| A1 status authority | 12 tests, **5 fail**: voicemail and no-status → `answered`; blocked-call cleared the clock; pure rules stopped an unresolved clock | 12/12 |
| A2 unblock | 21 tests in 3 files, **3 fail**: `'blocked' !== 'waiting'` | 21/21 (+1 guard) |
| A3 response time | 10 tests: first 10 fail (no table); with the table, **9 fail** on behaviour (1 vacuous) | 12/12 (+ close-then-reopen, UNIQUE safety net) |
| A4 poison pill | 4 tests, **4 fail**. Scratch demo on old code: 5 polls, `sync_cursor` stayed null, the full 30-day window re-read every time | 4/4 |
| A5 `prove/quo.mjs` | 3 tests (real CLI in a child process against the fake v1 API), **2 fail**: `unexpected fetch https://api.quo.com/phone-numbers` | 3/3 |
| A6 README | docs, no test | — |

- **Part A totals:** 109 tests pass, 0 fail. Check and build are clean.
- **Deliberate breaks:** A1 6, A2 6, A3 13, A4 8, A5 2 = **35 caught**.
  - One A3 break (no UNIQUE) was initially missed: no current path produces a duplicate. A
    direct safety-net test now pins it.

### Part B — Gmail on a service account, and the real triage run

- **`87a018a` — `src/lib/google-auth.ts`.**
  - An RS256 JWT signed with WebCrypto, impersonating the mailbox, `gmail.readonly` only,
    exchanged via the JWT-bearer grant.
  - Tokens are cached per subject. Errors never carry the key or the assertion.
  - Gmail ingest uses the `GOOGLE_SERVICE_ACCOUNT_JSON` secret (Workers have no filesystem).
  - Refresh-token env vars were removed. `.gitignore` now covers key files.
  - Tests: 7 failed first (module missing), +1 after a break exposed a gap. 14 breaks caught.
- **`c8769bc` — the prove scripts** (`prove/triage.mjs`, `prove/gmail.mjs`) read the key via
  `GOOGLE_SERVICE_ACCOUNT_FILE` (`prove/_google.mjs`).
  - `prove/oauth-bootstrap.mjs` was removed.
  - 3 CLI tests failed first (the scripts demanded refresh tokens). 4 breaks caught.
  - Fixed the secret-hygiene test, which `87a018a` had committed while failing: it was run
    before `git add`. 2 leak breaks caught (the first attempt was mis-built, and redone).
- **`cb49d3b` — the first real run crashed** (`full.payload.headers is not iterable`).
  - The script sent `metadataHeaders` comma-joined, which Gmail reads as one header name.
    Verified on real mail by header counts only.
  - Fixed to send repeated parameters. The fake Gmail now mirrors the real behaviour and
    reproduced the crash first. 1 break caught.
  - No triage rule changed.
- **Real run:** `prove/triage.mjs support@inhousewellness.com`, 30 days: exit 0.
  - 46 messages: 30 kept (1.0/day), 16 demoted (0.5/day), 47 exempt senders.
  - The key was never printed; outputs were scanned for key material. Findings are in HANDOFF.

**Round totals:**
- 119 tests, 119 pass, 0 fail. Check and build are clean.
- 56 deliberate breaks caught: 35 in Part A, 21 in Part B.

### Still unproven
- The Worker's service-account path on Cloudflare.
- Delegation for other mailboxes.
- The Quo webhook against a real delivery.
- Quo v1 behaviour against the real API.
- D1 itself.

---

## Round 3 — correctness, part two (2026-09-13, branch `claude/inh-round-3`, cut from `claude/inh-round-2`)

Nothing was deployed, merged, pushed, or PR'd. Every item was done test-first: write the test,
watch it fail, fix, watch it pass.

### What changed
1. **Rename, `b8f1570`.** `first_inbound_at` → `conversation_started_at` across the schema,
   `src`, tests, UI, CLAUDE.md and the README. The meaning is unchanged. RUNLOG and HANDOFF keep
   the old name as history.
2. **Auth, `b272d2a`.** Added tests for the authenticated routes, using real RS256 Access tokens
   (`tests/helpers/access.mjs`). Fixed four holes in `authenticate()`, described below.
3. **Logged contact counts as a reply, `9458969`.**
   - `replied` and `called` actions stamp `last_outbound_at`, clear `awaiting_since`, and move a
     waiting thread to answered.
   - Other kinds no longer stamp `last_outbound_at`.
   - `resolveState()` counts the stored `last_outbound_at` as an outbound event, so ingest can
     never resurrect `waiting` after a logged contact.
4. **`blocked_since`, `18abc1f`.** Set on the move to blocked, kept while blocked, cleared on
   leaving. The queue shows waiting threads, then blocked threads by `blocked_since`. The UI
   shows "blocked 6d".
5. **Per-thread isolation, `b52b3e3`.** Gmail's `try/catch` now wraps each thread instead of the
   whole mailbox.
6. **Quo polling, `38d13d5`.**
   - Reads `/v1/messages` and `/v1/calls` created after a per-source `sync_cursor`, for
     conversations with activity since that cursor.
   - The cursor advances only when every conversation synced, and failures are isolated per
     conversation.
   - The old code called unversioned `/conversations` with the 2026-03-30 header.
7. **Quo webhook, `ad94a0b`.** Replaced the legacy `openphone-signature` verifier with Standard
   Webhooks, the only scheme in Quo's 2026-03-30 versioned docs. It fails closed, and the legacy
   header gets a 401.
8. **Docs.** CLAUDE.md invariants, plus this entry and HANDOFF.

### Failing first, then passing

| Item | Before | After |
|---|---|---|
| 4 rename | 2 tests, 0 pass: column missing; 9 files still named the old column | 2/2 |
| 6 auth | 13 tests, 9 pass, **4 fail**: no-`exp` token → 200; `aud` substring `x-<aud>-y` → 200; malformed token → `InvalidCharacterError` (500); token with no email → 200. The 5 requested cases passed on the old code and were proven by breaks. | 13/13 |
| 1 contact | 6 tests, **0 pass**: after a logged call, `awaiting_since` still set; a note stamped `last_outbound_at`; the sync flipped the thread back to `waiting` | 6/6, +1 waiting-coercion test and 3 pure `resolveState` tests |
| 5 blocked | 3 tests, 1 pass (vacuously), **2 fail**: `blocked_since` not set; column missing | 3/3 |
| 3 isolation | 2 tests, **0 pass**: the thread after the malformed one was never ingested (TypeError shape and NOT NULL shape) | 2/2 |
| 2 Quo | 9 tests, 1 pass (vacuously), **8 fail**: interleaved inbound not observed (`last_inbound_at` 09:10, expected 09:30); held clock after a reply; start taken from latest activity; no cursor; answered call counted as waiting; failure handling | 10/10 (+1 undelivered-text test); 2 round-2 Quo tests ported |
| webhook | 14 tests, 10 pass (vacuously), **4 fail**: 3 valid Standard Webhooks deliveries → 401; legacy header → 200 | 14/14 |

- **Totals:** 85 tests, 85 pass, 0 fail. `npm run check` and `npm run build` are clean.
- **Deliberate breaks, run in scratch copies (the repo was never modified):** 60 caught, by
  item:
  - auth: 15
  - contact: 9
  - blocked: 7
  - isolation: 4
  - Quo: 11
  - webhook: 14
- **Corrections along the way:**
  - One contact break was a no-op and was redone.
  - One contact break wasn't reachable through the route; it's now pinned by a pure unit test.
  - One webhook break was aimed at the wrong test. The valid-signature tests caught it, and a
    body-binding break correctly aimed was caught too.
  - The race test's SQL-text match was loosened after it silently stopped intercepting.
- **Harness mistakes caught before they counted:**
  - `undefined` claim defaults meant the tokens still carried `exp` and email.
  - A fractional expected timestamp could never match.
  - The Quo failure test processed the failing conversation last, so it didn't test isolation.
    It was reordered.
- **UI:** checked in the browser with no console errors. "blocked 6d" and "blocked 17h" render
  below the waiting rows.

### Research (Quo docs)
- The dated API 2026-03-30 lists only users and webhooks today. Conversations and messages are
  "in development", and v1 "remains fully supported".
- v1 `/messages` requires `phoneNumberId` and `participants`. `/calls` takes one participant.
  `/conversations` returns newest activity first.
- The 2026-03-30 webhooks use Standard Webhooks, and the changelog calls that API open beta.
- Details and what remains unproven are in HANDOFF.

### Still unproven
- A real Quo webhook delivery (either scheme).
- Quo v1 behaviour: array parameter encoding, sort order, rate limit.
- D1 itself.
- Gmail, Quo and OAuth against real accounts.

---

## Round 2 — correctness (2026-09-13, branch `claude/inh-round-2`, cut from `claude/inh-round-1`)

Nothing was deployed, merged, pushed, or PR'd. The repo now lives at
`~/Code/zaragozamarketing.dashboard`. The Desktop-level THI Autoposter CLAUDE.md no longer loads
into sessions here (round-1 open question 4 is moot).

Each bug was fixed test-first: write the test, watch it fail, fix, watch it pass.

### What changed
1. **Prep, `12e7e06`.** Source imports use explicit `.ts` extensions
   (`allowImportingTsExtensions`), so Node can load `src/index.ts` and the ingest modules in
   tests. Added `tests/helpers/d1.mjs`, which runs the real `schema.sql` on `node:sqlite` behind
   the D1 surface the code uses. No behaviour change.
2. **Clock, `2e2c59a`.** `businessMinutes()` hung across the March DST change. It now steps one
   local calendar date at a time; see "Clock approach" below.
3. **Gmail customer, `37a8523`.** The customer came from the newest message's From, which could
   be our reply or a cc'd colleague. It now comes from the first inbound message and is refreshed
   on every sync. Direction now uses Gmail's `SENT` label or an exact address match, replacing a
   substring match that treated send-as alias replies as inbound. Threads with no inbound message
   are skipped.
4. **`awaiting_since` and reopen, `8957487`.**
   - Added `thread.awaiting_since`.
   - The state rules live in `src/lib/thread-state.ts`. All three ingest paths now write through
     `src/db/threads.ts:syncThread`, whose UPDATE is conditional on the row it read.
   - Added `rescueThread` and `POST /api/threads/:id/rescue`.
   - Board, queue and UI ages now use `awaiting_since`. Closing via actions nulls it.
   - Updated the `schema.sql` index and comments.
5. **Quo webhook, `642c7b4`.** `/hooks/quo` verifies the `openphone-signature` HMAC as described
   in Quo's docs (support.quo.com/core-concepts/integrations/webhooks), with a 5-minute replay
   window. It returns 401 otherwise, and fails closed without `QUO_WEBHOOK_SECRET`. The new
   secret name is added to `wrangler.toml` comments.
6. **Docs.** CLAUDE.md invariants rewritten (now 9), plus this entry and HANDOFF.

### Clock approach
- **The old loop's cursor was an instant.** It stepped `dayStart + 26h`, then snapped back by the
  wall-clock minute of day. On 2027-03-14, 02:00 local doesn't exist, so from Sat 00:00 CST the
  overshoot lands Sun 03:00 CDT. The snap-back subtracts 3 real hours and lands on Sat 23:00, so
  the cursor never leaves Saturday.
- **The new cursor is a local calendar date,** advanced with `Date.UTC(y, m-1, d+1)`. That is
  pure calendar arithmetic, with no time zone and no DST, so each iteration is exactly one local
  day however many seconds it holds. There is no loop counter or cap: termination follows from
  the date strictly increasing until its local midnight reaches `to`.
- **Instants are resolved per day.** A two-pass offset lookup turns that day's 00:00, 08:00 and
  17:00 wall times into instants. Those times always exist in Chicago, whose changes happen at
  02:00. The weekday comes from the calendar date, not the zone.
- **Minor fixes in the same change:** `hourCycle: 'h23'` replaces `hour12: false`, and seconds
  are carried.

### What was proved (failing first, then passing)

| Bug | Before fix | After fix |
|---|---|---|
| 1 clock | 7 tests: 5 pass, **2 fail**. March crossing and the 21-week span both hit `did not return within 3000ms`; November passed. | 7/7 |
| 2 customer | 4 tests: **0 pass, 4 fail**. Stored `'InHouse Support'`, `support@inhousewellness.com`, `'Sam Ortiz'` (cc'd colleague), `julian@inhousewellness.com` (alias). | 4/4 |
| 3 awaiting/reopen/rescue | 11: **0 pass, 11 fail**. 10 on assertions (`awaiting_since` undefined; closed stayed `'closed'`); `rescue.test.mjs` failed to load, since `src/db/threads.ts` didn't exist. | 16/16, with reopen-hold and mid-sync race tests added |
| 4 webhook | 9 tests: 2 pass (valid signatures), **7 fail** with `200 !== 401` | 9/9 |

- **Totals:** 40 tests, 40 pass, 0 fail. `npm run check` and `npm run build` are clean.
- **Deliberate breaks, run in scratch copies (the repo was never modified):**
  - Bug 3: 13 breaks, all caught by their target test. Among them: rescue moving either
    timestamp, `responseMinutes` falling back to `first_inbound_at`, no reopen, a closed-at-style
    cutoff, reopen over the whole thread, no hold, unprotected blocked, newest-unanswered, UPDATE
    moving `first_inbound_at`, unconditional UPDATE, reopen unlogged, and always-reopen.
    Controls passed 31/31, then 40/40.
  - Bug 4: 8 breaks, all caught (replay window, compact form, raw key bytes, timestamp binding,
    always-true, fail-open).
  - One timestamp break was initially a no-op on my side. It was redone correctly and was caught.
- **Clock oracle:** 320 random spans around both DST changes, year-end and midsummer, compared
  against a brute-force 10-minute `isOpen` count. 0 mismatches.
- **UI:** `public/index.html` rendered with no console errors. Ages come from `awaiting_since`,
  and threads not awaiting us show "—" and sort last.

### Still unproven
- The Quo signature against a real delivery. The docs' Node and Python samples disagree on key
  encoding; see HANDOFF.
- D1 itself: tests run on `node:sqlite`.
- The HTTP routes behind Access (actions close → `awaiting_since` NULL, `/rescue`). There's no
  JWT test harness yet.
- Everything that needs credentials (Gmail, Quo, OAuth), as in round 1.

---

## Round 1 — foundations (2026-09-13, branch `claude/inh-round-1`)

Nothing was deployed, merged, pushed, or PR'd.

### What changed
- `2edebbc`: baseline commit of `inhouse-ops.zip`, exactly as delivered (15 files). Everything
  below is diffable against it.
- `.gitignore`: added `.DS_Store` and `dist/`. It already covered `node_modules/`, `.dev.vars`,
  `.env` and `.wrangler/`.
- `package.json`:
  - Added the `build`, `check`, `test`, `prove:triage` and `prove:oauth` scripts.
  - Dev dependencies are now installed, with `package-lock.json` committed.
  - Version change: the baseline pinned `@cloudflare/workers-types@^4.20260801.0`, which doesn't
    exist on npm, so `npm install` failed. The package moved to major 5, and
    `wrangler@4.131.1` declares `@cloudflare/workers-types@^5.20260911.1` as a peer. Installed
    `@cloudflare/workers-types@^5.20260911.1` and `wrangler@^4.131.1`.
  - TypeScript stays on the baseline's 5.x line (`^5.9.3`). npm `latest` is 7.0.2; not adopted.
- `tsconfig.json`: strict, `noEmit`, Bundler resolution, `types: ["@cloudflare/workers-types"]`,
  covering `src/**/*.ts`.
- `tests/triage.test.mjs` (5 cases) and `tests/clock.test.mjs` (5 cases): the owner's
  hand-verified cases, run with `node:test` and no extra dependency.
- `prove/oauth-bootstrap.mjs`:
  - Desktop-app OAuth flow on a loopback listener, with PKCE and `state`.
  - Scope is gmail.readonly only, and the script refuses a broader grant.
  - Confirms the mailbox through the Gmail profile, then prints the refresh token once.
  - **Not run**, because no credentials exist yet.
- `CLAUDE.md`, `RUNLOG.md`, `HANDOFF.md`: new.
- No application code in `src/`, `public/` or `schema.sql` was changed.

### What was proved
- **Extraction:** all 15 zip entries were present at their zip paths.
- **`npm run check`:** clean. It reports 0 type errors in `src/` under `strict`.
  - I confirmed the check is real: `--listFilesOnly` shows all 6 `src` files, the Workers types
    resolve, and a deliberately wrong probe file fails with TS2322.
  - Caveat: `src/ingest/*.ts` types every Gmail and Quo payload as `any`, so those paths are not
    meaningfully typechecked.
- **`npm run build`:** clean. The `wrangler deploy --dry-run` bundle is ~12.5 KiB, and wrangler
  lists the DB, ASSETS and three var bindings.
- **`npm test`:** 10 passed, 0 failed.
- **Every test bites.** 11 mutations were run, each against a scratch copy of `src/`+`tests/`
  (the repo was never modified). Every mutation failed its target test, and the unmodified
  control copy passed 10/10.

  | Mutation | Target test |
  |---|---|
  | demote threshold `>= 2` → `>= 0` | plain customer email → not demoted |
  | no-reply regex never matches | noreply@shopify.com + Updates → demoted on noreply |
  | Updates given a weight-2 signal | noreply@shopify.com + Updates → demoted on noreply, **not** on Updates |
  | demote threshold `>= 2` → `>= 5` | newsletter List-Unsubscribe + Promotions → demoted |
  | everRepliedTo exemption removed | everRepliedTo sender → not demoted |
  | Updates given a weight-2 signal | Updates alone → not demoted |
  | open 08:00 → 10:00 | Tue 09:00→11:30 = 150 |
  | Sat+Sun counted as workdays | Fri 16:50→Mon 08:10 = 20 |
  | Saturday counted as workday | Sat 10:00→15:00 = 0 |
  | close 17:00 → 18:00 | Tue 16:00→Wed 09:00 = 120 |
  | `Etc/GMT+5` fixed offset instead of `America/Chicago` | November DST span = 120 (the **only** test that catches it) |

### Found, not fixed (out of scope this round; see HANDOFF)
- `businessMinutes()` never returns for a span that crosses the March DST change. I reproduced
  this: the process was still running after 8s.

### Still unproven
- Gmail, Quo, and OAuth against real accounts. No credentials exist yet, and none of the
  `prove/` scripts has been run.
- The ingest upserts, including the blocked/closed guard, have never run against D1.
- Access JWT verification has never seen a real token.
- `wrangler dev` wasn't tried. npm 11's `allowScripts` skipped the `esbuild` and `workerd`
  postinstall scripts. `build` works without them; `dev` is untested.
- The UI has only rendered mock data, and wasn't opened this round.
