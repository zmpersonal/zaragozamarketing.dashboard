# Deploy runbook: from `claude/inh-round-13` to Marianne logging in

Written in round 11, reordered in round 12, rate limit settled in round 13. **Nothing here has
been run.** Every step is marked **[YOU]** (Julian and the owner, with the Cloudflare, GitHub,
Google and Quo accounts) or **[CLAUDE]**. Steps marked **IRREVERSIBLE** can't simply be undone;
read the note before running them.

What gets deployed:

| Piece | Where | Protected by |
|---|---|---|
| `inhouse-ops`: dashboard and `/api/*` | Cloudflare Worker, `inhouse-ops.<subdomain>.workers.dev` | Cloudflare Access (Worker-level) |
| `inhouse-ops-hooks`: `/hooks/quo` only | Cloudflare Worker, `inhouse-ops-hooks.<subdomain>.workers.dev` | Quo's webhook signature (no Access: Quo can't sign in), with a rate limit inside the Worker |
| D1 database `inhouse-ops` (`4f562bdf-…`) | Cloudflare D1 | Bound to both Workers; written by the Actions run over the REST API |
| Hourly ingest (Gmail, Quo backstop) | GitHub Actions, `.github/workflows/ingest.yml` | Actions secrets |

Why two Workers: Access on a Worker covers every hostname and path it serves, and its bypass is
whole-Worker only (developers.cloudflare.com/workers/configuration/cloudflare-access). A webhook on
the console Worker would be blocked for Quo the moment Access is on.

**Why this order** (changed in round 12; the original order had both of these backwards):
- **The lock goes on before the data.** The console is deployed and Access is verified against a
  database that holds no customer data. If the policy is wrong, you find out when there is nothing
  to see.
- **The Quo webhook goes last.** It is the one step that starts collecting on its own, whether or
  not anyone is watching. Everything else — Access, the data, email ingest — is working before it
  is switched on, so there is no window where phone is flowing into a console nobody can use.

Placeholders used below: `<subdomain>` is the account's workers.dev subdomain; `PN…` is the Quo
phone-number id; `<team>` is the Zero Trust team name. Nothing here needs a domain on Cloudflare:
both Workers run on workers.dev.

---

## 0. Before you start

1. **[YOU]** `cd` into a checkout of `claude/inh-round-13` and run
   `npm install && npm run check && npm test && npm run build`. All must pass (325 tests, round 13).
2. **[YOU]** `npx wrangler login` and choose the account `0ef0279e4af302865cd2009458864c1b`.
   Confirm with `npx wrangler whoami`.
3. **[YOU]** Confirm the database exists and the id matches `wrangler.toml`:
   `npx wrangler d1 list`. If it doesn't exist, stop and tell Claude: creating it gives a new id.
4. **[YOU]** Cloudflare dashboard → **Workers & Pages**: if the account has no workers.dev
   subdomain yet, choose one now. Note it as `<subdomain>`. Changing it later changes both URLs.
5. **[YOU]** Local key hygiene: `chmod 600 ~/Code/secrets/*`. The service-account key was mode 644.
6. **[YOU]** Get the Quo phone-number id. Quiet mode prints the ids and nothing else:
   ```bash
   QUO_API_KEY=… node prove/quo.mjs --quiet
   ```
   - It reads one endpoint, `/v1/phone-numbers`, and no conversation.
   - The full `node prove/quo.mjs` prints customer names, numbers and message text to the terminal.
     Run it only if you want to prove the source by eye, and not on a shared screen.

## 1. The database, structure only

Run from the repo root. This writes to the production database, and puts no customer data in it:
`schema.sql` creates tables and seeds the brand rows.

1. **[YOU] IRREVERSIBLE (this becomes the production database):** load the schema. Safe to re-run:
   every table is `CREATE TABLE IF NOT EXISTS`.
   ```bash
   npx wrangler d1 execute inhouse-ops --remote --file=./schema.sql
   ```
2. **[YOU]** Check it is empty:
   ```bash
   npx wrangler d1 execute inhouse-ops --remote --command "SELECT (SELECT COUNT(*) FROM brand) AS brands, (SELECT COUNT(*) FROM source) AS sources, (SELECT COUNT(*) FROM thread) AS threads, (SELECT COUNT(*) FROM sender_rule) AS rules, (SELECT COUNT(*) FROM known_sender) AS known"
   ```
   Expect the brand seed and zeros everywhere else. Nothing else goes in until §3, on purpose.

From here, schema changes need `wrangler d1 migrations`: `schema.sql` only creates missing tables.

## 2. The console Worker, behind Access, verified empty

1. **[YOU]** Deploy it: `npx wrangler deploy`.
   - Until step 4, `ACCESS_AUD` is `CHANGE_ME`, so every `/api` request is refused (401) and no data
     is served. The page shell itself (HTML, no data) is public for these few minutes.
   - The database holds no customer data yet. That is why this section comes before §3.
2. **[YOU]** Dashboard → **Workers & Pages** → `inhouse-ops` → **Settings** → **Domains & Routes** →
   `workers.dev` → **Enable Cloudflare Access**.
   - If asked to set up Zero Trust, choose a team name (this is `<team>`) and the Free plan.
3. **[YOU]** **Manage Cloudflare Access** → the policy named `inhouse-ops - Production`:
   - **Include → Emails**: each person by their own address (Marianne's, Julian's, the owner's).
   - **Never** a shared inbox such as support@ (CLAUDE.md invariant 8).
   - **Never** an "Everyone" or "Emails ending in" include. A wrong include here is the one
     misconfiguration in this runbook that would put the whole queue on the public internet.
   - Login method: the default One-time PIN emails a code to that address.
4. **[YOU]** From the Access application for `inhouse-ops`, copy:
   - the **Application Audience (AUD) Tag**
   - the **team domain** `<team>.cloudflareaccess.com`
   Then **[CLAUDE or YOU]** set them in `wrangler.toml`, commit them on the branch (not secrets), and
   redeploy:
   ```toml
   ACCESS_TEAM = "<team>"            # only the part before .cloudflareaccess.com
   ACCESS_AUD  = "<AUD tag>"
   OWNERS      = "julian@…, owner@…" # who gets the owner view; everyone else is an agent
   ```
   ```bash
   npx wrangler deploy
   ```
5. **[YOU]** Verify the lock, now, while there is nothing behind it:
   - A private window on `https://inhouse-ops.<subdomain>.workers.dev` must show the Access login.
   - Sign in as yourself: you should reach the console.
   - An address **not** in the policy must be refused. Try one.
   - No cookie, no data:
     `curl -s -o /dev/null -w "%{http_code}\n" https://inhouse-ops.<subdomain>.workers.dev/api/board`
     must be a redirect to the Access login or a 401 — never 200 with JSON.
6. **[YOU]** What the empty console should look like. Each of these is the code telling the truth;
   none of them is a bug:
   - "No sources are set up, so no mail or calls can arrive."
   - every brand × channel cell "not connected", none of them "clear"
   - no sync badges yet, because there are no sources
   If instead you see a calm green "Nothing waiting", stop: that breaks CLAUDE.md invariant 11 and
   Claude needs to know.

## 3. Customer data into the database

Only now does anything personal leave this machine. Each command below writes to production.

1. **[YOU] IRREVERSIBLE:** register the sources (replace `PN…` with the id from step 0.6):
   ```bash
   npx wrangler d1 execute inhouse-ops --remote --command "INSERT OR IGNORE INTO source (id, brand_id, channel, provider, address) VALUES ('gmail:support@inhousewellness.com','inhouse','email','gmail','support@inhousewellness.com'), ('quo:PN…','inhouse','phone','quo','PN…');"
   ```
2. **[YOU] IRREVERSIBLE (first customer data):** verified customers, from the sender-rule seed kept
   outside the repo:
   ```bash
   npx wrangler d1 execute inhouse-ops --remote --file=$HOME/Code/secrets/inhouse-ops-sender-rules.sql
   ```
3. **[YOU] IRREVERSIBLE:** known senders, with our own domain filtered out. Regenerate the filtered
   file first; it's repeatable and idempotent.
   ```bash
   node prove/apply-known-senders.mjs --in ~/Code/secrets/inhouse-ops-known-senders.sql \
     --out ~/Code/secrets/inhouse-ops-known-senders.filtered.sql
   npx wrangler d1 execute inhouse-ops --remote --file=$HOME/Code/secrets/inhouse-ops-known-senders.filtered.sql
   ```
4. **[YOU]** Check it:
   ```bash
   npx wrangler d1 execute inhouse-ops --remote --command "SELECT (SELECT COUNT(*) FROM source) AS sources, (SELECT COUNT(*) FROM sender_rule) AS rules, (SELECT COUNT(*) FROM known_sender) AS known"
   ```
   Expect 2 sources, your rule count, and ~715 known senders.
5. **[YOU]** Reload the console. Both sources now say **never synced** (red), and the brand cells
   say "not verified". Correct until §4.

## 4. GitHub: secrets, the history scan, then `main`

1. **[YOU]** Add the Actions secrets (GitHub → repo → Settings → Secrets and variables → Actions,
   or `gh secret set`):
   ```bash
   gh secret set GOOGLE_SERVICE_ACCOUNT_JSON < ~/Code/secrets/inhouse-ops-3bd30d8e136e.json
   gh secret set QUO_API_KEY                  # paste; watch for a lost trailing "="
   gh secret set CLOUDFLARE_API_TOKEN         # a token scoped to Account → D1 → Edit, nothing else
   gh secret set CLOUDFLARE_ACCOUNT_ID --body 0ef0279e4af302865cd2009458864c1b
   gh secret set CLOUDFLARE_D1_DATABASE_ID --body 4f562bdf-560b-4c82-a84e-554aa8c2bcb7
   ```
2. **[YOU] BLOCKING — scan the history before publishing it.** A push publishes every commit, not
   the working tree. Round 7 purged a customer address from this branch; this is the check that it
   stayed purged.
   ```bash
   git branch -D claude/inh-round-5 claude/inh-round-6   # if they still exist anywhere: they held a customer address
   git branch --list 'claude/inh-round-*'                # confirm 5 and 6 are gone
   node scripts/scan-history.mjs claude/inh-round-13
   ```
   - It must print **CLEAN**. It reads every blob, commit message and author line reachable from
     that branch, and names where a match is, never what it found.
   - **If it fails, do not push.** Stop and tell Claude. Rewriting published history is much worse
     than rewriting unpublished history.
   - `git ls-remote origin` should list nothing: the repository is still empty, so step 3 is the
     first publication.
3. **[YOU] IRREVERSIBLE (first push):** put this branch on GitHub as `main`.
   - Push only this branch.
   ```bash
   git push origin claude/inh-round-13:refs/heads/main
   ```
   Then GitHub → Settings → General → **Default branch** = `main`. The hourly schedule only runs
   from the default branch.
   - Undoing it means rewriting or deleting the remote branch, after anyone may already have cloned it.
4. **[YOU] IRREVERSIBLE (hourly production writes begin):** GitHub → **Actions** → **Ingest** → enable
   if prompted → **Run workflow**.
   - Wait for green. The log shows `ingest gmail: processed …` and `ingest quo: processed …`, and
     never a secret.
   - A red run names the source that failed.
   - The first runs work through the 30-day backlog, about 45 email threads per run.
5. **[YOU]** Reload the console. Email should say **synced just now**, and threads should appear,
   in three sections. Phone stays red until §5: Quo polling only registers a sync once the poll
   runs, and there may be nothing in its window.
   - Read the Spam section by eye once. A real customer filed there is the only triage mistake
     that costs money.

## 5. The webhook Worker, its rate limit, and the Quo subscription

1. **[YOU]** Deploy it: `npx wrangler deploy -c wrangler.hooks.toml`.
   - Check: `curl -s -o /dev/null -w "%{http_code}\n" https://inhouse-ops-hooks.<subdomain>.workers.dev/`
     → `404`.
   - And `curl -s -X POST https://inhouse-ops-hooks.<subdomain>.workers.dev/hooks/quo -d '{}'` →
     `401`: no secret yet, fails closed.
2. **[YOU]** Check the rate limit, which that deploy just created. Nothing to configure: the
   `[[ratelimits]]` binding in `wrangler.hooks.toml` is part of the Worker (60 requests per 10
   seconds per client IP). The endpoint is public and unauthenticated by design, and verifying a
   delivery means reading the whole body and running an HMAC over it, so this is what stops a
   stranger spending our money.

   Send 200 unsigned POSTs, ten at a time, so they land inside one 10-second window:
   ```bash
   seq 1 200 | xargs -P 10 -I{} curl -s -o /dev/null -w "%{http_code}\n" \
     -X POST -d '{}' https://inhouse-ops-hooks.<subdomain>.workers.dev/hooks/quo | sort | uniq -c
   ```
   - Expect a mix: some `401` (under the limit, so the signature was checked and refused) and the
     rest `429`. The split won't be exactly 60/140 — the count is per Cloudflare location.
   - Wait ten seconds, POST once more, and it is a `401` again.
   - All `401` and no `429` means the binding didn't deploy. Tell Claude; don't carry on with an
     unlimited public endpoint.
   - This costs 200 Worker invocations, a fraction of a cent.
   - Blocking Quo by accident is safe: Quo retries a failed delivery for about 27.5 hours, and the
     `webhook-id` dedupe makes a retry a no-op if the first one did land. Real Quo traffic is a few
     events a minute at most, some fifty times below the limit.
   - This is a cost guard, not a security control. It is permissive and eventually consistent, and
     counted per Cloudflare location rather than globally, so the real ceiling is higher than 60.
     What keeps the database safe is the signature, which nothing gets past.
3. **[YOU] IRREVERSIBLE (real customer events start flowing):** create the Quo webhook, and pipe its
   signing key straight into the Worker secret so it never lands on screen or disk.
   ```bash
   curl -sS https://api.quo.com/webhooks \
     -H "Authorization: $QUO_API_KEY" -H "Quo-Api-Version: 2026-03-30" -H "Content-Type: application/json" \
     -d '{"url":"https://inhouse-ops-hooks.<subdomain>.workers.dev/hooks/quo","label":"inhouse-ops","resourceIds":["PN…"],"events":["message.received","message.delivered","message.undelivered","message.failed","call.completed","call.missed"]}' \
     | tee >(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s).data;console.error("webhook id:",d.id)})' >/dev/null) \
     | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).data.key))' \
     | npx wrangler secret put QUO_WEBHOOK_SECRET -c wrangler.hooks.toml
   ```
   Note the printed webhook id. It can be deleted later with `DELETE /webhooks/{id}`, but every event
   it has already delivered is in the database.
4. **[YOU]** Test the signature: `POST https://api.quo.com/webhooks/<id>/events/test` with body
   `{"eventType":"message.received"}`, same headers.
   - Quo's delivery log should show **200**. The sample event's phone number isn't ours, so it's
     acknowledged and ignored.
   - A **401** means the secret didn't take.
5. **[YOU]** Test for real: text the Quo number from a phone. Within seconds, a Needs-reply phone
   thread should appear in the console, before any hourly run.

## 6. Marianne logs in

1. **[YOU]** Make sure her own address is in the `inhouse-ops - Production` policy (step 2.3).
2. **[YOU]** Send her `https://inhouse-ops.<subdomain>.workers.dev`. She enters her address, gets a
   one-time PIN by email, and lands on **My queue** as an agent (unless she's in `OWNERS`).
3. **[YOU]** What she should see:
   - both sources **synced N min ago**, not red
   - Needs reply, Probably not customers and Spam, each with a count
   - a text to the Quo number appearing within seconds

## 7. The first day

- **[YOU] Freshness badge:**
  - It turns amber past 3 hours and red past 12. That's how a stopped schedule, expired token, quota
    or API change shows up; the keepalive can't be verified.
  - If it goes red, open the Actions tab first.
- **[YOU] Worker CPU:**
  - Workers → `inhouse-ops` → **Observability**: check CPU time per request.
  - Round 11 measured the UI's requests locally at ~6–9 ms each, with p90s of 14–24 ms. On Workers
    Paid the ceiling is 30 s per invocation, so these are a cost line, not a failure line, and
    error 1102 is no longer expected. If you ever see one, tell Claude.
- **[YOU] Hooks Worker:** check its request count, and how many answers are `429`. Requests that
  are not from Quo are unsigned, rejected, and still billed; the limit (§5.2) keeps what one
  address can spend small, but it counts per Cloudflare location, so a spread-out flood costs more
  than 60 per 10 seconds would suggest. A count far above Quo's own traffic with no `429`s means
  the limit isn't running. Steady `429`s with phone still arriving is the limit doing its job.
- **[YOU] D1 usage:** Cloudflare dashboard → D1 → `inhouse-ops` → Metrics. Workers Paid includes
  25 billion rows read and 50 million written a month; this workload is nowhere near either.
- **[YOU] Batch atomicity (optional, settles a HANDOFF question):**
  `CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_D1_DATABASE_ID=… node prove/d1-batch-atomicity.mjs`
  - It uses a scratch table and drops it afterwards.
  - Either answer is safe: thread writes don't depend on batch atomicity.

## What can't be undone, in one place

| Step | Why it's one-way |
|---|---|
| 1.1 loading the schema | Rows can be dropped, but this is now the production database. Later schema changes need migrations. |
| 3.1–3.3 customer data into D1 | Rows can be deleted. What can't be undone is that the data has been copied to Cloudflare, including anything they keep in backups. |
| 4.3 first push to `main` | Makes the code and its whole history visible to everyone with repo access. Retracting means rewriting remote history after people may have cloned it. Step 4.2 is the check that this is safe. |
| 4.4 enabling the hourly workflow | Starts hourly writes to production. It can be disabled; what it wrote stays. |
| 5.3 Quo webhook | Starts sending real customer calls and texts to the Worker. The subscription can be deleted; delivered data stays. |
| 0.4 workers.dev subdomain | Can be renamed, but both URLs change, and so do Access, the Quo webhook URL and anything bookmarked. |

Nothing in this runbook changes Gmail or Quo. The Google scope is `gmail.readonly` and Quo is read
plus a subscription: no labels, no marking read, no deletions.

Everything else is reversible: `wrangler rollback`, editing the Access policy, re-running the
idempotent seeds, and rotating secrets with `wrangler secret put` / `gh secret set`.

## If you stop halfway

Rechecked for this order in round 12, and again in round 13. Each row is the state if you stop
after that section.

| Stopped after | State | To back out |
|---|---|---|
| §0 | Nothing has changed anywhere, except file permissions. | — |
| §1 | Empty tables in D1. Nothing serves, nothing collects, no personal data anywhere. | Drop the tables, or leave them. |
| §2 | The console is live and locked, and shows an honest empty state. **The safest place to stop.** | Delete the Worker, or leave it. |
| §3 | ~716 customer addresses in D1, behind Access. Nothing is ingesting, so nothing new arrives. | Delete the rows. |
| §4 | Email syncs hourly and the queue fills. Phone shows red "never synced", which is true: it isn't connected. Quo's own app still has the texts, so nothing is lost, only un-consoled. | Actions → Ingest → disable the workflow. The push to `main` stays. |
| §5.1–5.2 | The webhook Worker is live and rate-limited, but nothing is subscribed, so it only ever answers 404, 401 or 429. Nothing reaches it. | Delete the Worker, or leave it. |
| §5.3 on | Everything runs. Calls and texts arrive in seconds. | `DELETE /webhooks/{id}`, and disable the workflow. |

**Is there a point after which stopping is worse than not starting?** Not in this order, with one
exception: step **4.3**, the push, is the only genuinely irreversible act, and 4.2 is the check that
makes it safe. Under the old order (webhook before email ingest) there was one: phone collected
into a console with no email in it, which looks complete and isn't. That is why the order changed.

The thing to avoid is handing Marianne the URL before §5 is done. Half a queue that looks whole is
worse than a queue that is plainly not ready.
