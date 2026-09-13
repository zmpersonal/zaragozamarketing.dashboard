# InHouse support console

One internal console, hosted on a Zaragoza Marketing subdomain. InHouse Wellness, THI and ZM
are planned as tabs in it. **V1 scope is InHouse Wellness customer service only:** email and
phone in one place, a queue for the agent, and response-time data for the admin report. Chat
and the THI panel come later.

The rules the code must never break are in `CLAUDE.md`. Open questions and known gaps are in
`HANDOFF.md`, and the history of each round is in `RUNLOG.md`.

## Why this stack

The stack was chosen to be cheap, secure, and still standing if every subscription lapses:

- **Cloudflare Workers + D1 + static assets.** One Worker and one SQLite database. The Worker
  serves the UI, the `/api` routes and `/hooks/quo`, and runs ingest on a 5-minute cron.
  - Cost has not been verified against real volume. Gmail and Quo polling make many
    subrequests per run (see HANDOFF, "Scale and cost").
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
  - The Worker reads the key JSON from the `GOOGLE_SERVICE_ACCOUNT_JSON` secret; Workers have no
    filesystem.
  - Reads the last 30 days of inbox threads per mailbox.
  - The customer is the sender of the first inbound message. Our replies are identified by
    Gmail's `SENT` label.
  - One bad thread is logged, recorded in `ingest_failure`, and skipped, and the rest sync.
- **Quo** (`src/ingest/quo.ts`, Quo v1 API):
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
  - It verifies and logs events, but doesn't ingest them yet. Polling is the backstop.

## Setup

```bash
npm install
npm run check && npm test && npm run build   # typecheck, tests, local dry-run bundle

npx wrangler login
npx wrangler d1 create inhouse-ops          # paste the id into wrangler.toml
npx wrangler d1 execute inhouse-ops --file=./schema.sql --remote

npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON < /path/outside/the/repo/key.json
npx wrangler secret put QUO_API_KEY
npx wrangler secret put QUO_WEBHOOK_SECRET      # whsec_... from POST https://api.quo.com/webhooks
                                                 # with header Quo-Api-Version: 2026-03-30

npx wrangler deploy
```

**Deploying, running `d1 … --remote`, and setting secrets are human steps.** See CLAUDE.md
invariant 1.

After deploying:
1. **Cloudflare Access.** In the Cloudflare dashboard, go to Zero Trust → Access and add a
   self-hosted application over the Worker's hostname. Allow each person's individual email
   (never a shared login). Copy the audience tag into `ACCESS_AUD` and the team name into
   `ACCESS_TEAM`.
2. **Register each mailbox and phone line as a source:**

```sql
INSERT INTO source (id, brand_id, channel, provider, address) VALUES
  ('gmail:support@inhousewellness.com', 'inhouse', 'email', 'gmail', 'support@inhousewellness.com'),
  ('quo:PNxxxxxxxx',                    'inhouse', 'phone', 'quo',   'PNxxxxxxxx');
```

Once a database has real rows, schema changes need `wrangler d1 migrations`, because
`schema.sql` only creates tables that don't exist yet.

## The filter

support@ takes 10–20 messages a day and roughly 2 are real. The rules that sort them are in
`src/lib/triage.ts`. They're structural facts about each message: List-Unsubscribe, Gmail's
Promotions/Social categories, Precedence: bulk, no-reply senders. There's no model in this
path.

Two rules matter more than the list:
- **Nothing is hidden.** A demoted message is only moved below the fold, with its reasons shown.
- **Anyone we've replied to is exempt**, so a repeat customer whose signature carries an
  unsubscribe footer never falls off the list.

**Not wired in yet:**
- Ingest doesn't call the filter.
- The UI has no demoted section or rescue button.
- The "mark as not a customer or spam" sender rules aren't written anywhere.

What exists today is the tested rules and `POST /api/threads/:id/rescue`, which changes only the
triage verdict and never the clock.

## Prove the sources first

Don't trust an ingest path until its source has been proved in isolation:

```bash
node prove/gmail.mjs support@inhousewellness.com
node prove/quo.mjs                                   # or: node prove/quo.mjs PNxxxx --days 14
node prove/triage.mjs support@inhousewellness.com    # read this one carefully
```

- `prove/quo.mjs` uses the same v1 calls and waiting/answered rules as ingest.
- `prove/triage.mjs` runs the filter over 30 days of real mail and prints every message with
  its verdict and reasons. When you read it:
  1. Any real customer in DEMOTED is the only failure that costs money. It should be zero.
  2. Newsletters in KEPT are annoying, not dangerous. That's the side we err toward.
  3. If a demote reason looks wrong, the rule is wrong, not the email.

Credentials come from the shell or `.dev.vars` (gitignored):
- **Gmail scripts** need `GOOGLE_SERVICE_ACCOUNT_FILE`, the path to the service-account key.
  Keep the key outside the repo; it is never printed.
- **The Quo script** needs `QUO_API_KEY`. Watch for a trailing `=` lost when copying it.

```bash
GOOGLE_SERVICE_ACCOUNT_FILE=~/Code/secrets/<key>.json node prove/triage.mjs support@inhousewellness.com
```

## Looking at the UI now

`public/index.html` runs standalone on mock data: open it in a browser, with no build step.

Flip `USE_API = true` at the top of the script once D1 is seeded. Ages are still shown in
wall-clock hours rather than business minutes (see HANDOFF).

## Not done yet

- **Triage wiring, demoted section, rescue button** (see "The filter").
- **Admin report.** `response` holds the data, but there's no report view yet.
- **Webhook ingest.** `/hooks/quo` verifies deliveries but doesn't write them, and doesn't
  deduplicate by `webhook-id` yet.
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
