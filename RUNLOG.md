# RUNLOG

One entry per round, newest first. Each entry covers what changed, what was proved, and what is
still unproven.

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
