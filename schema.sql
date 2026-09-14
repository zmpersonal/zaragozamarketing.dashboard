-- InHouse / THI support console — D1 schema
-- One row per customer conversation, regardless of brand or channel.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------
-- Brands (mailboxes / phone lines / chat widgets roll up to these)
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brand (
  id            TEXT PRIMARY KEY,          -- 'inhouse' | 'thi' | 'caliza' | 'reachjulian'
  name          TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1
);

-- ---------------------------------------------------------------
-- Sources: a concrete inbox, phone number, or chat widget we poll
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS source (
  id            TEXT PRIMARY KEY,          -- 'gmail:support@inhousewellness.com'
  brand_id      TEXT NOT NULL REFERENCES brand(id),
  channel       TEXT NOT NULL,             -- 'email' | 'phone' | 'chat'
  provider      TEXT NOT NULL,             -- 'gmail' | 'quo' | 'tidio' | ...
  address       TEXT NOT NULL,             -- email address, E.164 number, widget id
  last_synced_at INTEGER,                  -- unix seconds
  sync_cursor   TEXT                       -- Gmail historyId, Quo cursor, etc.
);

-- ---------------------------------------------------------------
-- Threads: the unit the dashboard counts and the agent works
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS thread (
  id              TEXT PRIMARY KEY,        -- '<provider>:<native id>'
  source_id       TEXT NOT NULL REFERENCES source(id),
  brand_id        TEXT NOT NULL REFERENCES brand(id),
  channel         TEXT NOT NULL,

  subject         TEXT,
  customer_name   TEXT,
  customer_handle TEXT,                    -- email or phone
  preview         TEXT,                    -- first ~200 chars of latest inbound

  -- state machine
  status          TEXT NOT NULL DEFAULT 'waiting',
                  -- 'waiting'   nobody has replied yet
                  -- 'answered'  we replied, ball is in their court
                  -- 'blocked'   we replied but are stuck (see blocked_on)
                  -- 'closed'    done
  blocked_on      TEXT,                    -- 'customer' | 'supplier' | 'refund'
                                           -- | 'shipping' | 'owner' | 'other'
  blocked_note    TEXT,
  blocked_since   INTEGER,                 -- unix seconds the thread moved to 'blocked'.
                                           -- Kept while it stays blocked, NULL otherwise.
                                           -- Blocked threads age and sort by this.

  assignee        TEXT,                    -- agent email, null = unassigned
  priority        INTEGER NOT NULL DEFAULT 0,  -- 0 normal, 1 high, 2 urgent

  conversation_started_at  INTEGER NOT NULL,      -- unix seconds — when the conversation began.
                                           -- Set on insert, never updated.
  last_inbound_at   INTEGER NOT NULL,
  last_outbound_at  INTEGER,
  closed_at         INTEGER,

  -- The oldest inbound message with no outbound after it. NULL when we are
  -- caught up. The response clock runs from here, never from conversation_started_at.
  -- A new inbound on a closed thread reopens it and sets this to that message.
  awaiting_since    INTEGER,

  is_automated    INTEGER NOT NULL DEFAULT 0,  -- answered by chat AI, not a human

  -- triage: three tiers, and nothing is ever hidden in any of them.
  triage          TEXT NOT NULL DEFAULT 'customer',
                  -- 'customer'  needs a reply
                  -- 'bulk'      probably not a customer (structural bulk signals)
                  -- 'spam'      Gmail's SPAM label or an agent's spam call. Its own
                  --             tier, never a heavier bulk signal; shown and scannable.
  triage_score    INTEGER NOT NULL DEFAULT 0,  -- bulk score only; spam adds nothing
  triage_signals  TEXT,                    -- JSON [{code, why}] reasons, carried to the UI
  triage_by       TEXT,                    -- agent email if a human set it

  -- response clock, measured in BUSINESS minutes (America/Chicago, Mon-Fri 8-5)
  -- from awaiting_since. Rescuing a demoted message changes triage only, never
  -- conversation_started_at or awaiting_since, or the filter would launder slow responses.
  first_response_mins INTEGER,

  stage           TEXT,                    -- where this customer is in the process
  raw             TEXT                     -- provider JSON, for debugging
);

CREATE INDEX IF NOT EXISTS idx_thread_open
  ON thread(triage, status, awaiting_since) WHERE status IN ('waiting','blocked');
CREATE INDEX IF NOT EXISTS idx_thread_brand ON thread(brand_id, channel, status);
CREATE INDEX IF NOT EXISTS idx_thread_assignee ON thread(assignee, status);

-- ---------------------------------------------------------------
-- Actions: every human touch. Append-only. This is the audit log
-- and the agent's "input actions and responses" surface.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS action (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id   TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  actor       TEXT NOT NULL,               -- agent email, or 'system'
  kind        TEXT NOT NULL,
              -- 'replied' | 'called' | 'note' | 'status_change'
              -- | 'assigned' | 'escalated' | 'refunded'
              -- | 'rescued' (agent moved a demoted thread into the queue)
              -- | 'reopened' (actor 'system': new inbound after close)
  body        TEXT,                        -- what was said / what happened
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_action_thread ON action(thread_id, created_at DESC);

-- ---------------------------------------------------------------
-- Responses: one row every time a wait on us ends. Append-only, like
-- action. A column on thread would hold one number and lose history when
-- a thread reopens; this keeps every measurement for the admin report.
-- business_minutes is America/Chicago Mon-Fri 08:00-17:00 (lib/clock.ts),
-- from awaiting_since to responded_at.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS response (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id        TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  awaiting_since   INTEGER NOT NULL,         -- the inbound the wait started from
  responded_at     INTEGER NOT NULL,         -- when the wait ended
  business_minutes INTEGER NOT NULL,
  via              TEXT NOT NULL,            -- 'message' (a reply seen by ingest)
                                             -- | 'replied' | 'called' (logged by an agent, marked answered/closed)
                                             -- | 'closed' (closed with no contact: not a reply)
  actor            TEXT NOT NULL,            -- 'system' or the agent's email
  created_at       INTEGER NOT NULL,
  -- One measurement per wait: re-syncs and the agent/ingest overlap can't duplicate it.
  UNIQUE (thread_id, awaiting_since)
);
CREATE INDEX IF NOT EXISTS idx_response_time ON response(responded_at);

-- ---------------------------------------------------------------
-- Ingest failures: items (a Gmail thread, a Quo conversation) that failed
-- to sync, so a stuck record is visible instead of silent. A Quo item that
-- fails repeatedly is skipped (skipped_at) so it cannot hold the cursor
-- back forever. A successful sync deletes the row. Shown on /api/board.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingest_failure (
  source_id        TEXT NOT NULL REFERENCES source(id),
  item_id          TEXT NOT NULL,            -- thread id: 'gmail:<id>' | 'quo:<conversation id>'
  failures         INTEGER NOT NULL,         -- consecutive failed syncs
  first_failed_at  INTEGER NOT NULL,
  last_failed_at   INTEGER NOT NULL,
  last_error       TEXT,
  skipped_at       INTEGER,                  -- when ingest gave up and moved past it
  PRIMARY KEY (source_id, item_id)
);

-- ---------------------------------------------------------------
-- Webhook deliveries already processed, keyed by the Standard Webhooks
-- webhook-id header (stable across Quo's retries, which run for ~27.5 hours).
-- A repeat delivery is acknowledged without being processed again. Rows
-- older than 7 days are pruned on insert.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_delivery (
  webhook_id   TEXT PRIMARY KEY,
  event_type   TEXT,
  received_at  INTEGER NOT NULL
);

-- ---------------------------------------------------------------
-- Sender rules: what the agent taught us by clicking Not customer
-- or Spam. Applies going forward, and doubles as labelled training
-- data if we ever want to revisit the rules with a model.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sender_rule (
  address     TEXT PRIMARY KEY,
  verdict     TEXT NOT NULL,               -- 'customer' | 'not_customer' | 'spam'
  set_by      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Senders we have ever replied to. Exempt from demotion, so a repeat
-- customer whose company signature carries an unsubscribe footer never
-- falls off the list.
CREATE TABLE IF NOT EXISTS known_sender (
  address       TEXT PRIMARY KEY,
  first_seen_at INTEGER NOT NULL,
  replied_at    INTEGER
);

-- ---------------------------------------------------------------
-- To-dos: work that isn't a customer thread (restock a supplier,
-- chase a carrier claim). Threads generate these too.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS todo (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  brand_id    TEXT REFERENCES brand(id),
  thread_id   TEXT REFERENCES thread(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  detail      TEXT,
  assignee    TEXT,
  due_at      INTEGER,
  done_at     INTEGER,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_todo_open ON todo(assignee, done_at, due_at);

-- ---------------------------------------------------------------
-- Seed
-- ---------------------------------------------------------------
INSERT OR IGNORE INTO brand (id, name) VALUES
  ('inhouse',     'InHouse Wellness'),
  ('thi',         'THI'),
  ('caliza',      'Caliza Group'),
  ('reachjulian', 'Reach Julian');
