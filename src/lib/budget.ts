/**
 * Per-invocation subrequest budget.
 *
 * Cloudflare counts every fetch() AND every call to D1 as a subrequest
 * (developers.cloudflare.com/workers/platform/limits, read round 8):
 *   Workers Free:  50 external + 1,000 internal subrequests, 10 ms CPU per invocation
 *   Workers Paid:  10,000 subrequests (configurable), 5 min CPU (15 min per cron invocation)
 * D1 queries per invocation were read as 50 Free / 1,000 Paid in round 7; the
 * defaults stay under 1,000. This app requires Workers Paid (CLAUDE.md, "Hosting cost").
 * Ingest asks canAfford() before each unit of work and stops early, leaving
 * the rest for the next run, instead of failing mid-write at the platform cap.
 */

export class Budget {
  fetches = 0;
  queries = 0;
  readonly maxSubrequests: number;
  readonly maxQueries: number;

  constructor(maxSubrequests: number, maxQueries: number) {
    this.maxSubrequests = maxSubrequests;
    this.maxQueries = maxQueries;
  }

  static from(env: { INGEST_MAX_SUBREQUESTS?: string; INGEST_MAX_D1_QUERIES?: string }, defaults: { maxSubrequests: number; maxD1Queries: number }) {
    const num = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);
    return new Budget(num(env.INGEST_MAX_SUBREQUESTS, defaults.maxSubrequests), num(env.INGEST_MAX_D1_QUERIES, defaults.maxD1Queries));
  }

  get subrequests() {
    return this.fetches + this.queries;
  }

  canAfford(fetches: number, queries: number) {
    return this.subrequests + fetches + queries <= this.maxSubrequests && this.queries + queries <= this.maxQueries;
  }

  /** A fetch() that counts against the budget. */
  fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    this.fetches++;
    return fetch(input, init);
  };

  /** A D1 binding that counts one query per run/all/first and one per statement in a batch. */
  wrap(db: D1Database): D1Database {
    const self = this;
    const wrapStmt = (stmt: D1PreparedStatement): D1PreparedStatement => new Proxy(stmt, {
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
          return (stmts: D1PreparedStatement[]) => {
            self.queries += stmts.length;
            return target.batch(stmts.map((s) => (s as any).__inner ?? s));
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }
}
