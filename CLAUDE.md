# CLAUDE.md — internal support console (inhouse-ops)

Read this, then `HANDOFF.md`, then the latest entry in `RUNLOG.md`, before changing anything.

## What this is

One internal console. The repo is named for where it's hosted: Zaragoza Marketing owns the
subdomain. InHouse Wellness (INH), THI and ZM are meant to become tabs in this same console,
not separate projects. **V1 content is InHouse Wellness customer service only.**

It is one Cloudflare Worker (`src/index.ts`) with a D1 database (`schema.sql`) and a static UI
(`public/index.html`). The Worker serves the UI and `/api/*`, and runs Gmail and Quo ingest
every 5 minutes. No AI provider sits in the critical path.

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
- The secrets are `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKENS` (a JSON map
  of mailbox → token), `QUO_API_KEY` and `QUO_WEBHOOK_SECRET`.
- Refresh tokens printed by `prove/oauth-bootstrap.mjs` must never be pasted into chat, a
  commit, or any file that isn't gitignored.

### 3. `thread.first_inbound_at` is when the conversation began, and never moves
It is written on INSERT only and never updated, by ingest, a rescue, a reopen, or any action.
The response clock does **not** run from it (see invariant 4).
- **Enforced today:** `syncThread()` in `src/db/threads.ts` is the only ingest write path. Its
  UPDATE has no `first_inbound_at` column. `rescueThread()` and `POST /api/actions` don't write
  it either. Tests: `tests/awaiting-since.test.mjs`, `tests/rescue.test.mjs`.
- What "began" means per source:
  - **Gmail:** the thread's first message, which can be ours.
  - **Quo:** the latest activity when the poller first saw the conversation, because the API
    doesn't expose history.
  - **Chat:** the provider's `startedAt`.

### 4. The response clock runs from `awaiting_since`
`thread.awaiting_since` is the oldest inbound message with no outbound after it. It is NULL when
we're caught up. The response clock, queue order, board "oldest" and every UI age run from it,
never from `first_inbound_at`. The rules live once, in `src/lib/thread-state.ts` (pure).
- **Reopen:** a new inbound on a `closed` thread sets status back to `waiting`, sets
  `awaiting_since` to that message's time, and logs a `system` / `reopened` action.
  - "New" means newer than the stored `last_inbound_at`, not newer than `closed_at`. That way a
    message that landed before the agent clicked close, but after the last sync, still reopens
    the thread.
- **Closed with nothing new:** stays `closed`, with `awaiting_since` NULL. Closing through
  `POST /api/actions` also sets it NULL.
- **Held until we reply:** once set, `awaiting_since` holds until an outbound is seen after it.
  A reopened thread can't slide back to a pre-close message on the next sync.
- **Rescue:** rescuing a demoted message (`rescueThread`, `POST /api/threads/:id/rescue`) changes
  `triage` and `triage_by` and logs a `rescued` action, **only**. It never writes
  `first_inbound_at` or `awaiting_since`, so the clock runs from when the customer actually
  wrote. Violating this launders slow responses into good numbers and silently corrupts the
  admin report.
- `responseMinutes(thread, now)` returns null when caught up. It never falls back to
  `first_inbound_at`.

### 5. Triage never deletes or hides mail
It only demotes, and every demotion carries its reason codes through to the UI.
- **Enforced today:** `classify()` in `src/lib/triage.ts` is pure. It returns
  `{ demote, score, signals[{code, why, weight}], exemptReason? }` and has no side effects.
  - A score of 2 or more demotes.
  - Senders in `markedSpam` are always demoted. Senders in `markedReal` and `everRepliedTo` are
    never demoted.
  - Gmail's `CATEGORY_UPDATES` deliberately contributes no signal.
- **Gap:** nothing calls `classify()` yet.
  - `thread.triage_score`, `triage_signals`, `sender_rule` and `known_sender` are never written.
    Only `rescueThread` writes `triage` and `triage_by`.
  - The UI has no demoted section.
  - When this is wired: every thread must still come back from `/api/queue`, demoted ones
    included, with `triage_signals` carried to the UI. No query may filter demoted rows out.
    Ingest must not overwrite a triage verdict a human set (`triage_by` not null). Today
    `syncThread` never writes `triage*`.
- `prove/triage.mjs` holds a hand-copied duplicate of the rules. It has already drifted (no
  `markedSpam` or `markedReal`). `src/lib/triage.ts` is the source of truth.

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
- **`blocked`** always stays blocked. The clock (`awaiting_since`) still runs.
- **`closed`** stays closed unless a new inbound message arrives, which reopens it (invariant 4).
  That is the only automatic change to a human-set status.
- `answered` and `waiting` are **not** protected. Ingest recomputes them from the timeline.
- **Enforced today:** `resolveState()` applies these rules. `syncThread()`'s UPDATE is also
  conditional on the status, `awaiting_since` and `last_inbound_at` it read. If an agent changes
  the thread mid-sync, the write is skipped and the next cron run resolves again.
  - Tests: `tests/awaiting-since.test.mjs` (guards) and `tests/sync-thread.test.mjs` (the race).
- Any new ingest source must go through `syncThread()`.

### 8. Agents are identified individually
Never by a shared or rotating login.
- **Enforced today:** `authenticate()` in `src/index.ts` takes the email from the signed
  Cloudflare Access JWT, and `action.actor` records that email.
- Role is `owner` if the email is in `OWNERS`, otherwise `agent`.
- The Access policy must list individual people. Don't allow a shared mailbox (e.g. a generic
  `agent@` or `support@` login) as a console user.
- **Accepted gap:** there is no per-thread authorization. Any signed-in agent can act on any
  thread or to-do. See HANDOFF.

### 9. Public endpoints trust nothing unsigned
`/hooks/quo` verifies Quo's `openphone-signature` HMAC before reading the body
(`src/lib/quo-signature.ts`).
- It enforces a 5-minute replay window.
- It returns 401 on any failure, and also when `QUO_WEBHOOK_SECRET` is unset (fail closed).
- Tests: `tests/quo-webhook.test.mjs`.
- Any new public webhook needs the same: verify first, fail closed, and test both a valid and an
  invalid signature.

## Layout

```
src/index.ts              Worker: auth (Access JWT), /api routes, /hooks/quo, cron → ingest
src/ingest/gmail.ts       Gmail threads → timeline → syncThread (customer = first inbound sender)
src/ingest/quo.ts         Quo conversations (latest activity only) → syncThread
src/ingest/chat.ts        provider-agnostic chat → syncThread (not routed yet)
src/db/threads.ts         syncThread (conditional write), rescueThread
src/lib/thread-state.ts   status / awaiting_since / reopen rules, responseMinutes (pure)
src/lib/triage.ts         demotion rules (pure)
src/lib/clock.ts          business-minutes clock (pure)
src/lib/quo-signature.ts  Quo webhook HMAC verification
schema.sql                D1 schema + brand seed
public/index.html         UI, mock data until USE_API = true
prove/*.mjs               run-by-hand source proofs; need real credentials
tests/*.test.mjs          node:test suites; tests/helpers has the D1 shim and fake Gmail
```

Source imports use explicit `.ts` extensions (`allowImportingTsExtensions`), so Node can load
`src/` directly in tests. Wrangler bundles them unchanged.

## Working rules

- Read a file before changing it. Describe what the code *does*, not what the README says.
- For a bug: write the failing test first, watch it fail, then fix.
- A test only counts once you've seen it fail against deliberately broken code.
- Don't silence type errors with `any` or `@ts-ignore`.
- Record every round in `RUNLOG.md` and every open question in `HANDOFF.md`.
