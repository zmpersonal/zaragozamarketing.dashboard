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
- The owner reported moving a junk message to Trash on support@. On re-running
  `prove/ingest-live.mjs` against the saved state, support@'s Trash was **empty**: `in:trash`,
  `labelIds=TRASH` and the TRASH label's own counts were all 0.
- `history.list` since the round-7 baseline showed 6 messages added, 1 label added (a user
  label, not TRASH) and **5 messages permanently deleted**. Four of those were threads ingested
  in round 7, all `spam` from 14–15 August, which is Gmail's automatic 30-day spam purge. The
  fifth was never ingested.
- So either the message was moved in another mailbox, or it was deleted forever or Trash was
  emptied before the re-run. Needs the owner to check, then re-run.

### Deleted mail is never noticed by ingest (round 8 finding)
Gmail ingest asks `history.list` for message-added and label changes only, not
`messageDeleted`. A permanently deleted message (including Gmail's own 30-day spam purge) leaves
its thread row exactly as it was: the 4 purged spam threads above are still `spam` / `waiting`
in the local database. For spam that's harmless. A real customer thread deleted in Gmail would
stay in Needs reply forever. Not changed; owner decision on what a deleted thread should do.

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

### 5. `POST /api/actions` doesn't validate `status` or `kind`
An unknown `thread_id` returns 500.

### 6. The UI renders `action.kind` unescaped

### 7. Two non-atomic write pairs
The reopen/unblock action log is written separately from the state change, and the response
insert from the thread update in ingest.

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
Worker (Workers Free) keeps the UI, the API and the Quo webhook. Owner decision: Julian stays on
the free tier.

**The trade, recorded:**
- Email reaches the queue roughly hourly instead of within five minutes.
- GitHub can delay scheduled runs 15–60 minutes under load.
- **Phone is not real-time yet.** The Quo webhook stays on the Worker for that purpose, but it
  only verifies and logs; it doesn't write threads. Until webhook ingest is built (not in scope
  for round 9 or 10 so far), phone is hourly.

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
- **Whether a REST `batch` is one transaction,** as the binding's is. The client sends a batch as
  one request; the docs say it "will be executed as a batch".
- **Writes are not retried on 5xx or network errors**, since they may have been applied. The run
  fails that source and the next run re-syncs from the unchanged cursor. A write that did apply
  can leave one duplicate `action` log row (reopened / unblocked); thread and response writes are
  conditional or idempotent.
- **Workers Free CPU (10 ms) for API requests.** Each `/api` request verifies the Access JWT
  (WebCrypto) and runs D1 queries; `/api/queue` runs 6. Not measured.
- **Scheduled workflows run only from the default branch.** `main` has no commits yet, so nothing
  runs on a schedule until this branch is merged.

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

## Tooling notes
- npm 11 `allowScripts` skipped the `esbuild` and `workerd` postinstall scripts. `build` works;
  `wrangler dev` is untested.
- Wrangler telemetry is on by default. It's the owner's call.
