# HANDOFF

This file holds open questions and known-wrong things carried forward. Remove an item only once
it's fixed and proven, or once the owner decides it.

Last updated: round 4, 2026-09-13.

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

## Real-data findings: `prove/triage.mjs` on support@, 30 days (round 4)

Rules were **not** changed. These are observations for the owner to judge.

### Volume
- 46 messages in 30 days: 30 kept (1.0/day), 16 demoted (0.5/day). 47 exempt senders.
- The owner's premise was 10–20 messages a day. The script queries `in:inbox newer_than:30d`,
  so anything archived by a Gmail filter or by a person is not counted. Ingest uses the same
  `in:inbox` query.
- Whether mail is being archived before it reaches the inbox is unknown. Check the mailbox's
  filters and All Mail volume.

### Possibly wrong verdicts (observations only)
- **Google no-reply senders are kept.** `noreply-apps-scripts-notifications@google.com` ×3,
  `workspace-noreply@google.com` and `payments-noreply@google.com` stay in KEPT. The no-reply
  rule matches only an address that **starts** with `noreply@` / `no-reply@`, so `…-noreply@`
  and `noreply-…@` are missed.
- **Supplier bulk mail is kept.** Five "PROMOTIONS + UPDATED INVENTORY" mailings from
  `daniel@goldendesignsinc.com`, 2 from `service@wizzisaunas.com`, 1 from `ziv@dream-pod.com`
  (MAP pricing) and 5 from `tadams@bathingbrands.com` all stay in KEPT.
  - They carry no List-Unsubscribe header or Promotions label that the rules saw.
  - `tadams` is exempt because we replied once, so every future promotion from that address
    will be kept.
  - About 13 of the 30 kept messages are supplier marketing.
- **Actionable supplier finance and logistics mail is demoted.**
  - `no-reply@bathingbrands.com` "ACH Payment Returned to Bathing Brands", supplier invoices ×3
    and account notices ×2 are all demoted, on the `noreply` rule.
  - `customerservice@bathingbrands.com` shipping notices ×2 are demoted, on `list_unsubscribe`
    and `precedence`.
  - None are customers, but a returned payment needs a human.
- **Outreach is kept.** `sender2@example.com` "Blog Post Inquiry" (likely link-building) and
  `sender4@example.com` "Exclusive opportunity" (exempt) stay in KEPT.
- **A real customer arrives through Shopify.** `mailer@shopify.com` "New customer message" is
  correctly kept.
  - The customer's own address is inside the Shopify relay, so ingest would store
    `mailer@shopify.com` as the customer handle.
  - Its Reply-To is not read.
- **No apparent customer is in DEMOTED,** judging by sender and subject; bodies weren't read.
  Apparent customers in KEPT include the Finnmark and delivery-confirmation threads.
- **The output truncates long addresses at 34 characters,** so `noreply-apps-scripts-notifications@…`
  runs into its subject. Formatting only.

### Script vs ingest
`prove/triage.mjs` still carries its own copy of the rules; `src/lib/triage.ts` is the source
of truth.
- For this run, the copy's verdicts equal the source rules: `markedSpam` and `markedReal` were
  empty, and the signal codes are the same.
- They are not proven identical by running both on the same messages.
- Importing the source rules into the script is still awaiting owner approval.

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
