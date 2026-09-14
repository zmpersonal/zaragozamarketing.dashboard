/**
 * Per-run ingest budget: a count of outbound fetches and D1 statements, and
 * optionally a wall-clock deadline. Ingest asks canAfford() before each unit
 * of work and stops early, leaving the rest for the next run, instead of
 * failing mid-write.
 *
 * Ingest runs on GitHub Actions (round 9). No per-invocation subrequest cap
 * applies there; what binds is:
 *   - Cloudflare's API: 1,200 requests per 5 minutes per token, and every call
 *     blocked for 5 minutes past that. Every D1 statement is one request (a
 *     batch is one request for several), so statement caps keep a run under it.
 *   - Actions minutes: the deadline stops a run starting new work in time to
 *     finish inside the job's timeout.
 */

import type { Db, DbStatement } from '../db/db.ts';

export class Budget {
  fetches = 0;
  queries = 0;
  readonly maxSubrequests: number;
  readonly maxQueries: number;
  /** Epoch milliseconds after which nothing new is started; null = no time limit. */
  readonly deadline: number | null;
  readonly #now: () => number;

  constructor(maxSubrequests: number, maxQueries: number, time: { deadline?: number | null; now?: () => number } = {}) {
    this.maxSubrequests = maxSubrequests;
    this.maxQueries = maxQueries;
    this.deadline = time.deadline ?? null;
    this.#now = time.now ?? Date.now;
  }

  static from(
    env: { INGEST_MAX_SUBREQUESTS?: string; INGEST_MAX_D1_QUERIES?: string },
    defaults: { maxSubrequests: number; maxD1Queries: number },
    time: { deadline?: number | null; now?: () => number } = {},
  ) {
    const num = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);
    return new Budget(num(env.INGEST_MAX_SUBREQUESTS, defaults.maxSubrequests), num(env.INGEST_MAX_D1_QUERIES, defaults.maxD1Queries), time);
  }

  get pastDeadline() {
    return this.deadline !== null && this.#now() >= this.deadline;
  }

  get subrequests() {
    return this.fetches + this.queries;
  }

  canAfford(fetches: number, queries: number) {
    if (this.pastDeadline) return false;
    return this.subrequests + fetches + queries <= this.maxSubrequests && this.queries + queries <= this.maxQueries;
  }

  /** A fetch() that counts against the budget. */
  fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    this.fetches++;
    return fetch(input, init);
  };

  /** A D1 binding that counts one query per run/all/first and one per statement in a batch. */
  wrap(db: Db): Db {
    const self = this;
    const wrapStmt = (stmt: DbStatement): DbStatement => new Proxy(stmt, {
      get(target, prop, receiver) {
        if (prop === 'bind') return (...args: unknown[]) => wrapStmt(target.bind(...args));
        if (prop === 'run' || prop === 'all' || prop === 'first' || prop === 'raw') {
          return (...args: unknown[]) => { self.queries++; return (target as any)[prop](...args); };
        }
        if (prop === '__inner') return target;
        return Reflect.get(target, prop, receiver);
      },
    });
    return new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'prepare') return (sql: string) => wrapStmt(target.prepare(sql));
        if (prop === 'batch') {
          return (stmts: DbStatement[]) => {
            self.queries += stmts.length;
            return target.batch(stmts.map((s) => (s as any).__inner ?? s));
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }
}
