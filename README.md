# InHouse support console

One internal console, hosted on a Zaragoza Marketing subdomain. InHouse Wellness, THI and ZM
are planned as tabs in it. **V1 scope is InHouse Wellness customer service only:** email and
phone in one place, a queue for the agent, and response-time data for the admin report. Chat
and the THI panel come later.

The rules the code must never break are in `CLAUDE.md`. Open questions and known gaps are in
`HANDOFF.md`, and the history of each round is in `RUNLOG.md`.

## Why this stack

The stack was chosen to be cheap, secure, and still standing if every subscription lapses:

- **Cloudflare Workers + D1 + static assets.** Two Workers and one SQLite database: `inhouse-ops`
  serves the UI and the `/api` routes behind Access, and `inhouse-ops-hooks` serves `/hooks/quo`
  and nothing else. Access on a Worker covers every path it serves, and Quo can't sign in, so the
  webhook needs a Worker of its own (round 11).
- **GitHub Actions (free) runs ingest hourly.** Gmail and Quo ingest run as plain Node and write
  to D1 through Cloudflare's D1 REST API. It moved off the Worker in round 9, when Workers Free
  capped a run at 50 outbound requests and 10 ms of CPU. Workers Paid lifts both, so this is now
  a choice; it stays on Actions until two weeks of real operation say otherwise (HANDOFF).
- **Cost: $5/month** — Workers Paid, bought in round 12. Everything else is on a free tier. The
  trade that comes with ingest on Actions:
  - Email is checked roughly hourly, not every five minutes.
  - GitHub can delay scheduled runs by 15–60 minutes when it's busy.
  - Phone is real-time: the Quo webhook writes calls and texts as they happen.
  - **Worker CPU:** measured locally, the UI's requests use ~6–9 ms each (p90s 14–24 ms), and the
    single-call queue ~17 ms. Against Workers Paid's 30 s per invocation that is a cost line, not
    a limit. See HANDOFF, "Worker CPU".
  - Ceilings that still bind: 2,000 Actions minutes a month (private repo; the workflow is capped
    at 1,460 even in the worst case) and 1,200 Cloudflare API requests per 5 minutes.
- **Cloudflare Access for login.** There's no password table. Each person signs in as
  themselves, and the Worker verifies the Access JWT again (signature, expiry, audience,
  email) before trusting it.
- **No AI provider in the critical path.** Ingest and the board run from Gmail, Quo and D1
  only.

The Gmail connector inside Claude is not what this app uses; it only works during a Claude
session. The console has its own Google credentials for Gmail and its own Quo API key, held as
Worker secrets.

## The data model

- **`thread`** is every conversation, whatever the channel. Its status is `waiting`,
  `answered`, `blocked` or `closed`.
- **`action`** holds every human touch. It's append-only: the audit log, and the agent's input
  surface.
- **`response`** holds one row every time a wait on us ends, in business minutes. It's the
  input to the admin report.
- **`ingest_failure`** holds items ingest couldn't sync, including skipped ones.
- **`todo`** covers work that isn't a customer thread.

See `schema.sql`.

### How a thread's state is decided (`src/lib/thread-state.ts`)
- **`conversation_started_at`** is when the conversation began. It never moves.
- **`awaiting_since`** is the oldest inbound message with nothing from us after it. It is NULL
  when we're caught up, and it drives the queue, every age, and response time.
- **A new inbound on a closed thread** reopens it.
- **A new inbound on a blocked thread** moves it back to waiting. `blocked_on` is kept so the
  agent sees what it was stuck on.
- **`blocked_since`** gives blocked threads an age. They sort in their own group below the
  waiting ones.

### Agent actions (`POST /api/actions`)
- A **Replied** or **Called** action always records contact (`last_outbound_at`).
- **The agent's chosen status decides whether the wait is over.** Only "Answered" or "Closed"
  stops the clock. A voicemail logged as "Still needs a reply" keeps it running, and the next
  sync respects that.
- **Closing** always stops the clock, and is recorded in `response` as `closed` so the report
  can exclude it.

### Response time
Measured in business minutes, America/Chicago, Mon–Fri 08:00–17:00 (`src/lib/clock.ts`). Mail
arriving Friday at 16:50 is ten minutes old on Monday morning. The zone is stored by name, so
daylight-saving changes are handled; both transitions are tested.

Every wait is measured, including one that began and ended between two syncs. A reopened thread
produces a second measurement.

## Ingest

- **Gmail** (`src/ingest/gmail.ts`):
  - Authenticates with one Google service account using domain-wide delegation. It
    impersonates each mailbox, with scope `gmail.readonly` only (`src/lib/google-auth.ts`).
    There are no refresh tokens.
  - The hourly Actions run reads the key JSON from the `GOOGLE_SERVICE_ACCOUNT_JSON` Actions
    secret.
  - Reads everything received in the last 30 days, not just the inbox: archived, filtered,
    spam and trash included, excluding only sent, drafts and chats.
    `in:anywhere newer_than:30d -in:sent -in:drafts -in:chats`, with `includeSpamTrash=true`.
  - Incremental: the first run seeds Gmail's `historyId` and backfills the window (up to 150
    threads per run). Later runs read `history.list` and fetch only threads that changed. If
    Gmail no longer has that history, it re-lists the window and re-seeds.
  - Every run stays inside caps (fetches, D1 statements) and a time limit, and leaves the rest
    for the next run.
  - Classifies each thread as customer, bulk or spam (see "The filter").
  - The customer is the sender of the first inbound message. Our replies are identified by
    Gmail's `SENT` label.
  - One bad thread is logged, recorded in `ingest_failure`, and skipped, and the rest sync.
- **Where and when:** `.github/workflows/ingest.yml` runs `scripts/ingest.mjs` every hour at :17,
  and can be run by hand from the Actions tab. Gmail gets the first 45 seconds of a run, Quo runs
  until 80 seconds, and the job times out at 2 minutes. A run that can't read a source fails red;
  items that fail are warnings and are listed on the board.
- **Quo** (`src/ingest/quo.ts`, Quo v1 API):
  - Bounded like Gmail: each run lists up to 5 pages of conversations and reads up to 80, inside
    the same caps and time limit. The first scan reads 30 days back over as many runs as it
    takes.
  - Reads every text and call created since a cursor stored per source, so an inbound that was
    answered before the next poll is still seen.
  - An answered call counts as contact; a missed call is waiting.
  - A conversation that fails 3 times in a row is skipped, so it can't hold the cursor back
    forever. It stays visible in `ingest_failure` and on `GET /api/board`.
  - The source `address` should be the Quo phone-number id (`PN…`).
- **`/hooks/quo`:**
  - Verifies the Standard Webhooks signature described in Quo's 2026-03-30 docs: `webhook-id`,
    `webhook-timestamp` and `webhook-signature`, keyed by a `whsec_…` secret. The replay window
    is 5 minutes.
  - Anything else gets a 401, including Quo's legacy `openphone-signature`.
  - Writes each text and call as it happens (new inbound, our reply, missed and answered calls),
    through the same code as polling, so a thread updates in real time. Repeat deliveries are
    recognised by `webhook-id` and ignored. The hourly poll is the backstop and changes nothing
    the webhook already recorded.
  - It runs as its own Worker, `inhouse-ops-hooks`, because the console sits behind Cloudflare
    Access, which can't exempt one path, and Quo can't sign in.
  - Subscribing it in Quo is a human step, and the last one: `RUNBOOK.md` §5. It is the only
    part of the system that starts collecting on its own, so it goes on once everything else
    works.
  - A rate limit runs inside the Worker, before the body is read: 60 requests per 10 seconds per
    client IP, then 429. The endpoint is public, and on a paid plan unauthenticated requests are
    billed rather than capped. It is a cost guard, not a trust boundary — Cloudflare's WAF can't
    do it here, because rate-limiting rules run on zones and workers.dev is not in one.

## Setup

**Deploying is `RUNBOOK.md`**: the ordered commands and dashboard steps, marked yours or Claude's,
with what can't be undone. Locally:

```bash
npm install
npm run check && npm test && npm run build   # typecheck, tests, dry-run bundles of both Workers
```

Deploying, `wrangler d1 … --remote`, and setting secrets are human steps (CLAUDE.md invariant 1).

## The filter

The rules are in `src/lib/triage.ts`. There's no model in this path. Every thread lands in one of
three tiers, and none of them is ever hidden:
- **Needs reply** (`customer`).
- **Probably not customers** (`bulk`). Triggered by structural bulk-mail signals:
  List-Unsubscribe, Gmail's Promotions/Social categories, Precedence: bulk, no-reply senders.
  The reasons are shown on each row.
- **Spam.** Anything carrying Gmail's spam label. It sits at the bottom with a count, always
  expanded, with the sender and the full subject on every line. Gmail is wrong about some real
  customers, and a terse real customer can't be told from phishing by rule, so a human scans
  it.

Who always counts as a customer, even when Gmail files the mail as spam:
- anyone we've replied to
- a sender an agent marked as real
- a verified customer: a `sender_rule` row seeded at setup (never an address in the code)

**Rescue** (`POST /api/threads/:id/rescue`) changes only the triage verdict, never the clock.
Ingest never overrides a human's verdict.

**Not built yet:**
- a rescue or "not spam" button in the UI
- writing sender rules from the UI

## Prove the sources first

Don't trust an ingest path until its source has been proved in isolation:

```bash
node prove/gmail.mjs support@inhousewellness.com
node prove/quo.mjs                                   # or: node prove/quo.mjs PNxxxx --days 14
node prove/triage.mjs support@inhousewellness.com    # read this one carefully
node prove/ingest-live.mjs support@inhousewellness.com --state ~/Code/secrets/inhouse-ops-live.sqlite
```

- `prove/ingest-live.mjs` runs the real ingest into a local SQLite file outside the repo until
  caught up, then prints counts. Run it again and it's incremental: it shows what the next
  ingest run picks up, and names threads newly moved to Trash.

- `prove/quo.mjs` uses the same v1 calls and waiting/answered rules as ingest.
- `prove/triage.mjs` runs the filter over 30 days of real mail and prints every message with
  its verdict and reasons. When you read it:
  1. A real customer in SPAM or BULK is the only failure that costs money. Scan SPAM by eye.
  2. Newsletters in CUSTOMER are annoying, not dangerous. That's the side we err toward.
  3. If a reason code looks wrong, the rule is wrong, not the email.
  - `SENDER_RULES_FILE` (optional) points at the sender_rule seed outside the repo.

Credentials come from the shell or `.dev.vars` (gitignored):
- **Gmail scripts** need `GOOGLE_SERVICE_ACCOUNT_FILE`, the path to the service-account key.
  Keep the key outside the repo; it is never printed.
- **The Quo script** needs `QUO_API_KEY`. Watch for a trailing `=` lost when copying it.

```bash
GOOGLE_SERVICE_ACCOUNT_FILE=~/Code/secrets/<key>.json node prove/triage.mjs support@inhousewellness.com
```

## Looking at the UI now

The UI only talks to the API; there's no mock data. To run it locally against fabricated data,
use `wrangler dev` with a local D1 (`--local --persist-to <dir>`, schema plus a fabricated seed)
and a dev-only entry that answers Cloudflare Access's certs with a test key. Round 11 did exactly
that (HANDOFF, "Round 11 UI run"). Ages are still wall-clock hours, not business minutes.

## Not done yet

- **Triage wiring, demoted section, rescue button** (see "The filter").
- **Admin report.** `response` holds the data, but there's no report view yet.
- **Process stages.** The `stage` column has no vocabulary yet; it's waiting on the real list.
- **Weekend confirmation.** The clock assumes Saturday and Sunday are fully closed.
- **Chat.** No provider is connected; `src/ingest/chat.ts` normalises whatever we pick.
- **Per-thread authorization.** Any signed-in agent can act on any thread (an accepted gap).

## Chat

Chatra has no live Shopify data, which is exactly the gap you hit. Two real options:

- **Tidio (Lyro)** is a Shopify-native app with live order lookup and product cards. Its AI can
  take actions like checking order status. It's the cheapest way in, with flat-ish pricing.
- **Gorgias** offers deeper Shopify actions (refunds, order edits, tags) from inside chat, and
  unifies email and SMS too. It's priced per AI resolution, which gets expensive as volume
  grows, and it overlaps with what this console already does.

Given the console already owns the unified inbox, Tidio is the better fit. Let it handle the
widget and the AI, and pipe its conversations in here through `src/ingest/chat.ts`, so chat
sits in the same board as everything else.
