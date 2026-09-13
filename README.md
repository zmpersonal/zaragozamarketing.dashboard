# InHouse support console

V1 scope: InHouse Wellness customer service only. Email and phone in one place,
a queue for the agent, and a response-time report for the admin. Chat and the
THI panel come later.

Two views, deliberately unequal. The agent sees one column of what needs a reply
and nothing else. The admin sees what is outstanding, how long it has been, and
a month of what was answered with deep links into the real threads.

## Why this stack

You asked for cheapest, most secure, and still standing if every subscription lapses.
That last constraint is the one that decides the architecture:

- **Cloudflare Workers + D1 + static assets.** The whole thing is one Worker and one
  SQLite database at the edge. Free tier covers this comfortably; a domain is about
  $10/year and that is the entire bill.
- **Cloudflare Access for login.** No password table to write or leak. You and the agent
  sign in with a Google account or an emailed code, and the Worker reads identity from a
  signed token. Free up to 50 users.
- **GitHub for the code.** Private repo, `wrangler deploy` on push.
- **No AI provider in the critical path.** The board polls Gmail and Quo directly and
  renders from D1. If every Anthropic subscription were cancelled tomorrow, this keeps
  running untouched. Anything AI gets added later as a side channel that can fail without
  taking the console down.

**One thing worth knowing:** the Gmail connector inside Claude is not what this app uses.
That connector only works while you are in a Claude session. The console needs its own
Google Cloud OAuth client so it can pull mail on a cron with nothing else running. Same
for Quo — its own API key, held as a Worker secret.

## The data model in one paragraph

Everything is a `thread`, whatever channel it came from. A thread is `waiting`,
`answered`, `blocked`, or `closed`. Waiting vs answered is decided by one rule: is the
last message inbound? `blocked` is where "waiting on what" lives — customer, supplier,
shipping, refund, or owner sign-off. Every human touch is appended to `action`, which is
both the audit log and the agent's input surface. `todo` covers work that is not a
customer thread. See `schema.sql`.

Ingest never overwrites a status a human set. If the agent marks something blocked, an
unchanged mailbox will not quietly flip it back to waiting.

## Setup

```bash
npm install -g wrangler
wrangler login

wrangler d1 create inhouse-ops          # paste the id into wrangler.toml
wrangler d1 execute inhouse-ops --file=./schema.sql --remote

wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put GOOGLE_REFRESH_TOKENS   # {"support@inhousewellness.com":"1//0..."}
wrangler secret put QUO_API_KEY

wrangler deploy
```

Then in the Cloudflare dashboard: Zero Trust → Access → add a self-hosted application
over the Worker's hostname, allow your two email addresses, and copy the audience tag
into `ACCESS_AUD`.

Register each mailbox and phone line as a source:

```sql
INSERT INTO source (id, brand_id, channel, provider, address) VALUES
  ('gmail:support@inhousewellness.com','inhouse','email','gmail','support@inhousewellness.com'),
  ('gmail:hello@calizagroup.com',      'caliza', 'email','gmail','hello@calizagroup.com'),
  ('gmail:julian@reachjulian.com',     'reachjulian','email','gmail','julian@reachjulian.com');
```

## The filter

support@ takes 10-20 messages a day and roughly 2 are real. The rules that sort
them live in `src/lib/triage.ts` and are structural facts about each message --
List-Unsubscribe, Gmail's own Promotions/Social categories, Precedence: bulk,
no-reply senders. No model in this path; it costs nothing and survives every
subscription lapsing.

Two rules matter more than the list:

- **Nothing is hidden.** Demoted mail renders greyed below the fold with the
  reasons it was demoted. At 17 messages a day the agent can see the whole day,
  so a bad rule is visible instead of silent.
- **Anyone we have ever replied to is exempt**, so a repeat customer whose
  company signature carries an unsubscribe footer never falls off the list.

Marking Not customer or Spam writes a sender rule that applies going forward and
is kept as labelled data.

## The clock

Response time is business minutes only -- America/Chicago, Mon-Fri 08:00-17:00
(`src/lib/clock.ts`). Mail arriving Friday 16:50 is ten minutes old on Monday
morning. We store the IANA zone name, never an offset, so CST/CDT handles itself.

The response clock runs from `awaiting_since` (the oldest inbound we have not
answered). `conversation_started_at` is when the conversation began and never moves.
Rescuing a demoted message never touches either -- otherwise the filter would quietly
launder the slowest responses.

## Prove the sources first

Per the build SOP, neither ingest worker should be trusted until the source is proved in
isolation. Run these before deploying anything:

```bash
node prove/gmail.mjs support@inhousewellness.com
node prove/quo.mjs
node prove/triage.mjs support@inhousewellness.com     # read this one carefully
```

`prove/triage.mjs` runs the filter over 30 days of real mail and prints every
message with its verdict and reasons. Read it before any UI is built on it:

1. Any real customer in DEMOTED is the only failure that costs money. Should be zero.
2. Newsletters in KEPT are annoying, not dangerous -- that is the side we err toward.
3. If a demote reason looks wrong, the rule is wrong, not the email.

Both print real threads with real ages and a waiting/answered verdict. If either fails,
fix it there — nothing downstream gets built on an unproven source. Watch for a trailing
`=` truncated off a copied secret; that is the classic silent failure here.

## Looking at the UI now

`public/index.html` runs standalone on mock data — open it in a browser, no build step.
Flip `USE_API = true` at the top of the script once D1 is seeded; every fetch already
points at the real Worker routes.

## Not done yet

- **Process stages.** The `stage` column exists but has no vocabulary yet. This is the
  field the agent touches most and it should use words they already say, so it is
  waiting on your real list.
- **Weekend confirmation.** The clock assumes Sat/Sun fully closed.
- **Chat.** No provider connected; `src/ingest/chat.ts` normalises whatever we pick.
- **Quo webhook signature.** `/hooks/quo` accepts anything today. Verify before go-live.
- **The assistant panel.** Knowledge base plus live call scripts, logged against the
  thread from day one so the monthly review has data. Sits outside the critical path.

## Chat

Chatra has no live Shopify data, which is exactly the gap you hit. Two real options:

- **Tidio (Lyro)** — Shopify-native app with live order lookup and product cards, and its
  AI can take actions like checking order status. Cheapest way in; flat-ish pricing.
- **Gorgias** — deeper Shopify actions (refunds, order edits, tags) from inside chat, and
  it unifies email and SMS too. Priced per AI resolution, which gets expensive as volume
  grows, and it overlaps with what this console already does.

Given the console already owns the unified inbox, Tidio is the better fit: let it handle
the widget and the AI, and pipe its conversations in here through
`src/ingest/chat.ts` so chat sits in the same board as everything else.
