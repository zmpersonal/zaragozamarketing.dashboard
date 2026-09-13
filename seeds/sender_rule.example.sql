-- Sender rules seed, applied at setup. COPY this file OUTSIDE the repo, put
-- real addresses in the copy, and apply the copy:
--
--   npx wrangler d1 execute inhouse-ops --remote --file=/path/outside/repo/sender-rules.sql
--
-- The prove scripts read the same copy via SENDER_RULES_FILE.
-- Never commit real addresses: they are customer contact data. Only this
-- example (fabricated addresses at example.com) belongs in git.
--
-- verdict: 'customer' = verified customer (beats every signal, incl. Gmail spam)
--          'spam'     = spam sender
INSERT OR IGNORE INTO sender_rule (address, verdict, set_by, created_at) VALUES
  ('verified.customer@example.com', 'customer', 'owner (verified by hand)', 1789300000),
  ('known.spammer@example.com',     'spam',     'owner',                    1789300000);
