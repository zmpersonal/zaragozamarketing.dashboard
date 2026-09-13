/**
 * Sender rules for the prove scripts, read from the same seed SQL that is
 * applied to D1 at setup (INSERT INTO sender_rule ...). The file lives outside
 * the repo because verified customers are customer contact data.
 *
 * The seed is applied to an in-memory copy of schema.sql, so the prove run
 * reads rules exactly the way the database will hold them. Nothing from the
 * file is printed.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const SCHEMA = new URL('../schema.sql', import.meta.url);

export function loadSenderRules(path, fail) {
  if (!path) return { markedReal: new Set(), markedSpam: new Set(), source: 'no SENDER_RULES_FILE set' };
  let seed;
  try {
    seed = readFileSync(path, 'utf8');
  } catch (err) {
    fail(`SENDER_RULES_FILE could not be read (${err.code ?? 'error'}): ${path}`);
  }
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(SCHEMA, 'utf8'));
  try {
    db.exec(seed);
  } catch (err) {
    fail(`SENDER_RULES_FILE is not valid seed SQL for schema.sql: ${err.message}`);
  }
  const rows = db.prepare('SELECT address, verdict FROM sender_rule').all();
  const pick = (verdict) => new Set(rows.filter((r) => r.verdict === verdict).map((r) => String(r.address).toLowerCase()));
  return { markedReal: pick('customer'), markedSpam: pick('spam'), source: 'SENDER_RULES_FILE' };
}
