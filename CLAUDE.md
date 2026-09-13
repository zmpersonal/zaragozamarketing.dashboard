# CLAUDE.md — internal support console (inhouse-ops)

Read this, then `HANDOFF.md`, then the latest entry in `RUNLOG.md`, before changing anything.

## What this is

One internal console. The repo is named for where it's hosted: Zaragoza Marketing owns the
subdomain. InHouse Wellness (INH), THI and ZM are meant to become tabs in this same console,
not separate projects. **V1 content is InHouse Wellness customer service only.**

It is one Cloudflare Worker (`src/index.ts`) with a D1 database (`schema.sql`) and a static UI
(`public/index.html`). The Worker serves the UI and `/api/*`, and runs Gmail and Quo ingest
on two 5-minute cron triggers (Gmail at :00/:05…, Quo two minutes later), so each gets its own
subrequest budget. No AI provider sits in the critical path.

## Commands

| Command | What it does |
|---|---|
| `npm run check` | Typechecks `src/` against `@cloudflare/workers-types` (strict). |
| `npm test` | Runs `tests/*.test.mjs` with `node:test`. Node strips the types from the `.ts` imports, so there's no build step. Ingest and webhook tests run the real `schema.sql` on `node:sqlite` (`tests/helpers/d1.mjs`) with provider APIs faked. |
| `npm run build` | `wrangler deploy --dry-run --outdir dist`. Bundles locally and never contacts Cloudflare. |
| `npm run prove:oauth` | Local Google OAuth flow that prints a gmail.readonly refresh token for one mailbox. |
| `npm run deploy`, `npm run db:init` | **Human only.** Both touch production. Never run them. |

`check`, `test` and `build` must all be clean before a round is reported done.

## Invariants — these cannot be violated

Each rule lists where the code enforces it today. A **gap** marks something that isn't built
yet, so the rule can't be broken there *yet*. Any work that closes a gap must enforce the rule.

### 1. Never deploy, merge, or push to `main`
These are human actions. Work on a `claude/…` branch and commit there. Don't open a PR unless
the round asks for one. Don't run `wrangler deploy` (except the `--dry-run` in `npm run build`),
`wrangler d1 … --remote`, or `wrangler secret put`.

### 2. Never commit secrets
- Local secrets go in `.dev.vars`, which is gitignored along with `.env`, `.wrangler/` and `node_modules/`.
- Production secrets are set with `wrangler secret put NAME`. `wrangler.toml` lists secret
  *names* only, never values.
- The Worker secrets are `GOOGLE_SERVICE_ACCOUNT_JSON`, `QUO_API_KEY` and `QUO_WEBHOOK_SECRET`.
  - `GOOGLE_SERVICE_ACCOUNT_JSON` is the service-account key's JSON (domain-wide delegation,
    `gmail.readonly`).
  - There are no refresh tokens.
- **The Gmail service-account key never enters the repo.**
  - Locally it lives outside the repo, and scripts read it only through the path in
    `GOOGLE_SERVICE_ACCOUNT_FILE`.
  - Never copy it into the repo, print it, log it, or commit it. `.gitignore` covers
    `secrets/`, `*.pem`, `*service-account*.json` and `inhouse-ops-*.json`.
  - Code that handles the key (`src/lib/google-auth.ts`, `prove/_google.mjs`) reports errors
    by variable name, path and Google's error code only.
  - `tests/google-auth.test.mjs` fails if any tracked file contains PEM key material or
    service-account JSON.

### 3. `thread.conversation_started_at` is when the conversation began, and never moves
It is written on INSERT only and never updated, by ingest, a rescue, a reopen, or any action.
The response clock does **not** run from it (see invariant 4).
- **Enforced today:** `syncThread()` in `src/db/threads.ts` is the only ingest write path. Its
  UPDATE has no `conversation_started_at` column. `rescueThread()` and `POST /api/actions` don't write
  it either. Tests: `tests/awaiting-since.test.mjs`, `tests/rescue.test.mjs`.
- What "began" means per source:
  - **Gmail:** the thread's first message, which can be ours.
  - **Quo:** the conversation's `createdAt`.
  - **Chat:** the provider's `startedAt`.

### 4. The response clock runs from `awaiting_since`
`thread.awaiting_since` is the oldest inbound message with no outbound after it. It is NULL when
we're caught up. The response clock, queue order, board "oldest" and every UI age run from it,
never from `conversation_started_at`. The rules live once, in `src/lib/thread-state.ts` (pure).
- **Reopen:** a new inbound on a `closed` thread sets status back to `waiting`, sets
  `awaiting_since` to that message's time, and logs a `system` / `reopened` action.
  - "New" means newer than the stored `last_inbound_at`, not newer than `closed_at`. That way a
    message that landed before the agent clicked close, but after the last sync, still reopens
    the thread.
- **Closed with nothing new:** stays `closed`, with `awaiting_since` NULL. Closing through
  `POST /api/actions` also sets it NULL.
- **The agent's chosen status is authoritative.**
  - An action of kind `replied` or `called` (`POST /api/actions`) always sets
    `last_outbound_at` (contact).
  - It clears `awaiting_since` **only** if the agent chose `answered` or `closed`. A voicemail
    logged as "still needs a reply" keeps the clock running.
  - Other kinds never touch `last_outbound_at`.
- **Ingest respects that.** A stored contact counts as an outbound event only when the agent
  resolved it (`awaiting_since` is NULL). So ingest never resurrects `waiting` from an inbound
  that a resolved contact already answered, and never stops a clock the agent left running.
  Tests: `tests/contact-actions.test.mjs`, `tests/thread-state.test.mjs`.
- **Every wait that ends is measured**, in the append-only `response` table: `awaiting_since`,
  `responded_at`, `business_minutes`, `via`, `actor`, and UNIQUE(`thread_id`, `awaiting_since`).
  - It's a table, not a column, because a column would lose the first measurement when a
    thread reopens.
  - **Ingest** records every open wait followed by an outbound (`completedWaits()`), including
    waits that began and ended between syncs. `via` is `message`, stamped with the reply's own
    time.
  - **The actions route** records a wait when the agent stops the clock. `via` is `replied` or
    `called`, or `closed` for a close without contact (not a reply).
  - Tests: `tests/response.test.mjs`.
- **Held until we reply:** once set, `awaiting_since` holds until an outbound is seen after it,
  including a logged contact. A reopened thread can't slide back to a pre-close message on the
  next sync.
- **Rescue:** rescuing a demoted message (`rescueThread`, `POST /api/threads/:id/rescue`) changes
  `triage` and `triage_by` and logs a `rescued` action, **only**. It never writes
  `conversation_started_at` or `awaiting_since`, so the clock runs from when the customer actually
  wrote. Violating this launders slow responses into good numbers and silently corrupts the
  admin report.
- `responseMinutes(thread, now)` returns null when caught up. It never falls back to
  `conversation_started_at`.

### 5. Triage never deletes or hides mail, in any of its three tiers
Every thread is `customer` (needs a reply), `bulk` (probably not a customer) or `spam`. Every
tier is shown, and every non-customer verdict carries its reasons to the UI.
- **Spam is its own tier, never a heavier bulk signal.**
  - Gmail's `SPAM` label routes to `spam` and only there. Its signal has weight 0, and the bulk
    score counts bulk signals only.
  - A message with both spam and bulk signals is `spam`, with all its reasons kept.
  - Agent-marked spam senders are `spam`.
  - The reason is in HANDOFF, "Why the spam tier exists". Don't fold spam back into bulk.
- **Exemptions beat every signal, including Gmail spam.** In order:
  1. verified customers and agent-marked real senders (`sender_rule` verdict `customer`)
  2. senders we've replied to (`known_sender`, and threads with an outbound message)
  - Tests: `tests/triage-tiers.test.mjs`, with the round-5 misfiled-customer case on a
    fabricated address.
- **Customer addresses never enter the repo** (round 7). Not in code, tests, fixtures, docs or
  commit messages.
  - Verified customers are `sender_rule` rows, applied at setup from a seed file kept outside
    the repo (`seeds/sender_rule.example.sql` shows the shape; `seeds/*` other than
    `*.example.sql` is gitignored).
  - Tests use fabricated addresses (`example.com`, `.example`).
  - `tests/no-personal-addresses.test.mjs` fails on any consumer-mail-domain address (icloud,
    gmail, yahoo, outlook, hotmail, msn, aol and similar) under `src/`, `tests/`, `public/` or
    `prove/`.
  - prove/ scripts that write customer data (`backfill-known-senders.mjs`, `ingest-live.mjs`)
    refuse a path inside the repo, write mode 600, and print counts, dates, tiers and subjects
    only.
- **`classify()` in `src/lib/triage.ts` is pure.** It returns
  `{ tier, demote, score, signals[{code, why, weight}], exemptReason? }`.
  - A bulk score of 2 or more is `bulk`.
  - Gmail's `CATEGORY_UPDATES` deliberately contributes no signal.
  - `NOREPLY` matches anywhere in the local part, never the domain. The words may be joined by
    a hyphen, underscore, dot, or nothing (`testflight_no_reply@`, `no.reply@`,
    `do_not_reply@`). Real-name non-matches are pinned in `tests/triage.test.mjs`.
- **Gmail ingest classifies every thread** from its first inbound message.
  - It stores `triage`, `triage_score` and `triage_signals` (JSON `[{code, why}]`).
  - It never overwrites a verdict a human set: `triage_by` not null, for example after a rescue.
  - Tests: `tests/gmail-population.test.mjs`.
- **Gmail ingest reads the whole received stream**, the same population as the prove script:
  - query `in:anywhere newer_than:30d -in:sent -in:drafts -in:chats`, with
    `includeSpamTrash=true`
  - archived, filtered, spam and trash mail all reach the queue. Never go back to `in:inbox`,
    which makes the filter moot.
- **Gmail ingest is incremental and bounded** (round 7). `source.sync_cursor` holds JSON
  `{historyId, pending, backfillPageToken}`.
  - Empty cursor: bounded backfill. Store the profile's `historyId`, list one page of the query,
    fetch at most `GMAIL_LIMITS.threadsPerRun` threads, keep the rest pending and the page token
    for later runs.
  - Stored `historyId`: `history.list` (message added, label added, label removed), fetching
    only changed threads.
  - Expired (404) or invalid (400) `historyId`: warn, bounded window listing, re-seed.
  - A `Budget` (`src/lib/budget.ts`) counts every fetch and D1 statement per invocation and stops
    before the cap; the rest waits for the next run. Defaults stay under Workers Paid limits,
    asserted by a test.
  - Drafts and chats never count as messages, so a saved draft reply isn't a reply.
  - Tests: `tests/gmail-incremental.test.mjs`, `tests/gmail-population.test.mjs`.
- **The UI has three sections** (`public/queue-sections.mjs`): Needs reply, Probably not
  customers (with reason chips), and Spam at the bottom with a count.
  - Header and per-brand counts ("N need a reply", brand cells, `/api/board`) count Needs reply
    only. Bulk and spam are counted in their own sections. Tests: `tests/header-counts.test.mjs`.
  - Unknown tiers show as Needs reply.
  - The spam section is always expanded, never behind a click. Each row shows the sender
    address and the full subject, never truncated.
  - Tests: `tests/queue-sections.test.mjs`.
- **Rules change only after the owner reads real output from the full received stream**
  (`prove/triage.mjs`, same query, every list paged).
- `prove/_triage-rules.mjs` is a plain-JS copy of the rules for the prove script. A parity test
  runs both over 343 message shapes and requires identical tier, score and reason codes.
  `src/lib/triage.ts` is the source of truth.

### 6. Response time is business minutes only
Business time is America/Chicago, Mon–Fri 08:00–17:00. Never wall-clock.
- **Enforced today:** `businessMinutes()` in `src/lib/clock.ts` steps one local **calendar date**
  at a time, so every iteration covers exactly one local day, whether that day is 23, 24 or 25
  hours long. It resolves each day's 08:00 and 17:00 from wall time in the IANA zone.
- `tests/clock.test.mjs` covers **both** DST transitions and a 21-week span across both. Every
  case runs in a worker with a deadline, so a hang is reported as a failure.
  - **Any clock change must keep both transitions tested.** They fail differently: November
    passed while March hung.
- `responseMinutes()` in `src/lib/thread-state.ts` is the response clock.
- **Gap:**
  - `thread.first_response_mins` is never written.
  - The UI (`public/index.html`) computes ages, the "Over 24h" filter and the heat colours from
    `awaiting_since`, but in wall-clock `Date.now()` hours. That violates this rule, and it has
    to change before the admin report exists.

### 7. Ingest never overwrites a status a human set
- **`blocked`** stays blocked while nothing new arrives. The clock (`awaiting_since`) still runs.
  - **A new inbound** (newer than the stored `last_inbound_at`) means the customer is chasing
    us. The thread leaves `blocked` for `waiting` (or `answered`, if we already replied since)
    and gets `awaiting_since`.
  - Its `blocked_since` is cleared, so it leaves the blocked group, but `blocked_on` and
    `blocked_note` are kept as context.
  - A `system` / `unblocked` action records it.
  - `blocked_since` is set by `POST /api/actions` on the move to `blocked`, kept while the thread
    stays blocked (re-saving doesn't reset it), and cleared when it leaves. Ingest writes it
    only to clear it when a chasing inbound unblocks the thread.
  - `/api/queue` lists waiting threads first (by `awaiting_since`), then blocked threads (by
    `blocked_since`), with priority ordering within each group. The UI shows "blocked 6d".
    Tests: `tests/blocked-since.test.mjs`.
- **`closed`** stays closed unless a new inbound message arrives, which reopens it (invariant 4).
  Reopening a closed thread and unblocking a chased blocked thread are the only automatic
  changes to a human-set status.
- `answered` and `waiting` are **not** protected. Ingest recomputes them from the timeline.
- **Enforced today:** `resolveState()` applies these rules. `syncThread()`'s UPDATE is also
  conditional on the status, `awaiting_since`, `last_inbound_at` and `last_outbound_at` it read.
  If an agent changes the thread mid-sync, the write is skipped and the next cron run resolves
  again.
  - Tests: `tests/awaiting-since.test.mjs` (guards) and `tests/sync-thread.test.mjs` (the race).
- Any new ingest source must go through `syncThread()`.
- **One bad item never stops a source.**
  - Gmail wraps each thread, and Quo wraps each conversation, in its own `try/catch`. A failure
    is logged with the item's id and skipped, and the rest of the batch syncs.
  - Every failure is recorded in `ingest_failure` (consecutive count, last error). A successful
    sync deletes the row.
  - A Quo conversation holds the cursor for retry until its 3rd consecutive failure, then is
    marked `skipped_at` and the cursor moves past it. A poison record can never stop phone
    ingest.
  - `GET /api/board` returns `ingest_failures`.
  - Tests: `tests/ingest-isolation.test.mjs`, `tests/quo-ingest.test.mjs`,
    `tests/poison-pill.test.mjs`.
- **Every Quo inbound is observed.**
  - Quo polling reads individual messages and calls created after `source.sync_cursor`, never
    just a conversation's latest activity.
  - The cursor advances unless a conversation failed and is still being retried.
  - The webhook is the fast path; polling is the backstop.
  - `prove/quo.mjs` uses the same exported helpers.

### 8. Agents are identified individually
Never by a shared or rotating login.
- **Enforced today:** `authenticate()` in `src/index.ts` takes the email from a Cloudflare Access
  JWT, and `action.actor` records that email.
  - The JWT must carry a valid RS256 signature from the team's published certs, a numeric `exp`
    in the future, an `aud` that exactly matches `ACCESS_AUD` (string or array), and an email.
  - Anything malformed is a 401, never a 500.
  - Tests: `tests/auth.test.mjs`, which mints real tokens.
- Role is `owner` if the email is in `OWNERS`, otherwise `agent`.
- The Access policy must list individual people. Don't allow a shared mailbox (e.g. a generic
  `agent@` or `support@` login) as a console user.
- **Accepted gap:** there is no per-thread authorization. Any signed-in agent can act on any
  thread or to-do. See HANDOFF.

### 9. Public endpoints trust nothing unsigned
`/hooks/quo` verifies a Standard Webhooks signature, per Quo's versioned docs for API 2026-03-30,
over the raw body before trusting it (`src/lib/quo-signature.ts`).
- **Headers:** `webhook-id`, `webhook-timestamp` (seconds), and `webhook-signature` (`v1,<b64>`
  entries).
- **Signature:** HMAC-SHA256 over `id.timestamp.body`, with the `whsec_` secret as the key.
- **Replay window:** 5 minutes, in either direction.
- **Returns 401** on any failure: the legacy `openphone-signature` header, a re-serialized body,
  a millisecond timestamp, and an unset or non-base64 secret (fail closed).
- Tests: `tests/quo-webhook.test.mjs`.
- Any new public webhook needs the same: verify first, fail closed, and test both a valid and an
  invalid signature.

## Layout

```
src/index.ts              Worker: auth (Access JWT), /api routes, /hooks/quo, cron → ingest
src/ingest/gmail.ts       Gmail threads (service-account auth) → timeline → syncThread (customer = first inbound sender)
src/ingest/quo.ts         Quo v1 messages + calls since source.sync_cursor → syncThread
src/ingest/chat.ts        provider-agnostic chat → syncThread (not routed yet)
src/db/threads.ts         syncThread (conditional write), rescueThread, responseInsert
src/db/failures.ts        ingest_failure: recordFailure / clearFailure / listFailures (skip after 3)
src/lib/google-auth.ts    service-account JWT (domain-wide delegation) → Gmail access token
src/lib/budget.ts         per-invocation subrequest / D1 query budget
src/lib/thread-state.ts   status / awaiting_since / reopen rules, responseMinutes (pure)
src/lib/triage.ts         demotion rules (pure)
src/lib/clock.ts          business-minutes clock (pure)
src/lib/quo-signature.ts  Quo webhook verification (Standard Webhooks)
schema.sql                D1 schema + brand seed
public/index.html         UI, mock data until USE_API = true
prove/*.mjs               run-by-hand source proofs; need real credentials (Gmail: GOOGLE_SERVICE_ACCOUNT_FILE).
                          Never in cron. backfill-known-senders.mjs (one-off) and ingest-live.mjs
                          write customer data to files outside the repo only.
seeds/*.example.sql       shape of setup seeds; real seeds live outside the repo
tests/*.test.mjs          node:test suites; tests/helpers has the D1 shim, fake Gmail, fake
                          Quo v1 API, and an Access JWT minter
```

Source imports use explicit `.ts` extensions (`allowImportingTsExtensions`), so Node can load
`src/` directly in tests. Wrangler bundles them unchanged.

## Working rules

- Read a file before changing it. Describe what the code *does*, not what the README says.
- For a bug: write the failing test first, watch it fail, then fix.
- A test only counts once you've seen it fail against deliberately broken code.
- Don't silence type errors with `any` or `@ts-ignore`.
- Record every round in `RUNLOG.md` and every open question in `HANDOFF.md`.
