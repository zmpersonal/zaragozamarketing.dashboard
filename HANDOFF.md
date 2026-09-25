# HANDOFF

This file holds open questions and known-wrong things carried forward. Remove an item only once
it's fixed and proven, or once the owner decides it.

Last updated: round 6, 2026-09-13.

---

## Lessons carried forward

### DST tests must cover both transitions: they fail differently
In round 1 the November test passed while any span crossing the **March** change hung.
`tests/clock.test.mjs` covers both, with a deadline per case.

### A test that passes on the old code proves nothing until a break makes it fail
Round 3 and round 4 both had tests that passed vacuously: a column that didn't exist yet, an
old verifier that rejected everything, or a rule with no reachable counterexample. Each needed
a deliberate break to prove it.

Harness mistakes also made tests fail for the wrong reason:
- claim defaults swallowed `undefined`
- a fractional timestamp could never match
- a race test matched SQL by exact text
- a chase message was dated before the action it was meant to follow
- a mutant key was hidden behind comment markers

**Read the failing output, not just the count.**

### Run the gate after staging, not before
Round 4's `87a018a` was checked while `tests/helpers/google-sa.mjs` was still untracked. The
secret-hygiene test only reads tracked files, so it passed. The committed tree failed it. This
was fixed in `c8769bc`.

### A fake API is only as good as its fidelity to the real one
The fake Gmail returned every header regardless of `metadataHeaders`, so `prove/triage.mjs`'s
comma-joined header request passed its tests and failed on real mail. Verify fake behaviour
against the real API, cheaply and printing no content, as soon as credentials exist.

---

## Why the spam tier exists (owner decision, round 6)

Round 5 showed Gmail's `SPAM` label driving 126 of 245 demotions on its own. Treating Gmail's
spam judgment as interchangeable with "this is bulk mail" was a design error, now corrected.

**The evidence.** Four spam-labelled messages had subjects that read like genuine customer
inquiries:
- "Track A Shipment – Priority1 for [customer name]" from a personal address
- "Refund Request – Order #467740987"
- "Problem With My Recent Order"
- "Hi please is this Inhousewellness"

The owner checked all four by hand. **One was a real customer** (the shipment message, which
Gmail misfiled) and **three were phishing.**

**What that proves:**
- The three fakes were indistinguishable from the real one by subject alone.
- The only tell was that they named no order number and no specific product.
- **No rule can separate those from a terse real customer**, who might also name neither.

**What follows:** the spam section must stay visible and scannable by a human, with sender and
subject readable at a glance, no click to reveal, and the subject never cut below 50
characters. That's why the tier is not optional, and why it must never be folded back into
bulk or hidden.

The real customer is now exempt (a `sender_rule` row seeded from outside the repo), and our own reply history beats
Gmail's spam judgment in general.

---

## Accepted gaps (owner decision)

### No per-thread authorization (round 2)
Any signed-in agent can act on or read any thread, and complete any to-do. Revisit before a
second agent or brand team is added.

---

## Decisions made that the owner should confirm

1. **An answered incoming Quo call counts as inbound followed by contact.** It never shows as
   waiting. A missed call is waiting. An outgoing call counts as contact only if answered. An
   undelivered text isn't contact.
2. **Quo polling reads 30 days back on a source's first poll.**
3. **A chased blocked thread becomes `answered`, not `waiting`, if we already replied** between
   its new inbound and the sync. It still leaves the blocked group.
4. **Closing without contact is recorded in `response` with `via = 'closed'`.** It's a
   measurement the report should exclude from "response time". The alternative is not recording
   it at all.
5. **Chat threads a bot handled record 0-minute responses** (`via = 'message'`). The report
   should filter by `thread.is_automated`.
6. **Poison-pill limit is 3 consecutive failures.** After a skip, that conversation's missed
   messages are not re-read unless it gets new activity. Recovery is manual, starting from
   `ingest_failure`.
7. **A service-account key with no matching mailbox delegation fails per mailbox.** The token
   exchange returns `unauthorized_client`, which is logged and skips that mailbox. Other
   mailboxes still sync.
8. **Items 1 and 8 conflicted, and I resolved it this way (round 6).** Item 1 said "spam
   collapsed at the bottom with a count"; item 8 said "no click to see the list". Spam renders
   as a compact section at the bottom with a count, always expanded, one plain line per
   message.
9. **Agent-marked spam senders (`sender_rule` verdict `spam`) are tier `spam`,** not `bulk`.
10. **Thread triage comes from the thread's first inbound message.**
    - A later message in the same thread doesn't re-tier it, even if Gmail labels it
      differently.
    - Replying in a thread exempts its sender, and that's recorded in `known_sender`.
11. **The board and subtitle counts still include bulk and spam threads.** "N open across all
    brands" and the per-brand cells count every open thread, whatever its tier. Should they
    count Needs reply only?
12. **Resolved in round 7:** header and per-brand counts are Needs reply only.
13. **Resolved in round 7:** verified customers are `sender_rule` rows from a seed kept outside
    the repo; the address was removed from code, tests and this branch's history.
14. **A Needs-reply thread marked `answered` without contact stays `waiting`** (round 7). With
    incremental ingest nothing re-syncs an unchanged thread, so `POST /api/actions` keeps a
    non-contact `answered` on a thread still awaiting a reply as `waiting` at once.
15. **Gmail and Quo run on separate cron triggers** (`*/5` and `2-59/5`), each with its own
    subrequest budget.
16. **The known-sender backfill includes our own colleagues.** 8 of the 723 addresses are
    `@inhousewellness.com` (the mailbox itself is excluded). Harmless: they are exempt from
    demotion, which they would be anyway once replied to. Filter them out?


---

## Real-data findings: `prove/triage.mjs` on support@, 30 days (round 6, three tiers)

**Result:** `TOTAL: 284 messages, 40 customer, 58 bulk, 186 spam`.
- **Query:** `in:anywhere newer_than:30d -in:sent -in:drafts -in:chats` with
  `includeSpamTrash=true`, paged.
- **Customer, 40:** 20 are customer only because we've replied to the sender, and 1 because of
  the verified-customer list (one address, now a `sender_rule` seed outside the repo).
- **Spam, 186:** 67 also carry bulk signals, and 119 are spam on Gmail's label alone.
- **It reconciles with round 5,** which had 187 Gmail-spam messages and 58 bulk on our rules
  alone. The verified customer moved from spam to customer (39 kept → 40 customer).
- Round-4 findings stay withdrawn. The round-5 observations below still stand, except
  the misfiled verified customer, which is resolved.

Rules were not changed except items 1, 3 and 6 of round 6. These are observations only.

### Still open from rounds 5 and 6
- **Probable phishing in spam:** "Refund Request – Order #467740987", "Problem With My Recent
  Order" and "Hi please is this Inhousewellness" are all correctly `spam`. The owner verified
  them as phishing.
- **Account and operations mail for a human is `bulk`:**
  - Google "Critical security alert" ×2
  - Workspace "Possible unresolved security risks" and its invoice
  - Merchant Center "New product image requirements"
  - "Responsible Disclosure of a Subdomain Takeover" is `spam`
- **Supplier finance and logistics are `bulk`:** Bathing Brands "ACH Payment Returned", invoices
  ×3, account notices ×3, and shipping notices ×3.
- **About 21 of the 40 customer messages are supplier marketing or cold outreach:**
  - Golden Designs ×5, Bathing Brands promotions ×5 (exempt), Wizzisaunas ×2, Dream-Pod
  - cold outreach from 8 individual senders (addresses not recorded here)
  - a Shopify-app designer ×2 (exempt), and Boomerang
- **Population:** 284 is below the owner's 300–600 estimate. Not investigated.
- **Output format:** a subject containing `" | "` makes its line ambiguous. Reason codes are the
  last field.

---



## Unproven — needs a real system

### Gmail service account
**Proven (round 4):** the key at `~/Code/secrets/…` mints a token impersonating
support@inhousewellness.com with `gmail.readonly`, and messages list and read. So domain-wide
delegation works for that mailbox.

Not yet done:
- The Worker path (`GOOGLE_SERVICE_ACCOUNT_JSON` secret) hasn't run on Cloudflare.
- The Workers constraint: a deployed Worker can't read `~/Code/secrets/…`, because Workers have
  no filesystem. The key's JSON must be set as a secret by a human:
  `npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON < key.json`.
- **The key file is mode 644** (world-readable on this Mac). Suggest `chmod 600`. Not changed.
- Delegation for other mailboxes (caliza, reachjulian) is untested; they're in other domains.

### Quo webhook signature scheme (unproven until we have a real key)
Implemented as Standard Webhooks, per Quo's versioned docs for API 2026-03-30: `webhook-id`,
`webhook-timestamp` (seconds), `v1,` signatures, HMAC-SHA256 over `id.ts.body` with the
base64 of the `whsec_` secret as the key, and a 5-minute window. It fails closed.
- **The legacy scheme is rejected.** The `openphone-signature` samples on `support.quo.com`
  disagree on key handling: Python uses the raw decoded bytes, while Node's
  `toString('binary')` → `createHmac` re-encodes the key as UTF-8. That scheme gets a 401.
- **No real delivery has been verified.** The changelog calls this webhook API "open beta".
  Dashboard or v1 webhooks may send the legacy header and be rejected. Create the subscription
  via `POST /webhooks` with `Quo-Api-Version: 2026-03-30`.
- **The webhook doesn't ingest or deduplicate by `webhook-id`.**

### Quo v1 polling
Unverified against the real API:
- **Array parameter encoding** (repeated keys). This bug class bit Gmail this round (the
  metadataHeaders encoding), so check it first.
- **Sort order.** It's unconfirmed whether `lastActivityAt` moves for calls.
- **`createdAfter` boundary.**
- **Rate limit,** against 10 requests per second.
- **Group conversations have no call history.**
- **The dated API doesn't list messages yet.**

### Full-stream Gmail ingest (round 6)
- **`threads.get` on a spam-filed thread** returns its messages with the SPAM label: verified on
  support@, counts only.
- **Trash is unverified:** Trash on support@ is empty (round 7: `in:trash` and
  `labelIds=TRASH` both return 0). `prove/ingest-live.mjs` is ready to show a hand-trashed
  message being picked up.
- **Volume per cron run (round 7: incremental).** Measured live on support@ with
  `prove/ingest-live.mjs`: 262 threads in the 30-day window took 11 bounded runs to backfill;
  the heaviest run used 28 fetches and 87 D1 statements.
  - Worst case per mailbox per run: fetches ≤ 4 + 25 = 29; D1 ≤ 3 + 25 × (7 + replies in the
    thread). Plus 1 D1 query for the source list per invocation.
  - **Superseded in round 9:** ingest no longer runs on the Worker, so the Workers subrequest
    ceiling and the Workers Paid requirement (round 8) no longer apply. See "Ingest on GitHub
    Actions (round 9)" below for the caps and the minutes math.
- **Exemption parity (round 7).** `prove/backfill-known-senders.mjs` read all 2,192 sent
  messages on support@ (back to 2024-11-22) and produced 723 `known_sender` rows, in
  `~/Code/secrets/inhouse-ops-known-senders.sql`.
  - Round 8: `prove/apply-known-senders.mjs` filters out our own domain (8 of 723) and wrote
    715 rows to `…known-senders.filtered.sql`. Applied to the local live-ingest database only
    (724 → 716 rows, 0 own-domain; a second apply changed nothing). Production D1 is a human
    step at deploy.
- **No-reply separator edge:** names ending in "no" + separator + "reply" (`bruno_reply@`,
  `arno.reply.smith@`) now match `NOREPLY`. None appeared in the real stream.

### Trash on real mail (round 8): not verified
- The owner reported moving a junk message to Trash on support@; support@'s Trash was empty on the
  re-run, and history showed 5 permanent deletions (4 were Gmail's 30-day spam purge). Still needs
  the owner to check and re-run.

### Deleted mail (round 8 finding, handled round 10)
Round 10: incremental sync asks for `messageDeleted`, and a deleted thread becomes `deleted` (see
CLAUDE.md invariant 4). **Not covered:** a deletion that happens while Gmail no longer has the
history (the expired-`historyId` fallback lists the window, which can't show what's gone).

### No agent table exists (round 8)
There is no `agent` table. Anyone the Cloudflare Access policy lets in is an agent, and
`OWNERS` (a Worker var) decides who is an owner. So the Access policy is the only user list:
adding or removing a person is an Access change, and there's no list for an assignee picker or
per-agent reporting. Enough to log in; an owner decision whether V1 needs more.

### Other
- **D1 itself.** All SQL has run only on `node:sqlite`.
- **`wrangler dev`.**

---

## Known wrong — correctness

### 0. FIXED round 9: `/api/queue` dropped Needs-reply threads once bulk and spam piled up
The queue query returns every waiting or blocked thread of every tier, oldest first, `LIMIT 200`.
On the local live database (support@, 30 days) it returned **37 of 45** Needs-reply threads.
134 spam and 29 bulk threads sorted ahead of them, so the 8 newest customers were cut off.
Spam and bulk threads are never closed, so this gets worse every week. It also breaks
invariant 5: a thread the UI never receives is hidden. **Round 9:** each tier is its own query
with its own limit (customer 500, bulk 200, spam 200), and the response and UI report "N of M" when
a tier is cut. `tests/queue-tiers.test.mjs` checks that no statement serving `/api/queue` returns
rows from more than one tier, so raising a limit can't make it pass.

### 1. There's no admin report view
`response` holds every measurement, but nothing reads it yet.

### 2. The UI still measures age in wall-clock hours
This includes "blocked 6d", and breaks invariant 6 for response ages. The UI also doesn't show
`ingest_failures`, which only `GET /api/board` returns.

### 3. Triage is wired in, but the UI can't correct it yet
Ingest classifies every Gmail thread (round 6), but there's no rescue or "not spam" button in
the UI, and no sender-rule writes. Quo and chat threads are always `customer`.

### 4. The Shopify relay hides the customer
`mailer@shopify.com` would be stored as the customer handle (see real-data findings).

### 5. FIXED round 10: `POST /api/actions` didn't validate `status` or `kind`
An unknown `thread_id` returned 500. Now 400 for unknown values and 404 for unknown threads.

### 6. FIXED round 10: the UI rendered `action.kind` unescaped

### 7. Non-atomic writes (round 10: measurements made safe)
The response insert and the thread update are separate writes; round 10 orders them so a kill
at any point is recovered on the next sync (CLAUDE.md invariant 4). **Still possible:** the
reopened / unblocked / deleted action log row is written after the state change, so a kill in
between loses that log line (not a measurement).

### 8. The history purge covers only `claude/inh-round-7`
Round 7 rewrote this branch's history to remove a customer address and customer usernames.
`claude/inh-round-5` and `claude/inh-round-6` still contain them, and old objects stay in the
local object store until `git gc --prune=now`. Deleting those branches is the owner's call.

**Commit IDs quoted in RUNLOG for rounds 1–6 no longer resolve on this branch.** The rewrite
gave every commit after round 1 a new ID, so hashes like `d8e0ef7` in older RUNLOG entries point
at the pre-rewrite commits, which exist only on `claude/inh-round-5` / `-6` (and not at all once
those are deleted and garbage-collected). Owner decision: **do not rewrite history again to fix
them.** Find a round's commits by subject with `git log --oneline --grep`.

### 9. `prove/ingest-live.mjs` imports the D1 shim from `tests/helpers`
Deliberate (it runs production SQL on node:sqlite), but it couples a prove script to test
helpers.

---

## Known wrong — security and hardening

1. **`authenticate()` gaps.** No caching of the Access certs, and no `iss` or `nbf` check.
2. **Possible CSRF, to be checked.** `req.json()` ignores `Content-Type`. SameSite on
   `CF_Authorization` decides whether a cross-site POST gets through.
3. **`GET /api/threads/:id` doesn't URL-decode the id.**

## Ingest on GitHub Actions (round 9)

**What moved.** Ingest runs hourly on GitHub Actions and writes to D1 over the REST API. The
console Worker keeps the UI and the API; the webhook moved to its own Worker in round 11. Owner
decision at the time: stay on Workers Free. Superseded in round 12 — Workers Paid is bought, and
ingest stays on Actions as a choice; see "Ingest stays on GitHub Actions (round 12 decision)".

**The trade, recorded:**
- Email reaches the queue roughly hourly instead of within five minutes.
- GitHub can delay scheduled runs 15–60 minutes under load.
- **Phone is real-time since round 10**: the Quo webhook on the Worker writes threads. Polling
  is the backstop.

**Caps and why (round 9):**
- Gmail: 150 threads, 500-message backfill pages, 5 history pages, 600 D1 statements per run.
- Quo: 80 conversations, 5 listing pages, 10 pages per conversation, 400 D1 statements per run.
- 600 + 400 = 1,000 statements, under Cloudflare's API limit of 1,200 requests per 5 minutes per
  token. Past that limit *every* call is blocked for 5 minutes, including a human's wrangler.
- Each run also has a wall-clock deadline: Gmail starts no new work after 45 s, Quo after 80 s.
  In practice the deadline binds before the counts. The counts stop a bug running away.
- Expected throughput per run is an estimate, not measured: roughly 1 s per Gmail thread (one
  Gmail call plus ~5 D1 REST calls at an assumed 100–200 ms each) and 1.5 s per Quo
  conversation. That's ~45 threads and ~25 conversations per run, so a 260-thread email backlog
  clears in about 6 hourly runs. The first real runs' summary lines (`d1 requests`, `elapsed`)
  will give the real figures.

**Actions minutes (GitHub Free: 2,000/month for a private repo; jobs bill rounded up to the minute):**
- 24 × 365 / 12 ≈ 730 runs a month.
- **Expected:** a steady-state run (a few changed threads, runner setup ~15 s) takes well under a
  minute and bills 1 minute: ~730 minutes a month. Backfill runs bill 2 minutes each for the first
  several hours: +~10 minutes once. **~740 minutes, 37% of the allowance.**
- **Worst case, bounded:** the job timeout is 2 minutes, so even if every run hit it the month
  would bill 1,460 minutes (73%). One job only; a second job would add a billed minute per run.

**Keepalive (round 10: API, no commits).** GitHub disables scheduled workflows after 60 days of
repository inactivity, silently. GitHub documents this for public repos and doesn't define
"activity"; it's reported on private repos too.
- **Round 9 pushed an empty commit to the default branch after 45 quiet days. That broke the
  never-push-to-main rule through our own machinery, and round 10 removed it.** The workflow now
  never commits or pushes anywhere, and a test fails if `git commit`, `git push` or
  `contents: write` appears in it.
- **Approach used:** every scheduled run first calls
  `PUT /repos/{owner}/{repo}/actions/workflows/ingest.yml/enable` with the workflow's own token
  (`actions: write`; the only other permission is `contents: read`).
  - Re-enabling restarts the inactivity clock, so a workflow re-enabled every hour never reaches
    60 days.
  - This is how liskin/gh-workflow-keepalive works, and the default mode of keepalive-workflow v2,
    which replaced its own dummy commits with it.
- **Why not a keepalive branch:** there's no evidence that a push to a non-default branch counts
  as activity, and it would still be the workflow writing to the repo.
- **Unproven, and can't be proven quickly:** GitHub doesn't document that the enable call resets
  the clock. The evidence is those widely used actions. If a failed call happens, it shows as a
  `::warning title=keepalive::` on the run.
- **If the schedule ever does stop,** runs simply stop appearing. The dashboard doesn't yet warn
  when ingest is stale. A "last synced N hours ago" warning would make a silent stop visible;
  not built.

**Unverified until the first real run:**
- **D1 REST parameter types.** The published API schema lists `params` as strings. If the API
  coerced numbers or null to text, conditional writes (`status = ?11`, `awaiting_since IS ?12`)
  would stop matching. `D1HttpClient.selfCheck()` runs first on every run and fails it red if
  types don't round-trip.
- **Whether a REST `batch` is one transaction (round 10: unsettled, but no longer load-bearing).**
  - **Docs:** Cloudflare documents the Worker binding's `batch()` as a transaction ("it aborts or
    rolls back the entire sequence"). The REST `/query` reference only says multiple statements
    "will be executed as a batch", and says nothing about transactions, atomicity or rollback.
  - **Not proven against the real database.** The D1 token is only in GitHub Actions secrets, and
    `wrangler d1 … --remote` is a human step (CLAUDE.md invariant 1).
  - **To settle it:** run `prove/d1-batch-atomicity.mjs` with `CLOUDFLARE_API_TOKEN`,
    `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_D1_DATABASE_ID`. It creates a scratch table, sends a
    batch whose second insert violates NOT NULL, prints ATOMIC or NOT ATOMIC, and drops the table.
  - **Either answer is safe:** thread writes are ordered so that a partial batch, or a kill between
    any two writes, is recovered on the next sync (CLAUDE.md invariant 4).
- **Writes are not retried on 5xx or network errors**, since they may have been applied. The run
  fails that source and the next run re-syncs from the unchanged cursor. A write that did apply
  can leave one duplicate `action` log row (reopened / unblocked); thread and response writes are
  conditional or idempotent.
- **Worker CPU: measured locally in rounds 10–11.** Over Workers Free's 10 ms; comfortably inside
  Workers Paid's 30 s, which is what the account is on since round 12. See "Worker CPU".
- **Scheduled workflows run only from the default branch.** `main` has no commits yet, so nothing
  runs on a schedule until this branch is merged.

## Worker CPU (rounds 10–11)

**Round 10: over the limit.** The single queue call used ~30 ms of CPU per request locally against
Workers Free's 10 ms.

**Round 11: close to it, not comfortably under.**
- **Setup:** same database (4,365 fabricated threads, rebuilt from the same seed), same method:
  workerd via `wrangler dev`, V8 sampling profiler at 1 ms, 150 requests per route, local tracing off.
- **Changes:** the queue is paged at 50 per tier, totals come from one grouped `COUNT(*)`, list rows
  carry 15 columns instead of 19, and the UI loads each tier separately. CPU per request (trimmed
  mean / median):

| Route | Response | Round 10 | Round 11 |
|---|---|---|---|
| `GET /api/queue` (all tiers, one call) | 59 kB (was 296) | 29–30 ms | **17 / 19 ms: still over** |
| `GET /api/queue?tier=spam` (what the UI loads) | 22 kB | — | 8.6 / 9.3 ms |
| `GET /api/queue?tier=customer` | 12 kB | — | 6.6 / 7.4 ms |
| `GET /api/board` (now 3 statements) | 1 kB | 5 ms | 6.4 / 8.9 ms |
| `GET /api/todos` (now 2 statements) | 19 kB | 6 ms | 5.6 / 7.0 ms |
| baseline 401, no work | | 0.2 ms | 0.2 ms |

p90s for the UI's requests are 14–24 ms, so bursts over 10 ms are routine locally.

**What costs the time** (profile breakdown of the one-call queue; the D1 binding's source is
embedded in workerd):
- **~6.7 ms:** the binding's `toArrayOfObjects`, which turns each result row into an object with
  `Object.fromEntries`: one object and one small array per cell.
- **A fixed per-call cost:** the fetcher round trip, tracing spans (`setAttributes`, `enterSpan`),
  `text()` plus `JSON.parse`. The 3-statement board costs ~6 ms with almost no rows.
- **~1.5 ms** our own JSON response, ~0.8 ms garbage collection, and ~0.5–1.8 ms verifying the
  Access JWT.

**Variants measured and not shipped:**
- 50 rows per tier with full columns: ~23 ms.
- Slim columns in one call: ~15–17 ms.
- All four statements in a single `batch()`: ~12–15 ms. Not shipped, because the round-9 separation
  test records rows per statement, and a batch hides them.

**Caveats:** a local machine, not the edge; 1 ms sampling; the production D1 path may differ.
Measure on Cloudflare (Workers Observability) after deploy, RUNBOOK §7.

**Settled in round 12: Workers Paid is bought.** The ceiling is 30 s of CPU per invocation, so
none of these numbers is a failure risk any more and error 1102 is not expected. They stay here as
cost information, and because the work that produced them (paging, slim rows, one grouped count)
is worth keeping: it took the queue from 296 kB and ~30 ms to 12–22 kB and 6.6–8.6 ms. If
Cloudflare ever does show a 1102, the next move is fewer rows per page and fewer statements.

## Round 11 UI run: what broke

The UI ran for the first time against the real API: `wrangler dev` with a local D1, fabricated data
at ~1 year's volume, an Access test key, and a minted owner cookie. Every path was exercised in the
browser:
- all three tiers
- paging
- counts against the matrix
- logging a reply (the thread left Needs reply; counts and matrix dropped by one)
- blocking
- filters, My queue, opening a spam row
- adding and completing a to-do
- stale, fresh and failed states

**Five bugs, all fixed test-first in round 11:**
1. **The matrix said "clear"** in every cell with the API returning 401, with email 13 hours stale,
   for chat (no source at all), and for THI's email (InHouse's mailbox was the fresh one). The to-do
   panel said "Nothing on the list" when to-dos had failed to load.
2. **The 60-second refresh reloaded every tier from page one,** collapsing "Show 50 more".
3. **"Blocked on" was always visible:** `label.field { display: block }` overrode `[hidden]`.
4. **`/api/todos` returned at most 100 rows with no total:** the 101st open to-do, the one just
   added, never appeared. The round-8 queue bug again, in the to-do list.
5. **The error banner called `emptyQueueHtml` without its escaper,** so the first API failure would
   have thrown instead of showing the error.

**Seen and left as they are:**
- With a client-side filter on (brand, Unassigned, Blocked, Over 24h), a section counts only the
  loaded rows, e.g. "(50)", and offers no next page.
- After an API failure, the last-loaded rows stay on screen under the red banner.
- `headerCounts` and `brandCell` in `public/queue-sections.mjs` are still tested but no longer used
  by the UI, which reads totals from the API.
- The benchmark and UI-run harness (dev entry, seed generator, profiler) lives in the scratchpad,
  not the repo.

## The webhook is a separate Worker (round 11 decision)

Found while writing the runbook. Cloudflare Access at Worker level "automatically protects every
domain associated with the Worker", and its bypass is whole-Worker only; per-path exemptions need a
zone and hostname-based Access. Quo can't sign in, so `/hooks/quo` on the console Worker would have
been blocked the moment Access was turned on, and phone would have silently gone back to hourly.

So the webhook runs as `inhouse-ops-hooks` (`src/hooks.ts`, `wrangler.hooks.toml`): no UI, no API,
same database, signature-only. Preview URLs are off on both Workers. The alternative is a zone with
hostname-based Access and a path Bypass, which the owner ruled out — and round 13 established that
this Cloudflare account has no zone at all.

## Ingest stays on GitHub Actions (round 12 decision)

Workers Paid is bought, so the two limits that pushed ingest off the Worker in round 9 are gone:
1,000 subrequests instead of 50, and 30 s of CPU per invocation (15 minutes on a cron trigger)
instead of 10 ms. A Worker cron is viable again, and it would be better in three ways: email every
five minutes instead of hourly, no 15–60 minute scheduler delays, and no keepalive — the
workflow's API call that re-enables itself every 60 days is the one piece of this system nobody
can verify until the day it doesn't work.

**It stays on Actions anyway, for now.** The Actions path is hardened: bounded runs with a
deadline, a redactor over everything it prints, per-item isolation, poison-pill skipping, partial-
write recovery, and tests for all of it. Moving it is a rewrite of the path that touches customer
mail, and the reason to move is comfort, not a failure. The failure it would remove — a silently
disabled schedule — is already visible: `source.last_synced_at` drives a badge that turns amber at
3 hours and red at 12 (invariant 11).

**Revisit after two weeks of real operation**, with two questions answered from the console rather
than from a guess: did the freshness badge ever go amber, and how late was the worst hourly run.
If it never slipped, leave it. The rewrite would move `scripts/_ingest-run.mjs` behind a
`scheduled()` handler on the console Worker (or a third Worker), keep `src/db/db.ts` as it is, and
delete the keepalive step along with the Actions secrets.

## Scale and cost — verify before go-live

- **Subrequest limit.** Not applicable to ingest since round 9 (see above).
- **D1 reads and writes.** `syncThread` adds one SELECT per thread per sync, plus a
  response/failure write where relevant.

## Schema changes need migrations once a database exists

Round 4 added the `response` and `ingest_failure` tables while no database exists. After the
first real deploy, use `wrangler d1 migrations`.

---

## Paused work

- **Deleted-mail handling** (round 9, moved to round 10 by the owner): a fake-Gmail deletion helper
  and 6 tests, 5 failing on the current code, are in `git stash` as
  `round10-wip: deleted-mail handling`. No implementation was written.

## Open questions for the owner

1. Confirm the seven decisions above.
2. **Triage findings.** Should the no-reply rule match `…-noreply@` addresses? Should supplier
   domains be handled, both their promotions and their invoice and ACH mail? Should the
   "ever replied to" exemption apply to supplier addresses? No rule was changed.
3. **Mail archived before the inbox.** Is support@ volume really about 1.5 a day, or is mail
   being archived first?
4. **`main` has no commits.** A human needs to decide how `main` gets its first commit.
5. **Brands in scope.** `caliza` and `reachjulian` are seeded but outside V1.
6. **Mock UI login** `agent@inhousewellness.com` looks shared (invariant 8).
7. **`prove/triage.mjs` duplicates the triage rules.** Import `src/lib/triage.ts` instead?
8. **Stage vocabulary** and **weekend confirmation** are still open.
9. ~~**Is a domain on this Cloudflare account?**~~ Answered in round 13: no, and moving a live
   marketing site's nameservers for one WAF rule is the wrong trade. The limit runs inside the
   Worker instead; see "Rate limiting the public webhook" below.

## Unsubscribe: what is actually possible (round 15)

Measured on the live mailbox with `prove/unsubscribe.mjs` (read-only, 30 days, 297 threads):

| | count |
|---|---|
| threads carrying `List-Unsubscribe` | 76 |
| of those, **mailto only** | **0** |
| https only | 49 |
| both | 27 |
| advertising RFC 8058 one-click (`List-Unsubscribe-Post`) | 63 |

**So every thread that has the header has something an agent can click.** The console shows the
link, names the host it goes to, and opens it in a new tab.

**What it does not do, and why.**
- **The mailto cannot be sent from here.** The Google scope is `gmail.readonly`; nothing in this
  system can send as support@. If a sender ever offers only a mailto, the panel says plainly that
  the link opens the agent's own mail client, which sends from their address, not the mailbox.
- **The one-click POST is not made by the Worker**, although 63 of 76 senders would accept it and
  it needs no Gmail scope at all. One-click is designed to be performed by the mail provider on
  the recipient's behalf. Doing it from our Worker would be this console acting as the mailbox
  against a third party, with no way to tell an honest sender from a list checking whether the
  address is live — and an unsubscribe that quietly confirms the address is worse than none. The
  panel says the sender supports it and leaves the choice with the agent.

If that trade is ever revisited, the piece to build is a confirm-then-POST action with the
response code shown to the agent, never a fire-and-forget button.

## The admin report (round 15)

**What it answers:** median first response per channel over a rolling window (30 days by default),
outstanding work bucketed by business age, how many were answered, and the last 7 days of answers
with the agent's own note and a link into the real Gmail thread or Quo conversation.

**Median, not mean.** At ~2 real emails a day one 40-hour outlier moves a mean by hours. The median
is picked inside SQLite with a window function, so a busy month returns two rows per channel
instead of every measurement.

**Business minutes everywhere**, and never per row: `businessTimeBefore` inverts the clock, three
boundary timestamps are computed once, and SQLite counts open threads against them. Running the
day-stepping clock per open thread would have been the expensive mistake here.

**Measured CPU** (workerd under `wrangler dev`, V8 sampling profiler at 1 ms, 250 requests,
tracing off, against 4,365 fabricated threads / 2,910 responses / 1,455 open — the round-11
database plus a year of measurements):

| Route | trimmed mean | median | p90 |
|---|---|---|---|
| `GET /api/report` (30 days) | **11.0 ms** | 9.6 | 20.3 |
| `GET /api/report?days=365` | 15.7 ms | 10.1 | 38.5 |
| `GET /api/board` | 7.5 ms | 8.0 | 15.0 |
| `GET /api/queue?tier=customer` | 6.1 ms | 5.6 | 15.9 |
| `GET /api/queue?tier=customer&channel=email` | 5.1 ms | 5.0 | 18.0 |
| `GET /api/queue` (all tiers) | 13.2 ms | 14.0 | 23.9 |

On Workers Paid the ceiling is 30 s per invocation, so the report is a cost line, not a risk: it is
about the same as the one-call queue, and it is opened by one person a few times a day. The live
database is roughly a tenth of this volume. `/api/board` gained ~1 ms for the two business-time
boundaries it now computes; it is fetched every 60 seconds by every open tab.

**Known limits.** The recent list is capped at 100 rows and has no paging — seven days of answers
has never approached it. The window is whole days, not calendar months.

## Assignment needs a real source before a fourth person (round 15)

`AGENTS` in `wrangler.toml` is a comma-separated list, like `OWNERS`, and the assignment route
accepts nothing else. That is the right size for three people and the wrong size for five:

- **The addresses must match the Access policy exactly.** Assigning to an address that cannot sign
  in hides the thread from that person — it leaves "My queue" for everyone. Julian's is known;
  **Marianne's and Charlie's are assumptions** (`marianne@`, `charlie@` at the same domain) and
  must be checked against the Access policy before deploying.
- Someone who leaves keeps their name on the threads they hold: the picker still shows an assignee
  who is no longer in the list, rather than silently reading as unassigned.
- When there is a fourth person, or people come and go, the list should come from the Access
  group rather than a var. Cloudflare has no API to read a policy's members, so that means either
  an identity provider group or a small table — at which point the table is worth it.

## The phone queue: what Quo actually returns (round 14)

Measured on the live InHouse line with `prove/quo-calls.mjs` (read-only, 14 days, 72 calls, 5
texts). The console had 52 phone threads, every one titled "Call", all unassigned.

**Calls.** Fields: `answeredAt, answeredBy, initiatedBy, direction, status, completedAt, createdAt,
callRoute, duration, forwardedFrom, forwardedTo, aiHandled, id, phoneNumberId, participants,
updatedAt, userId`. No voicemail field, no transcript field.

| | count |
|---|---|
| incoming, `no-answer`, answeredAt null, 0s | 61 |
| incoming, `completed`, **answeredAt null**, 0s | 3 |
| incoming answered | 2 |
| outgoing answered | 6 |
| outgoing unanswered | 0 |

`status = 'completed'` does **not** mean answered. `answeredAt` is the only field that does.

**Voicemail is a second request.** `GET /v1/call-voicemails/{callId}` returns
`{duration, id, transcript, recordingUrl, status}`. 50 of the 64 unanswered incoming calls had one,
**every one with a transcript**; the other 14 answered 404 "Call voicemail not found", which is the
normal answer for a call that rang out, not an error.

**Call transcripts are not available on this plan.** `GET /v1/call-transcripts/{id}` answered 404
on every probe, including 12-minute answered calls; the docs say transcripts are "only available on
business and scale plans". `GET /v1/call-recordings/{id}` answers 200 with an empty array, so there
is no audio stored to transcribe. Voicemail transcripts are unaffected — they come with the
voicemail.

**What those 52 threads were.** 64 conversations with activity in the window: 62 call-only, 1
text-only, 1 both. 58 resolved to `waiting`, 6 to `answered`. So the queue was not mislabelling
answered calls — `answeredAt` was already mapped correctly. The queue was **a robocall campaign**:
50 voicemails from 48 distinct numbers, 46 of them mentioning Google, 46 saying "press 1".

**What the rules catch** (counts over those 50 transcripts):

| rule | matches |
|---|---|
| `google_listing` as shipped (google ↔ listing within a sentence) | 28 |
| literal phrase "google listing" | 28 |
| `google_verification` as shipped (the noun, within a sentence) | 0 |
| loosened to "verify" | 18, all already caught by `google_listing` |
| google + listing anywhere in the transcript | 32 |
| mentions Google at all | 46 |

So the two rules take 28 of 50 voicemails out of Needs reply. **18 more mention Google but not near
"listing"**; widening to "google anywhere in a voicemail" would catch 46 and is the owner's call.

**Known edge.** A customer who says both "Google" and "listing" in one sentence ("I found your
listing on Google…") is demoted to spam. The spam tier is always visible with its reason and can be
rescued, and the rule is not loosened to protect this case because it would lose most of the
campaign. Worth watching in the spam section.

**Voicemail arrives late.** The webhook (`call.missed`) has no voicemail — Quo is still processing
it — and the hooks Worker holds no API key by design. So a thread appears as "Missed call" in
seconds and becomes "Voicemail" on the next hourly poll. That is the one place where phone is not
real-time.

**Existing rows do not fix themselves.** Polling only re-reads conversations with activity since
the cursor, so the 52 threads already in the queue keep their old title until the cursor is reset
once (RUNLOG round 14 has the command). `syncThread` now updates `subject`, which it never did
before, so a re-scan corrects them in place; `conversation_started_at` and `awaiting_since` are
untouched, and response rows are deduplicated, so a re-scan cannot launder a slow reply.

## Rate limiting the public webhook (round 13)

`/hooks/quo` is public and unauthenticated by design, and verifying a delivery means reading the
whole body and running an HMAC over it. On Workers Paid that work is billed rather than capped, so
something has to bound what a stranger can make us do.

**Not the WAF.** Rate-limiting rules are a zone product, and a `workers.dev` hostname is not in a
zone (round 12). The zone route needs a custom domain on a domain this Cloudflare account holds,
and the account holds none.

**The Workers rate-limiting binding instead** (GA September 2025): `[[ratelimits]]` in
`wrangler.hooks.toml`, `env.HOOK_RATE_LIMIT.limit({ key })` inside the Worker. No zone, no custom
domain, nothing to configure after a deploy.

- **60 requests per 10 seconds per client IP.** Quo sends a few events a minute at most, from its
  own egress addresses, so real traffic sits about fifty times below the limit and a retry storm
  still fits. Period may only be 10 or 60.
- **Order matters, and it is tested:** path → method → rate limit → read body → verify. The HMAC
  is the expensive part, so the limit has to be in front of it. A 429 reads no body and touches no
  database.
- **It is a cost guard, not a security control.** The binding is documented as permissive and
  eventually consistent, and it counts per Cloudflare location, not globally, so the real ceiling
  is a multiple of 60. Nothing about it decides what is trusted: the signature does, and it is
  unchanged.
- **A missing binding passes everything through**, on purpose. Failing closed would turn a config
  slip into a phone outage, and what it would be protecting is a bill, not the data.
- **Blocking Quo by accident is safe:** Quo retries for about 27.5 hours, and `webhook_delivery`
  dedupes by `webhook-id`, so a retry after a 429 is either the first successful write or a no-op.
- **Future upgrade, not a gap:** if a domain is ever on this Cloudflare account, a custom domain on
  the hooks Worker plus a WAF rate-limiting rule would stop the flood at the edge, before a Worker
  invocation is billed at all. The binding can stay as the inner limit. Nothing needs it today.
- **Config key:** `[[ratelimits]]` entries take `name`, not the documented `binding`, in wrangler
  4.131.1, which rejects `binding` outright. The dry-run build is what caught it; the unit tests
  can't, since they exercise the handler and not wrangler's parser. If a wrangler upgrade ever
  renames it back, `npm run build` will say so.
- Tests: `tests/quo-webhook-ratelimit.test.mjs`. Verified after deploy in RUNBOOK §5.2, and
  monitored in §7.

## The pre-push history scan (round 12)

`scripts/scan-history.mjs` is a blocking step before the first push (RUNBOOK §4.2). It reads every
blob, commit message and author line reachable from a ref and exits 1 on any address at a consumer
mail domain, reporting where and never what. `tests/no-personal-addresses.test.mjs` checks the
working tree; a push publishes the history, and round 7's purge is a memory, not a check.

- Run in round 12 against `claude/inh-round-12`: 62 commits, 329 blobs, **clean**.
- `claude/inh-round-5` and `-6`, which held a customer address, no longer exist in this checkout.
  The runbook still deletes them, because a checkout somewhere else may still have them.
- The domain list is duplicated from `tests/no-personal-addresses.test.mjs` on purpose: neither
  file may import an address list from anywhere that could be quietly shortened.

## Tooling notes
- npm 11 `allowScripts` skipped the `esbuild` and `workerd` postinstall scripts. `build` works;
  `wrangler dev` is untested.
- Wrangler telemetry is on by default. It's the owner's call.
