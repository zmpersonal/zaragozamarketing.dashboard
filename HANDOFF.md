# HANDOFF

This file holds open questions and known-wrong things carried forward. Remove an item only once
it's fixed and proven, or once the owner decides it.

Last updated: round 5, 2026-09-13.

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

---

## Real-data findings: `prove/triage.mjs` on support@, 30 days (round 5, full stream)

The round-4 run sampled `in:inbox`, which is the residue, not the stream: 46 messages, biased
toward ambiguous mail. **Every round-4 triage conclusion is withdrawn.** Round 5 sampled the
whole received stream.
- **Query:** `in:anywhere newer_than:30d -in:sent -in:drafts -in:chats` with
  `includeSpamTrash=true`, paged to the end.
- **Result:** 284 messages (9.5/day): 39 kept (1.3/day) and 245 demoted (8.2/day).
- **Exemptions:** 47 exempt senders, built from 147 sent messages over 180 days. 20 of the kept
  messages were kept only because of an exemption.

Rules were **not** changed, apart from the owner-requested no-reply fix. These are
observations only.

### Population
- **284 is below the owner's 300–600 estimate.**
- Possible causes: mail routed to other mailboxes or a Google Group instead of support@, trash
  emptied inside the window, or the estimate itself. Not investigated.

### What drives demotion
- 187 of 245 demoted messages carry Gmail's own `SPAM` label, and 126 are demoted on that alone.
- 58 were demoted by our rules without Gmail spam.
- 45 carry `noreply`. 21 of those are caught only by the widened pattern: Apps Script failure
  notices ×18, plus `workspace-noreply`, `payments-noreply` and `googlebase-noreply`.
- No address containing "bounce", "postmaster" or "mailer-daemon" was matched, so the broader
  match produced no false positives in this sample.

### Demoted verdicts that may be wrong (observations only)
- **`verified.customer@example.com` "Track A Shipment – Priority1 for A Customer"** is demoted on
  `gmail_spam` only.
  - `customer.alt@example.com` (same local part) is an exempt customer in KEPT.
  - It could be a real customer writing from a second address, or an impersonation.
  - The exemption matches exact addresses only.
- **Customer-shaped subjects demoted on Gmail spam alone:**
  - `admin@refund-desk.example` "Refund Request – Order #467740987". The order format
    differs from InHouse's `#INH…`.
  - `admin@alkling.com` "Problem With My Recent Order" (also `list_unsubscribe` and
    `precedence`).
  - `sender3@example.com` "Hi please is this Inhousewellness".
  - All three look like scams or outreach, but the subjects are what a customer would write.
- **Account and operations mail for a human, not a customer:**
  - `no-reply@accounts.google.com` "Critical security alert" ×2.
  - `workspace-noreply@google.com` "Possible unresolved security risks".
  - `payments-noreply@google.com` Workspace invoice.
  - `googlebase-noreply@google.com` "New product image requirements" (Merchant Center).
  - `omri@bbdetector.com` "Responsible Disclosure of a Subdomain Takeover issue" (Gmail spam;
    possibly a real security report).
- **Supplier finance and logistics are demoted:**
  - `no-reply@bathingbrands.com` "ACH Payment Returned", invoices ×3 and account notices ×3.
  - `customerservice@bathingbrands.com` shipping notices ×3. These may be needed to answer
    "where is my order".
- **`testflight_no_reply@email.apple.com` is not matched by `NOREPLY`** (underscore variant).
  It's demoted only because Gmail marked it spam.

### Kept verdicts that may be wrong (observations only)
- **Supplier marketing:** `daniel@goldendesignsinc.com` inventory mailings ×5,
  `service@wizzisaunas.com` ×2, `ziv@dream-pod.com` MAP pricing, and `tadams@bathingbrands.com`
  promotions ×5 (exempt, because we replied once).
- **Cold outreach and newsletters:** `sender7@henrytobin.com`,
  `kristen@sender8.co`, `sender1@example.com`, `sender2@example.com`,
  `sarah@sender9.com`, `hector@sender10.com`, `m.johnson@sender11.org`,
  `sender6@example.com`, and `sender4@example.com` ×2 (exempt).
- **A service notice:** `boomerang@baydin.com` "Message Credits Will Be Refilled".
- **Probably correct:**
  - Apparent customers: `ackerp81` ×4, `gcolon71` ×2, `karellbelle1`, `amachleit`,
    `customer.alt@example.com`.
  - `mailer@shopify.com`, a Shopify-relayed customer message.
  - Possible trade partner: `sofia@saunamo.pt`.

### Output format
Two subjects contain `" | "` ("Guest Post Placements — DR 60–82 | Dofollow…", "Trustpilot ★5 |
Google ★5 | …"). A line with more than four fields is ambiguous to parse. Reason codes are
always the last field.

---

## Gmail ingest reads only `in:inbox` (same bias as the prove script)

`src/ingest/gmail.ts` lists `in:inbox -in:chats newer_than:30d`. Two consequences:
- Customer mail that a Gmail filter archives or labels away never reaches the console queue.
- Nor does mail Gmail files as spam, such as the possible customer `verified.customer@example.com` above.

Not changed this round. It needs an owner decision on which population the queue should read.

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

### 3. Triage isn't wired in
- Nothing calls `classify()`.
- The UI has no demoted section and no rescue button.
- Sender rules aren't written.

### 4. The Shopify relay hides the customer
`mailer@shopify.com` would be stored as the customer handle (see real-data findings).

### 5. `POST /api/actions` doesn't validate `status` or `kind`
An unknown `thread_id` returns 500.

### 6. The UI renders `action.kind` unescaped

### 7. Two non-atomic write pairs
The reopen/unblock action log is written separately from the state change, and the response
insert from the thread update in ingest.

### 8. Gmail ingest has no pagination
It reads 50 threads, and only `in:inbox`.

---

## Known wrong — security and hardening

1. **`authenticate()` gaps.** No caching of the Access certs, and no `iss` or `nbf` check.
2. **Possible CSRF, to be checked.** `req.json()` ignores `Content-Type`. SameSite on
   `CF_Authorization` decides whether a cross-site POST gets through.
3. **`GET /api/threads/:id` doesn't URL-decode the id.**

## Scale and cost — verify before go-live

- **Subrequest limit.** Gmail makes 1 token call (cached per isolate), 1 list call and up to 50
  thread fetches per mailbox. Quo makes 1+ conversation page plus 2 requests per active
  conversation. Check both against the Workers plan's subrequest limit.
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
