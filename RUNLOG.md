# RUNLOG

One entry per round, newest first. Each entry covers what changed, what was proved, and what is
still unproven.

---

## Round 2 — correctness (2026-09-13, branch `claude/inh-round-2`, cut from `claude/inh-round-1`)

Nothing was deployed, merged, pushed, or PR'd. The repo now lives at
`~/Code/zaragozamarketing.dashboard`. The Desktop-level THI Autoposter CLAUDE.md no longer loads
into sessions here (round-1 open question 4 is moot).

Each bug was fixed test-first: write the test, watch it fail, fix, watch it pass.

### What changed
1. **Prep, `12e7e06`.** Source imports use explicit `.ts` extensions
   (`allowImportingTsExtensions`), so Node can load `src/index.ts` and the ingest modules in
   tests. Added `tests/helpers/d1.mjs`, which runs the real `schema.sql` on `node:sqlite` behind
   the D1 surface the code uses. No behaviour change.
2. **Clock, `2e2c59a`.** `businessMinutes()` hung across the March DST change. It now steps one
   local calendar date at a time; see "Clock approach" below.
3. **Gmail customer, `37a8523`.** The customer came from the newest message's From, which could
   be our reply or a cc'd colleague. It now comes from the first inbound message and is refreshed
   on every sync. Direction now uses Gmail's `SENT` label or an exact address match, replacing a
   substring match that treated send-as alias replies as inbound. Threads with no inbound message
   are skipped.
4. **`awaiting_since` and reopen, `8957487`.**
   - Added `thread.awaiting_since`.
   - The state rules live in `src/lib/thread-state.ts`. All three ingest paths now write through
     `src/db/threads.ts:syncThread`, whose UPDATE is conditional on the row it read.
   - Added `rescueThread` and `POST /api/threads/:id/rescue`.
   - Board, queue and UI ages now use `awaiting_since`. Closing via actions nulls it.
   - Updated the `schema.sql` index and comments.
5. **Quo webhook, `642c7b4`.** `/hooks/quo` verifies the `openphone-signature` HMAC as described
   in Quo's docs (support.quo.com/core-concepts/integrations/webhooks), with a 5-minute replay
   window. It returns 401 otherwise, and fails closed without `QUO_WEBHOOK_SECRET`. The new
   secret name is added to `wrangler.toml` comments.
6. **Docs.** CLAUDE.md invariants rewritten (now 9), plus this entry and HANDOFF.

### Clock approach
- **The old loop's cursor was an instant.** It stepped `dayStart + 26h`, then snapped back by the
  wall-clock minute of day. On 2027-03-14, 02:00 local doesn't exist, so from Sat 00:00 CST the
  overshoot lands Sun 03:00 CDT. The snap-back subtracts 3 real hours and lands on Sat 23:00, so
  the cursor never leaves Saturday.
- **The new cursor is a local calendar date,** advanced with `Date.UTC(y, m-1, d+1)`. That is
  pure calendar arithmetic, with no time zone and no DST, so each iteration is exactly one local
  day however many seconds it holds. There is no loop counter or cap: termination follows from
  the date strictly increasing until its local midnight reaches `to`.
- **Instants are resolved per day.** A two-pass offset lookup turns that day's 00:00, 08:00 and
  17:00 wall times into instants. Those times always exist in Chicago, whose changes happen at
  02:00. The weekday comes from the calendar date, not the zone.
- **Minor fixes in the same change:** `hourCycle: 'h23'` replaces `hour12: false`, and seconds
  are carried.

### What was proved (failing first, then passing)

| Bug | Before fix | After fix |
|---|---|---|
| 1 clock | 7 tests: 5 pass, **2 fail**. March crossing and the 21-week span both hit `did not return within 3000ms`; November passed. | 7/7 |
| 2 customer | 4 tests: **0 pass, 4 fail**. Stored `'InHouse Support'`, `support@inhousewellness.com`, `'Sam Ortiz'` (cc'd colleague), `julian@inhousewellness.com` (alias). | 4/4 |
| 3 awaiting/reopen/rescue | 11: **0 pass, 11 fail**. 10 on assertions (`awaiting_since` undefined; closed stayed `'closed'`); `rescue.test.mjs` failed to load, since `src/db/threads.ts` didn't exist. | 16/16, with reopen-hold and mid-sync race tests added |
| 4 webhook | 9 tests: 2 pass (valid signatures), **7 fail** with `200 !== 401` | 9/9 |

- **Totals:** 40 tests, 40 pass, 0 fail. `npm run check` and `npm run build` are clean.
- **Deliberate breaks, run in scratch copies (the repo was never modified):**
  - Bug 3: 13 breaks, all caught by their target test. Among them: rescue moving either
    timestamp, `responseMinutes` falling back to `first_inbound_at`, no reopen, a closed-at-style
    cutoff, reopen over the whole thread, no hold, unprotected blocked, newest-unanswered, UPDATE
    moving `first_inbound_at`, unconditional UPDATE, reopen unlogged, and always-reopen.
    Controls passed 31/31, then 40/40.
  - Bug 4: 8 breaks, all caught (replay window, compact form, raw key bytes, timestamp binding,
    always-true, fail-open).
  - One timestamp break was initially a no-op on my side. It was redone correctly and was caught.
- **Clock oracle:** 320 random spans around both DST changes, year-end and midsummer, compared
  against a brute-force 10-minute `isOpen` count. 0 mismatches.
- **UI:** `public/index.html` rendered with no console errors. Ages come from `awaiting_since`,
  and threads not awaiting us show "—" and sort last.

### Still unproven
- The Quo signature against a real delivery. The docs' Node and Python samples disagree on key
  encoding; see HANDOFF.
- D1 itself: tests run on `node:sqlite`.
- The HTTP routes behind Access (actions close → `awaiting_since` NULL, `/rescue`). There's no
  JWT test harness yet.
- Everything that needs credentials (Gmail, Quo, OAuth), as in round 1.

---

## Round 1 — foundations (2026-09-13, branch `claude/inh-round-1`)

Nothing was deployed, merged, pushed, or PR'd.

### What changed
- `2edebbc`: baseline commit of `inhouse-ops.zip`, exactly as delivered (15 files). Everything
  below is diffable against it.
- `.gitignore`: added `.DS_Store` and `dist/`. It already covered `node_modules/`, `.dev.vars`,
  `.env` and `.wrangler/`.
- `package.json`:
  - Added the `build`, `check`, `test`, `prove:triage` and `prove:oauth` scripts.
  - Dev dependencies are now installed, with `package-lock.json` committed.
  - Version change: the baseline pinned `@cloudflare/workers-types@^4.20260801.0`, which doesn't
    exist on npm, so `npm install` failed. The package moved to major 5, and
    `wrangler@4.131.1` declares `@cloudflare/workers-types@^5.20260911.1` as a peer. Installed
    `@cloudflare/workers-types@^5.20260911.1` and `wrangler@^4.131.1`.
  - TypeScript stays on the baseline's 5.x line (`^5.9.3`). npm `latest` is 7.0.2; not adopted.
- `tsconfig.json`: strict, `noEmit`, Bundler resolution, `types: ["@cloudflare/workers-types"]`,
  covering `src/**/*.ts`.
- `tests/triage.test.mjs` (5 cases) and `tests/clock.test.mjs` (5 cases): the owner's
  hand-verified cases, run with `node:test` and no extra dependency.
- `prove/oauth-bootstrap.mjs`:
  - Desktop-app OAuth flow on a loopback listener, with PKCE and `state`.
  - Scope is gmail.readonly only, and the script refuses a broader grant.
  - Confirms the mailbox through the Gmail profile, then prints the refresh token once.
  - **Not run**, because no credentials exist yet.
- `CLAUDE.md`, `RUNLOG.md`, `HANDOFF.md`: new.
- No application code in `src/`, `public/` or `schema.sql` was changed.

### What was proved
- **Extraction:** all 15 zip entries were present at their zip paths.
- **`npm run check`:** clean. It reports 0 type errors in `src/` under `strict`.
  - I confirmed the check is real: `--listFilesOnly` shows all 6 `src` files, the Workers types
    resolve, and a deliberately wrong probe file fails with TS2322.
  - Caveat: `src/ingest/*.ts` types every Gmail and Quo payload as `any`, so those paths are not
    meaningfully typechecked.
- **`npm run build`:** clean. The `wrangler deploy --dry-run` bundle is ~12.5 KiB, and wrangler
  lists the DB, ASSETS and three var bindings.
- **`npm test`:** 10 passed, 0 failed.
- **Every test bites.** 11 mutations were run, each against a scratch copy of `src/`+`tests/`
  (the repo was never modified). Every mutation failed its target test, and the unmodified
  control copy passed 10/10.

  | Mutation | Target test |
  |---|---|
  | demote threshold `>= 2` → `>= 0` | plain customer email → not demoted |
  | no-reply regex never matches | noreply@shopify.com + Updates → demoted on noreply |
  | Updates given a weight-2 signal | noreply@shopify.com + Updates → demoted on noreply, **not** on Updates |
  | demote threshold `>= 2` → `>= 5` | newsletter List-Unsubscribe + Promotions → demoted |
  | everRepliedTo exemption removed | everRepliedTo sender → not demoted |
  | Updates given a weight-2 signal | Updates alone → not demoted |
  | open 08:00 → 10:00 | Tue 09:00→11:30 = 150 |
  | Sat+Sun counted as workdays | Fri 16:50→Mon 08:10 = 20 |
  | Saturday counted as workday | Sat 10:00→15:00 = 0 |
  | close 17:00 → 18:00 | Tue 16:00→Wed 09:00 = 120 |
  | `Etc/GMT+5` fixed offset instead of `America/Chicago` | November DST span = 120 (the **only** test that catches it) |

### Found, not fixed (out of scope this round; see HANDOFF)
- `businessMinutes()` never returns for a span that crosses the March DST change. I reproduced
  this: the process was still running after 8s.

### Still unproven
- Gmail, Quo, and OAuth against real accounts. No credentials exist yet, and none of the
  `prove/` scripts has been run.
- The ingest upserts, including the blocked/closed guard, have never run against D1.
- Access JWT verification has never seen a real token.
- `wrangler dev` wasn't tried. npm 11's `allowScripts` skipped the `esbuild` and `workerd`
  postinstall scripts. `build` works without them; `dev` is untested.
- The UI has only rendered mock data, and wasn't opened this round.
