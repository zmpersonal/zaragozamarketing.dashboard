/**
 * D1 over Cloudflare's REST API, with the same surface as the Worker binding
 * (db/db.ts), so ingest runs unchanged on GitHub Actions.
 *
 * POST https://api.cloudflare.com/client/v4/accounts/{account}/d1/database/{database}/query
 *   body     {sql, params} for one statement, {batch: [{sql, params}]} for a batch
 *   response {success, errors: [{code, message}], result: [{success, results, meta: {changes}}]}
 * (developers.cloudflare.com/api/resources/d1/subresources/database/methods/query, read round 9)
 *
 * Retries:
 *   - 429 (rate limited): the request was refused, so it is always safe to retry.
 *     Retry-After is honoured, capped at 30 s. The API allows 1,200 requests per
 *     5 minutes per token and blocks everything for 5 minutes past that, so
 *     ingest caps its own statement count well below it (see GMAIL_LIMITS / QUO_LIMITS).
 *   - 5xx or a network error: retried only when every statement is a SELECT.
 *     A write may already have been applied, so it fails instead and the next
 *     run re-syncs from the unchanged cursor (thread writes are conditional).
 *   - anything else (bad SQL, bad token): never retried.
 * Errors carry the HTTP status and Cloudflare's error messages. The token is
 * only ever placed in the Authorization header and never appears in an error.
 */
import type { Db, DbStatement } from './db.ts';

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface D1HttpOptions {
  accountId: string;
  databaseId: string;
  token: string;
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Retries after the first attempt. */
  maxRetries?: number;
  baseDelayMs?: number;
}

interface ApiResult { success: boolean; results?: Record<string, unknown>[]; meta?: { changes?: number } }
interface ApiBody { success?: boolean; errors?: { code?: number; message?: string }[]; result?: ApiResult[] }

const MAX_RETRY_AFTER_MS = 30_000;
const isRead = (sql: string) => /^\s*select\b/i.test(sql) && !/\b(insert|update|delete|replace|create|drop|alter)\b/i.test(sql);

class HttpStatement implements DbStatement {
  readonly client: D1HttpClient;
  readonly sql: string;
  readonly params: unknown[];

  constructor(client: D1HttpClient, sql: string, params: unknown[] = []) {
    this.client = client;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: unknown[]): DbStatement {
    if (values.some((v) => v === undefined)) throw new TypeError('D1 bind: undefined is not a valid parameter (use null)');
    return new HttpStatement(this.client, this.sql, values);
  }
  async all<T = Record<string, unknown>>() {
    const [r] = await this.client.send([this]);
    return { results: (r.results ?? []) as T[] };
  }
  async first<T = Record<string, unknown>>() {
    const { results } = await this.all<T>();
    return results[0] ?? null;
  }
  async run() {
    const [r] = await this.client.send([this]);
    return { meta: { changes: Number(r.meta?.changes ?? 0) } };
  }
}

export class D1HttpClient implements Db {
  readonly #url: string;
  readonly #token: string;
  readonly #fetch: Fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #maxRetries: number;
  readonly #baseDelayMs: number;
  /** HTTP requests made, for run summaries. */
  requests = 0;

  constructor(o: D1HttpOptions) {
    for (const k of ['accountId', 'databaseId', 'token'] as const) {
      if (!o[k]) throw new Error(`D1HttpClient: ${k} is required`);
    }
    this.#url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(o.accountId)}/d1/database/${encodeURIComponent(o.databaseId)}/query`;
    this.#token = o.token;
    this.#fetch = o.fetch ?? ((input, init) => fetch(input, init));
    this.#sleep = o.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#maxRetries = o.maxRetries ?? 4;
    this.#baseDelayMs = o.baseDelayMs ?? 500;
  }

  prepare(sql: string): DbStatement {
    return new HttpStatement(this, sql);
  }

  async batch(statements: DbStatement[]): Promise<unknown[]> {
    if (!statements.length) return [];
    const own = statements.map((s) => {
      if (!(s instanceof HttpStatement) || s.client !== this) throw new TypeError('D1 batch: statements must come from this client');
      return s;
    });
    return this.send(own);
  }

  /**
   * Confirms the API round-trips parameter types the way the binding does.
   * The published schema lists params as strings; if the API coerced numbers or
   * null to text, conditional writes (`status = ?11`, `awaiting_since IS ?12`)
   * would silently stop matching. Run once before ingest.
   */
  async selfCheck(): Promise<void> {
    const row = await this.prepare("SELECT ?1 AS i, ?2 AS s, ?3 AS z, typeof(?1) IN ('integer','real') AS numeric, ?1 = 7 AS eq, ?3 IS NULL AS is_null").bind(7, 'x', null).first();
    const ok = row && row.i === 7 && row.s === 'x' && row.z === null && row.numeric === 1 && row.eq === 1 && row.is_null === 1;
    if (!ok) throw new Error(`D1 REST self-check failed: parameters did not round-trip with their types (got ${JSON.stringify(row)})`);
  }

  /** @internal One HTTP request for one statement or a batch. */
  async send(statements: HttpStatement[]): Promise<ApiResult[]> {
    const body = statements.length === 1
      ? { sql: statements[0].sql, params: statements[0].params }
      : { batch: statements.map((s) => ({ sql: s.sql, params: s.params })) };
    const readOnly = statements.every((s) => isRead(s.sql));

    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < this.#maxRetries;
      let res: Response;
      try {
        this.requests++;
        res = await this.#fetch(this.#url, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.#token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err) {
        if (readOnly && canRetry) { await this.#sleep(this.#backoff(attempt)); continue; }
        throw new Error(`D1 API request failed (${(err as Error).name}: ${(err as Error).message})${readOnly ? ' after retries' : '; a write is not retried'}`);
      }

      if (res.status === 429 && canRetry) {
        const after = Number(res.headers.get('retry-after'));
        await this.#sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, MAX_RETRY_AFTER_MS) : this.#backoff(attempt));
        continue;
      }
      if (res.status >= 500 && readOnly && canRetry) {
        await this.#sleep(this.#backoff(attempt));
        continue;
      }

      const parsed = (await res.json().catch(() => ({}))) as ApiBody;
      const messages = (parsed.errors ?? []).map((e) => `${e.code ?? ''} ${e.message ?? ''}`.trim()).join('; ');
      if (!res.ok || parsed.success === false) {
        throw new Error(`D1 API ${res.status}${messages ? `: ${messages}` : ''}${res.status >= 500 && !readOnly ? ' (a write is not retried)' : ''}`);
      }
      const result = parsed.result ?? [];
      if (result.length !== statements.length || result.some((r) => r.success === false)) {
        throw new Error(`D1 API ${res.status}: ${result.length} results for ${statements.length} statements, or a statement failed`);
      }
      return result;
    }
  }

  #backoff(attempt: number) {
    return this.#baseDelayMs * 2 ** attempt;
  }
}
