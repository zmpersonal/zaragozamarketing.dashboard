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
| `npm test` | Runs `tests/*.test.mjs` with `node:test`. Node strips the types from the `.ts` imports, so no build step is needed. |
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
  of mailbox → token) and `QUO_API_KEY`.
- Refresh tokens printed by `prove/oauth-bootstrap.mjs` must never be pasted into chat, a
  commit, or any file that isn't gitignored.

### 3. `thread.first_inbound_at` is when the message arrived
It is **always** arrival time. It is never the moment a demoted message was rescued into the
queue. Violating this launders slow responses into good numbers and silently corrupts the
admin report.
- **Enforced today:** every ingest upsert (`src/ingest/gmail.ts`, `quo.ts`, `chat.ts`) sets it
  on INSERT only. None of the `ON CONFLICT DO UPDATE` clauses touch it, and `POST /api/actions`
  doesn't write it.
- **Rule for future code:** a rescue or re-triage path (for example, marking a demoted message
  as a customer) may change `triage*` columns only. It must never write `first_inbound_at`. No
  such path exists yet.
- **Known inaccuracy (see HANDOFF):** the value written on INSERT isn't always the first
  *inbound* message. Gmail uses the thread's first message, which may be ours. Quo uses the
  conversation's latest activity time at first sight.

### 4. Triage never deletes or hides mail
It only demotes, and every demotion carries its reason codes through to the UI.
- **Enforced today:** `classify()` in `src/lib/triage.ts` is pure. It returns
  `{ demote, score, signals[{code, why, weight}], exemptReason? }` and has no side effects.
  - A score of 2 or more demotes.
  - Senders in `markedSpam` are always demoted. Senders in `markedReal` and `everRepliedTo` are
    never demoted.
  - Gmail's `CATEGORY_UPDATES` deliberately contributes no signal.
- **Gap:** nothing calls `classify()` yet.
  - The columns `thread.triage`, `triage_score`, `triage_signals` and `triage_by`, and the
    tables `sender_rule` and `known_sender`, are never read or written.
  - The UI has no demoted section.
  - When this is wired: every thread must still come back from `/api/queue`, demoted ones
    included, with `triage_signals` carried to the UI. No query may filter demoted rows out.
    Ingest must not overwrite a triage verdict a human set (`triage_by` not null).
- `prove/triage.mjs` holds a hand-copied duplicate of the rules. It has already drifted (no
  `markedSpam` or `markedReal`). `src/lib/triage.ts` is the source of truth.

### 5. Response time is business minutes only
Business time is America/Chicago, Mon–Fri 08:00–17:00. Never wall-clock.
- **Enforced today:** `businessMinutes()` in `src/lib/clock.ts` walks day by day, using
  `Intl.DateTimeFormat` with the IANA zone rather than a stored offset. `tests/clock.test.mjs`
  pins the hand-verified cases, including the November DST change.
- **Gap:** nothing outside `clock.ts` calls it.
  - `thread.first_response_mins` is never written.
  - The UI (`public/index.html`) computes every age, the "Over 24h" filter and the heat colours
    from wall-clock `Date.now()` hours. That violates this rule, and it has to change before
    the admin report exists.
- **Known bug (see HANDOFF):** a span that crosses the **March** spring-forward weekend never
  returns (infinite loop).

### 6. Ingest never overwrites a status a human set (`blocked` or `closed`)
- **Enforced today:** all three ingest upserts use
  `status = CASE WHEN thread.status IN ('blocked','closed') THEN thread.status ELSE excluded.status END`.
  This is not covered by tests yet, because it needs D1.
- Any new ingest source must use the same guard.
- `answered` and `waiting` are **not** protected. Ingest recomputes them from the direction of
  the last message.

### 7. Agents are identified individually
Never by a shared or rotating login.
- **Enforced today:** `authenticate()` in `src/index.ts` takes the email from the signed
  Cloudflare Access JWT, and `action.actor` records that email.
- Role is `owner` if the email is in `OWNERS`, otherwise `agent`.
- The Access policy must list individual people. Don't allow a shared mailbox (e.g. a generic
  `agent@` or `support@` login) as a console user.

## Layout

```
src/index.ts          Worker: auth (Access JWT), /api routes, cron → ingest
src/ingest/gmail.ts   Gmail threads → thread rows (last-message direction decides waiting/answered)
src/ingest/quo.ts     Quo conversations → thread rows
src/ingest/chat.ts    provider-agnostic chat upsert (not routed yet)
src/lib/triage.ts     demotion rules (pure)
src/lib/clock.ts      business-minutes clock (pure)
schema.sql            D1 schema + brand seed
public/index.html     UI, mock data until USE_API = true
prove/*.mjs           run-by-hand source proofs; need real credentials
tests/*.test.mjs      node:test suites for the pure libs
```

## Working rules

- Read a file before changing it. Describe what the code *does*, not what the README says.
- A test only counts once you've seen it fail against deliberately broken code.
- Don't silence type errors with `any` or `@ts-ignore`.
- Record every round in `RUNLOG.md` and every open question in `HANDOFF.md`.
