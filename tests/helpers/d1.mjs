// A minimal D1 stand-in over node:sqlite, so ingest SQL runs against the
// real schema.sql in tests. D1 is SQLite, and both accept ?NNN parameters.
// Covers only the D1 surface this codebase uses: prepare/bind/run/all/first/batch.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const SCHEMA = new URL('../../schema.sql', import.meta.url);

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new Statement(this.db, this.sql, params);
  }
  #stmt() {
    return this.db.prepare(this.sql);
  }
  async run() {
    const r = this.#stmt().run(...this.params);
    return { success: true, meta: { changes: Number(r.changes) } };
  }
  async all() {
    return { success: true, results: this.#stmt().all(...this.params).map((row) => ({ ...row })) };
  }
  async first() {
    const row = this.#stmt().get(...this.params);
    return row ? { ...row } : null;
  }
}

export function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(SCHEMA, 'utf8'));
  return {
    raw: db,
    prepare: (sql) => new Statement(db, sql),
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of statements) out.push(await s.run());
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}
