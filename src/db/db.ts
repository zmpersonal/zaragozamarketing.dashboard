/**
 * The database surface ingest and the thread writes use: the subset of the
 * D1 binding API this codebase calls. Two implementations:
 *   - the Worker's D1 binding (env.DB), which satisfies it as-is
 *   - D1HttpClient (db/d1-http.ts), Cloudflare's D1 REST API, for ingest on GitHub Actions
 * Queries, rules and the clock are identical in both places; only where the
 * statements go differs.
 */
export interface DbStatement {
  bind(...values: unknown[]): DbStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface Db {
  prepare(sql: string): DbStatement;
  /** All statements in one transaction. */
  batch(statements: DbStatement[]): Promise<unknown[]>;
}

/** What ingest needs from its environment, in the Worker or on a runner. */
export interface IngestEnv {
  DB: Db;
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  QUO_API_KEY?: string;
  /** Optional per-run overrides of the ingest caps. */
  INGEST_MAX_SUBREQUESTS?: string;
  INGEST_MAX_D1_QUERIES?: string;
}
