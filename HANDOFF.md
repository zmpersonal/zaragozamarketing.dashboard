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
  - Defaults cap the invocation at 900 subrequests and 900 D1 queries: inside Workers Paid
    (10,000 / 1,000), not Free (50 / 50, 10 ms cron CPU). **Workers Paid is required.** On Free,
    `INGEST_MAX_SUBREQUESTS` / `INGEST_MAX_D1_QUERIES` could be set to ~45 but the 10 ms CPU cap
    would still likely fail.
  - **Quo ingest is not budgeted yet.** It runs on its own trigger but has no per-run cap.
- **Exemption parity (round 7).** `prove/backfill-known-senders.mjs` read all 2,192 sent
  messages on support@ (back to 2024-11-22) and produced 723 `known_sender` rows, in
  `~/Code/secrets/inhouse-ops-known-senders.sql`. **Not applied to any database:** a human runs
  `wrangler d1 execute inhouse-ops --file=<that file> --remote` after `schema.sql`.
- **No-reply separator edge:** names ending in "no" + separator + "reply" (`bruno_reply@`,
  `arno.reply.smith@`) now match `NOREPLY`. None appeared in the real stream.

### Other
- **D1 itself.** All SQL has run only on `node:sqlite`.
- **`wrangler dev`.**

---

## Known wrong — correctness

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

### 9. `prove/ingest-live.mjs` imports the D1 shim from `tests/helpers`
Deliberate (it runs production SQL on node:sqlite), but it couples a prove script to test
helpers.

---

## Known wrong — security and hardening

1. **`authenticate()` gaps.** No caching of the Access certs, and no `iss` or `nbf` check.
2. **Possible CSRF, to be checked.** `req.json()` ignores `Content-Type`. SameSite on
   `CF_Authorization` decides whether a cross-site POST gets through.
3. **`GET /api/threads/:id` doesn't URL-decode the id.**

## Scale and cost — verify before go-live

- **Subrequest limit.** Gmail is budgeted (see "Volume per cron run"). Quo makes 1+
  conversation page plus 2 requests per active conversation with no cap yet.
- **D1 reads and writes.** `syncThread` adds one SELECT per thread per sync, plus a
  response/failure write where relevant.

## Schema changes need migrations once a database exists

Round 4 added the `response` and `ingest_failure` tables while no database exists. After the
first real deploy, use `wrangler d1 migrations`.

---

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
