# Deploy runbook: from `claude/inh-round-11` to Marianne logging in

Written in round 11. **Nothing here has been run.** Every step is marked **[YOU]** (Julian and the
owner, with the Cloudflare, GitHub, Google and Quo accounts) or **[CLAUDE]**. Steps marked
**IRREVERSIBLE** can't simply be undone; read the note before running them.

What gets deployed:

| Piece | Where | Protected by |
|---|---|---|
| `inhouse-ops`: dashboard and `/api/*` | Cloudflare Worker, `inhouse-ops.<subdomain>.workers.dev` | Cloudflare Access (Worker-level) |
| `inhouse-ops-hooks`: `/hooks/quo` only | Cloudflare Worker, `inhouse-ops-hooks.<subdomain>.workers.dev` | Quo's webhook signature (no Access: Quo can't sign in) |
| D1 database `inhouse-ops` (`4f562bdf-…`) | Cloudflare D1 | Bound to both Workers; written by the Actions run over the REST API |
| Hourly ingest (Gmail, Quo backstop) | GitHub Actions, `.github/workflows/ingest.yml` | Actions secrets |

Why two Workers: Access on a Worker covers every hostname and path it serves, and its bypass is
whole-Worker only (developers.cloudflare.com/workers/configuration/cloudflare-access). A webhook on
the console Worker would be blocked for Quo the moment Access is on.

Placeholders used below: `<subdomain>` is the account's workers.dev subdomain; `PN…` is the Quo
phone-number id; `<team>` is the Zero Trust team name.

---

## 0. Before you start

1. **[YOU]** `cd` into a checkout of `claude/inh-round-11` and run
   `npm install && npm run check && npm test && npm run build`. All must pass (309 tests, round 11).
2. **[YOU]** `npx wrangler login` and choose the account `0ef0279e4af302865cd2009458864c1b`.
   Confirm with `npx wrangler whoami`.
3. **[YOU]** Confirm the database exists and the id matches `wrangler.toml`:
   `npx wrangler d1 list`. If it doesn't exist, stop and tell Claude: creating it gives a new id.
4. **[YOU]** Cloudflare dashboard → **Workers & Pages**: if the account has no workers.dev
   subdomain yet, choose one now. Note it as `<subdomain>`. Changing it later changes both URLs.
5. **[YOU]** Local key hygiene: `chmod 600 ~/Code/secrets/*`. The service-account key was mode 644.
6. **[YOU]** Know the Quo phone-number id:
   `QUO_API_KEY=… node prove/quo.mjs` prints `Quo numbers: PN…  +1…`.

## 1. Database (production writes)

Run from the repo root. Each command writes to the production database.

1. **[YOU] IRREVERSIBLE (production data):** load the schema. Safe to re-run: every table is
   `CREATE TABLE IF NOT EXISTS`.
   ```bash
   npx wrangler d1 execute inhouse-ops --remote --file=./schema.sql
   ```
2. **[YOU] IRREVERSIBLE:** register the sources (replace `PN…`):
   ```bash
   npx wrangler d1 execute inhouse-ops --remote --command "INSERT OR IGNORE INTO source (id, brand_id, channel, provider, address) VALUES ('gmail:support@inhousewellness.com','inhouse','email','gmail','support@inhousewellness.com'), ('quo:PN…','inhouse','phone','quo','PN…');"
   ```
3. **[YOU] IRREVERSIBLE:** verified customers (the sender-rule seed, kept outside the repo):
   ```bash
   npx wrangler d1 execute inhouse-ops --remote --file=$HOME/Code/secrets/inhouse-ops-sender-rules.sql
   ```
4. **[YOU] IRREVERSIBLE:** known senders, with our own domain filtered out. Regenerate the filtered
   file first; it's repeatable and idempotent.
   ```bash
   node prove/apply-known-senders.mjs --in ~/Code/secrets/inhouse-ops-known-senders.sql \
     --out ~/Code/secrets/inhouse-ops-known-senders.filtered.sql
   npx wrangler d1 execute inhouse-ops --remote --file=$HOME/Code/secrets/inhouse-ops-known-senders.filtered.sql
   ```
5. **[YOU]** Check it:
   `npx wrangler d1 execute inhouse-ops --remote --command "SELECT (SELECT COUNT(*) FROM source) AS sources, (SELECT COUNT(*) FROM sender_rule) AS rules, (SELECT COUNT(*) FROM known_sender) AS known"`
   Expect 2 sources, your rule count, and ~715 known senders.

From here, schema changes need `wrangler d1 migrations`: `schema.sql` only creates missing tables.

## 2. The console Worker, behind Access

1. **[YOU]** Deploy it: `npx wrangler deploy`.
   - Until step 4, `ACCESS_AUD` is `CHANGE_ME`, so every `/api` request is refused (401) and no data
     is served. The page shell itself (HTML, no data) is public for these few minutes.
   - To avoid even that, do steps 2–4 straight away.
2. **[YOU]** Dashboard → **Workers & Pages** → `inhouse-ops` → **Settings** → **Domains & Routes** →
   `workers.dev` → **Enable Cloudflare Access**.
   - If asked to set up Zero Trust, choose a team name (this is `<team>`) and the Free plan.
3. **[YOU]** **Manage Cloudflare Access** → the policy named `inhouse-ops - Production`:
   - **Include → Emails**: each person by their own address (Marianne's, Julian's, the owner's).
   - **Never** a shared inbox such as support@ (CLAUDE.md invariant 8).
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
5. **[YOU]** Check it:
   - Open `https://inhouse-ops.<subdomain>.workers.dev` in a private window. You should get the
     Access login, then the console.
   - The header should show both sources as **never synced** (red). That's correct until step 5.
   - An address not in the policy must not get in.

## 3. The webhook Worker and the Quo subscription

1. **[YOU]** Deploy it: `npx wrangler deploy -c wrangler.hooks.toml`.
   - Check: `curl -s -o /dev/null -w "%{http_code}\n" https://inhouse-ops-hooks.<subdomain>.workers.dev/`
     → `404`.
   - And `curl -s -X POST https://inhouse-ops-hooks.<subdomain>.workers.dev/hooks/quo -d '{}'` →
     `401`: no secret yet, fails closed.
2. **[YOU] IRREVERSIBLE (real customer events start flowing):** create the Quo webhook, and pipe its
   signing key straight into the Worker secret so it never lands on screen or disk:
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
3. **[YOU]** Test the signature: `POST https://api.quo.com/webhooks/<id>/events/test` with body
   `{"eventType":"message.received"}`, same headers.
   - Quo's delivery log should show **200**. The sample event's phone number isn't ours, so it's
     acknowledged and ignored.
   - A **401** means the secret didn't take.
4. **[YOU]** Test for real: text the Quo number from a phone. Within seconds, a Needs-reply phone
   thread should appear in the console, before any hourly run.

## 4. GitHub: secrets, then `main`

1. **[YOU]** Add the Actions secrets (GitHub → repo → Settings → Secrets and variables → Actions,
   or `gh secret set`):
   ```bash
   gh secret set GOOGLE_SERVICE_ACCOUNT_JSON < ~/Code/secrets/inhouse-ops-3bd30d8e136e.json
   gh secret set QUO_API_KEY                  # paste; watch for a lost trailing "="
   gh secret set CLOUDFLARE_API_TOKEN         # a token scoped to Account → D1 → Edit, nothing else
   gh secret set CLOUDFLARE_ACCOUNT_ID --body 0ef0279e4af302865cd2009458864c1b
   gh secret set CLOUDFLARE_D1_DATABASE_ID --body 4f562bdf-560b-4c82-a84e-554aa8c2bcb7
   ```
2. **[YOU] IRREVERSIBLE (first push):** put this branch on GitHub as `main`.
   - The GitHub repository is empty today (round 11: `git ls-remote` lists no branches), so this is
     the first thing anyone with repo access can see.
   - Push only this branch. `claude/inh-round-5` and `-6` contain a customer address and usernames
     (HANDOFF) and must never be pushed.
   ```bash
   git push origin claude/inh-round-11:refs/heads/main
   ```
   Then GitHub → Settings → General → **Default branch** = `main`. The hourly schedule only runs
   from the default branch.
   - Undoing it means rewriting or deleting the remote branch, after anyone may already have cloned it.
3. **[YOU] IRREVERSIBLE (hourly production writes begin):** GitHub → **Actions** → **Ingest** → enable
   if prompted → **Run workflow**.
   - Wait for green. The log shows `ingest gmail: processed …` and `ingest quo: processed …`, and
     never a secret.
   - A red run names the source that failed.
   - The first runs work through the 30-day backlog, about 45 email threads per run.

## 5. Marianne logs in

1. **[YOU]** Make sure her own address is in the `inhouse-ops - Production` policy (step 2.3).
2. **[YOU]** Send her `https://inhouse-ops.<subdomain>.workers.dev`. She enters her address, gets a
   one-time PIN by email, and lands on **My queue** as an agent (unless she's in `OWNERS`).
3. **[YOU]** What she should see:
   - both sources **synced N min ago**, not red
   - Needs reply, Probably not customers and Spam, each with a count
   - a text to the Quo number appearing within seconds

## 6. The first day

- **[YOU] Freshness badge:**
  - It turns amber past 3 hours and red past 12. That's how a stopped schedule, expired token, quota
    or API change shows up; the keepalive can't be verified.
  - If it goes red, open the Actions tab first.
- **[YOU] Worker CPU:**
  - Workers → `inhouse-ops` → **Observability**: check CPU time per request and any error 1102
    ("exceeded resource limits").
  - Round 11 measured the UI's requests locally at ~6–9 ms each against Free's 10 ms, with p90s above
    it (HANDOFF, "Worker CPU").
  - If 1102s appear, the choice is Workers Paid ($5/month) for the console Worker, or more query work.
- **[YOU] D1 usage:** Cloudflare dashboard → D1 → `inhouse-ops` → Metrics. The Free plan allows
  5 million rows read and 100,000 written a day.
- **[YOU] Batch atomicity (optional, settles a HANDOFF question):**
  `CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_D1_DATABASE_ID=… node prove/d1-batch-atomicity.mjs`
  - It uses a scratch table and drops it afterwards.
  - Either answer is safe: thread writes don't depend on batch atomicity.

## What can't be undone, in one place

| Step | Why it's one-way |
|---|---|
| 1.1–1.4 production D1 writes | Rows can be deleted, but this is now the production database. Later schema changes need migrations. |
| 3.2 Quo webhook | Starts sending real customer calls and texts to the Worker. The subscription can be deleted; delivered data stays. |
| 4.2 first push to `main` | Makes the code and its whole history visible to everyone with repo access. Retracting means rewriting remote history after people may have cloned it. |
| 4.3 enabling the hourly workflow | Starts hourly writes to production. It can be disabled; what it wrote stays. |
| 0.4 workers.dev subdomain | Can be renamed, but both URLs change, and so do Access, the Quo webhook URL and anything bookmarked. |

Everything else is reversible: `wrangler rollback`, editing the Access policy, re-running the
idempotent seeds, and rotating secrets with `wrangler secret put` / `gh secret set`.
