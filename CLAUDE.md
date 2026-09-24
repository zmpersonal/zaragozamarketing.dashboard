# CLAUDE.md — internal support console (inhouse-ops)

Read this, then `HANDOFF.md`, then the latest entry in `RUNLOG.md`, before changing anything.

## What this is

One internal console. The repo is named for where it's hosted: Zaragoza Marketing owns the
subdomain. InHouse Wellness (INH), THI and ZM are meant to become tabs in this same console,
not separate projects. **V1 content is InHouse Wellness customer service only.**

It runs in three pieces (rounds 9–11). Cost is $5/month: Workers Paid, bought in round 12;
everything else is on a free tier. The deploy steps are in `RUNBOOK.md`.
- **Console Worker** `inhouse-ops` (`src/index.ts`, `wrangler.toml`), Workers Paid, behind
  Cloudflare Access at Worker level. It serves the static UI (`public/index.html`, real API only,
  no mock data) and `/api/*`, reading and writing D1 (`schema.sql`) through its binding. No cron,
  no ingest, no webhook.
- **Hooks Worker** `inhouse-ops-hooks` (`src/hooks.ts`, `wrangler.hooks.toml`): only
  `/hooks/quo`, same D1 database, no Access.
  - Access on a Worker covers every path and can only be bypassed whole-Worker, and Quo can't sign
    in. So the webhook can't share the console Worker (round 11).
  - It trusts only the signature (invariant 10).
- **GitHub Actions, hourly** (`.github/workflows/ingest.yml` → `scripts/ingest.mjs`): runs Gmail
  and Quo ingest as plain Node, writing to the same D1 database through Cloudflare's D1 REST API
  (`src/db/d1-http.ts`). The ingest code, triage rules and clock are the same code either way;
  only where the statements go differs (`src/db/db.ts`).

No AI provider sits in the critical path.

**Why the split, and what it costs.** Workers Free capped an invocation at 50 external fetches
and 10 ms of CPU, which ingest can't fit, so round 9 moved ingest to Actions. **Round 12: Workers
Paid ($5/month) is bought**, which lifts both caps (1,000 subrequests and 30 s of CPU per
invocation, 15 minutes on a cron trigger), so a Worker cron is viable again. Ingest stays on
Actions for now: it is a hardened path, and the freshness badge makes its failure visible. Revisit
after two weeks of real operation (HANDOFF, "Ingest stays on GitHub Actions (round 12)"). The
trade that buys, recorded so nobody discovers it later:
- **Email is checked roughly hourly**, not every five minutes. A customer email can sit up to
  about an hour before it appears in the queue.
- **GitHub can delay scheduled runs by 15–60 minutes under load**, so "hourly" can stretch to
  nearly two hours now and then.
- **Phone is real-time (round 10).** A verified Quo webhook writes the thread as it arrives,
  through the same code path as polling. The hourly Actions poll is the backstop.
- **Limits that now bind:** Cloudflare's API allows 1,200 requests per 5 minutes per token (every
  call blocked for 5 minutes past that); each run stays under 1,000 D1 statements. GitHub Free
  allows 2,000 Actions minutes a month for a private repo; the 2-minute job timeout caps the
  worst case at 1,460. D1 on Workers Paid includes 25 billion rows read and 50 million written a
  month, which this workload is nowhere near.
- **Worker CPU (rounds 10–11, measured locally).** On Workers Paid the ceiling is 30 s per
  invocation, so these are a cost line, not a failure line; against Workers Free's 10 ms they were
  not comfortably under it. Each request measured in workerd against a local D1 of 4,365
  fabricated threads (trimmed mean):
  - one queue tier page ~6.6–8.6 ms
  - board ~6.4 ms
  - to-dos ~5.6 ms
  p90s run 14–24 ms. The single-call `GET /api/queue` (all tiers) is still ~17 ms. The cost is
  mostly the D1 binding turning rows into objects inside the isolate, plus a fixed cost per D1
  call. Measure on Cloudflare after deploy (RUNBOOK §7); error 1102 is no longer expected. See
  HANDOFF, "Worker CPU".

## Commands

| Command | What it does |
|---|---|
| `npm run check` | Typechecks `src/` against `@cloudflare/workers-types` (strict). |
| `npm test` | Runs `tests/*.test.mjs` with `node:test`. Node strips the types from the `.ts` imports, so there's no build step. Ingest and webhook tests run the real `schema.sql` on `node:sqlite` (`tests/helpers/d1.mjs`) with provider APIs faked. |
| `npm run build` | Dry-run bundles of both Workers (`wrangler.toml`, `wrangler.hooks.toml`). Never contacts Cloudflare. |
| `npm run prove:oauth` | Local Google OAuth flow that prints a gmail.readonly refresh token for one mailbox. |
| `npm run deploy`, `npm run deploy:hooks`, `npm run db:init` | **Human only.** They touch production. Never run them; see `RUNBOOK.md`. |
| `node scripts/ingest.mjs` | **Human only (or Actions).** One ingest run against production D1. Needs the `CLOUDFLARE_*` variables. |

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
- Production secrets are set by a human, never in a file. `wrangler.toml` lists secret *names*
  only, never values (account and database IDs are not secrets).
  - **Worker secret** (`wrangler secret put`): `QUO_WEBHOOK_SECRET`.
  - **GitHub Actions secrets** (repo settings): `GOOGLE_SERVICE_ACCOUNT_JSON` (the service-account
    key's JSON; domain-wide delegation, `gmail.readonly`), `QUO_API_KEY`, `CLOUDFLARE_API_TOKEN`
    (scoped to D1 edit only), `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_D1_DATABASE_ID`.
  - There are no refresh tokens.
- **The ingest workflow never echoes a secret, including on failure.** Secrets reach only the
  ingest step, as environment variables. `scripts/_ingest-run.mjs` passes everything it prints
  (ingest's own logs and error stacks included) through a redactor holding every secret value
  and each line of the key. The D1 client never puts the token in an error. No `set -x`, no
  `continue-on-error`, `persist-credentials: false`. Tests: `tests/ingest-workflow.test.mjs`,
  `tests/ingest-runner.test.mjs`, `tests/d1-http.test.mjs`.
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
  - **Quo:** the conversation's `createdAt` when polling saw it first. A thread first seen through
    the webhook starts at its first event, since webhook events don't carry the conversation's
    own `createdAt`.
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
  - **A killed sync can't lose a measurement** (round 10). An existing thread writes its response
    rows before the thread UPDATE. A new thread is inserted with `waits_pending = 1`, which is
    cleared after its rows are written; a later sync that finds the flag records them again. A REST
    batch isn't documented as atomic, and this order doesn't rely on it.
    `tests/partial-writes.test.mjs` kills the sync before every write, including inside a batch.
- **Deleted mail** (round 10): a Gmail thread that is 404, or has nothing inbound left, becomes
  `status = 'deleted'` with `deleted_at`, its clock stopped. No response row is written, so the
  report never counts it as a reply. A closed thread stays closed and is only stamped. It reopens
  like a closed thread on a new inbound. A malformed Gmail response is a failure, never a
  deletion. Tests: `tests/gmail-deleted.test.mjs`.
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
  - A `Budget` (`src/lib/budget.ts`) counts every fetch and D1 statement per run, and has a
    wall-clock deadline. Ingest stops before the cap or deadline; the rest waits for the next
    run. Caps (round 9, sized for an hourly runner): 150 threads, 600 D1 statements; the run's
    deadline is what usually binds. Tests: `tests/run-limits.test.mjs`.
  - Drafts and chats never count as messages, so a saved draft reply isn't a reply.
  - Tests: `tests/gmail-incremental.test.mjs`, `tests/gmail-population.test.mjs`.
- **The UI has three sections** (`public/queue-sections.mjs`): Needs reply, Probably not
  customers (with reason chips), and Spam at the bottom with a count.
  - **Paged per tier, visibly** (round 11):
    - `GET /api/queue?tier=&offset=` returns 50 rows of one tier plus its total.
    - The UI loads each tier separately and shows "Showing 50 of 120" with "Show 50 more".
    - Each tier is still its own statement, so no tier can crowd another out
      (`tests/queue-tiers.test.mjs`, `tests/queue-paging.test.mjs`).
    - Rows carry only what the list renders; preview and notes come with `GET /api/threads/:id`.
    - To-dos are paged the same way (100, with a total).
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
  If an agent changes the thread mid-sync, the write is skipped and the next ingest run resolves
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
- **Every Quo inbound is observed, in bounded runs** (round 8).
  - Quo polling reads individual messages and calls created after the cursor, never just a
    conversation's latest activity.
  - `source.sync_cursor` is JSON `{highWater, scan}`. A scan lists conversations with activity
    since `highWater` (30 days back on a source's first scan), at most
    `QUO_LIMITS.listPagesPerRun` pages per run, and reads at most `conversationsPerRun`
    conversations per run. The rest stays in the scan for the next run.
  - `highWater` advances only when a scan completes with nothing held for retry, and it becomes
    the scan's **start** time, never the newest event seen. A conversation read early in a
    multi-run scan can get activity that is older than events read later.
  - A `Budget` counts every fetch and D1 statement. A conversation that doesn't fit what is left
    waits. One that could never fit a run, or has more than `pagesPerConversation` pages of
    messages or calls, is recorded in `ingest_failure` like any failure, so it can't block the
    queue.
  - Caps (round 9): 80 conversations, 5 listing pages, 10 pages per conversation, 400 D1
    statements per run; the run's deadline is what usually binds.
  - Tests: `tests/quo-budget.test.mjs`, `tests/quo-ingest.test.mjs`.
  - The cursor advances unless a conversation failed and is still being retried.
- **The Quo webhook writes phone activity as it happens** (round 10).
  - A verified `message.received`, `message.delivered`, `message.undelivered`, `message.failed`,
    `call.completed` or `call.missed` event becomes the same message or call shape polling reads.
    It goes through `syncQuoActivity()` → `toTimeline()` → `syncThread()`, the one write path
    polling uses too, so the two can't drift.
  - Deduplicated by the `webhook-id` header (`webhook_delivery`, pruned after 7 days; Quo retries
    for about 27.5 hours). The id is recorded only after processing succeeds, so a delivery that
    failed with a 500 is processed when Quo retries it.
  - Events we can't place (an unknown phone number, a null `conversationId`, other event types)
    are acknowledged with 200 and ignored. A malformed event of an ingested type is a 400.
  - Polling afterwards changes nothing. Two layers each prevent double counting: inbound
    messages already seen don't start a wait, and `UNIQUE(thread_id, awaiting_since)`.
  - A failed or undelivered text is not contact. A call doesn't blank a text preview.
  - Tests: `tests/quo-webhook-ingest.test.mjs`.
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

### 9. Nothing a user types reaches the DOM unescaped; writes are same-origin JSON (round 10)
- `public/render.mjs` builds the thread header, history, to-do rows and matrix cells. `esc()`
  escapes `& < > " '`, and `public/queue-sections.mjs` builds the queue rows with it.
  `tests/ui-escaping.test.mjs` feeds hostile text into every field. It also fails if
  `index.html` builds markup from anything but literals and those functions.
- `POST /api/*` requires `Content-Type: application/json` (415), an `Origin` equal to the Worker's
  own (403), and `Sec-Fetch-Site: same-origin` when that header is present (403). These are
  checked before any body is read.
- An action's `kind`, `status` and `blocked_on` must be known values (400). An unknown thread or
  to-do is a 404, never a 500. Tests: `tests/api-hardening.test.mjs`.

### 10. Public endpoints trust nothing unsigned
`/hooks/quo` (on the hooks Worker, `src/webhook.ts`) verifies a Standard Webhooks signature, per
Quo's versioned docs for API 2026-03-30, over the raw body before trusting it
(`src/lib/quo-signature.ts`). The console Worker answers `/hooks/*` with 404.
- **Headers:** `webhook-id`, `webhook-timestamp` (seconds), and `webhook-signature` (`v1,<b64>`
  entries).
- **Signature:** HMAC-SHA256 over `id.timestamp.body`, with the `whsec_` secret as the key.
- **Replay window:** 5 minutes, in either direction.
- **Returns 401** on any failure: the legacy `openphone-signature` header, a re-serialized body,
  a millisecond timestamp, and an unset or non-base64 secret (fail closed).
- Tests: `tests/quo-webhook.test.mjs`.
- Any new public webhook needs the same: verify first, fail closed, and test both a valid and an
  invalid signature.

### 11. A broken or stale console never looks like a quiet one (round 11)
- The header shows each source's last successful sync, from `/api/board` (`sources`, plus `now`, the
  server's clock). Over 3 hours is a warning; over 12, or never synced, is an error
  (`public/freshness.mjs`).
- `source.last_synced_at` moves only when a source's run succeeds. A disabled schedule, expired
  token, quota or API change all show up the same way.
- An empty Needs reply says "Nothing waiting" only when the API answered and every source is fresh.
  Otherwise it says the list may be out of date, or that loading failed.
- A brand × channel cell says "clear" only if the board loaded and that brand's source for that
  channel is fresh. Otherwise: "not verified: synced 13 h ago", "not connected", or "? not loaded".
  The to-do list says "Could not load to-dos", never "Nothing on the list", when it failed.
- Tests: `tests/sync-freshness.test.mjs`, `tests/ui-wiring.test.mjs`.

## Layout

```
src/index.ts              console Worker: auth (Access JWT), /api routes (paged queue and to-dos). No ingest, no cron, no webhook.
src/hooks.ts              hooks Worker: /hooks/quo only (no Access)
src/webhook.ts            the Quo webhook handler: verify, dedupe by webhook-id, syncQuoActivity
src/ingest/gmail.ts       Gmail threads (service-account auth) → timeline → syncThread (customer = first inbound sender)
src/ingest/quo.ts         Quo v1 messages + calls since source.sync_cursor → syncThread
src/ingest/chat.ts        provider-agnostic chat → syncThread (not routed yet)
src/db/db.ts              Db: the database surface ingest uses (binding or REST client)
src/db/d1-http.ts         D1 over Cloudflare's REST API: retries 429, retries 5xx for reads only
src/db/threads.ts         syncThread (conditional write), rescueThread, responseInsert
src/db/failures.ts        ingest_failure: recordFailure / clearFailure / listFailures (skip after 3)
src/lib/google-auth.ts    service-account JWT (domain-wide delegation) → Gmail access token
src/lib/budget.ts         per-run fetch / D1 statement caps and wall-clock deadline
src/lib/thread-state.ts   status / awaiting_since / reopen rules, responseMinutes (pure)
src/lib/triage.ts         demotion rules (pure)
src/lib/clock.ts          business-minutes clock (pure)
src/lib/quo-signature.ts  Quo webhook verification (Standard Webhooks)
schema.sql                D1 schema + brand seed
public/index.html         UI: real API only, paged tiers, freshness badges, 60-second refresh
public/render.mjs         escaped HTML builders (thread, history, to-dos, matrix cells)
public/freshness.mjs      last-sync classification, badges, empty/failed queue messages
public/paging.mjs         refresh that keeps pages the agent opened
RUNBOOK.md                the ordered deploy steps, mine vs yours, and what can't be undone
prove/*.mjs               run-by-hand source proofs; need real credentials (Gmail: GOOGLE_SERVICE_ACCOUNT_FILE).
                          quo.mjs --quiet prints the phone-number ids only, reading no conversation.
                          Never in cron. backfill-known-senders.mjs (one-off), apply-known-senders.mjs
                          (setup, filters our own domain) and ingest-live.mjs write customer data to
                          files outside the repo only.
scripts/ingest.mjs        hourly ingest entry point (GitHub Actions); logic in scripts/_ingest-run.mjs
scripts/scan-history.mjs  pre-push guard (RUNBOOK §4.2): no consumer-domain address in any blob,
                          commit message or author line reachable from the ref. Says where, never what.
.github/workflows/ingest.yml  hourly schedule + manual run, keepalive, 2-minute timeout
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
