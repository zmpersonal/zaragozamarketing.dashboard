// Stand-in for Cloudflare's D1 REST API (POST /accounts/{account}/d1/database/{db}/query),
// executing statements on node:sqlite over the real schema.sql. Request and response shapes
// follow developers.cloudflare.com/api/resources/d1/subresources/database/methods/query
// (read round 9): body {sql, params} or {batch: [{sql, params}]}; response
// {success, errors, messages, result: [{success, results, meta: {changes, ...}}]}.
// A batch runs in one transaction. Failures can be scripted per request.
import { makeD1 } from './d1.mjs';

export const ACCOUNT = 'acct-test-0001';
export const DATABASE = 'db-test-0001';
export const TOKEN = 'cf-token-SECRET-do-not-print-7f3a';
export const QUERY_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`;

/**
 * api.failures: queue of scripted responses consumed one per request before executing:
 *   { status: 429, retryAfter: '2' } | { status: 503 } | { network: true } | { status: 400, message }
 *   | { statementFailed: true } (HTTP 200, but the statement's own success is false)
 * api.requests: every request body received (parsed), with its auth header.
 * api.stringifyParams: simulate an API that turns every param into a string.
 * api.atomicBatch = false: simulate a batch that commits each statement as it goes.
 */
export function makeD1Rest(db = makeD1()) {
  const api = { db, requests: [], failures: [], stringifyParams: false, atomicBatch: true };
  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const error = (status, message, code = 7500) => json({ success: false, errors: [{ code, message }], messages: [], result: [] }, status);

  const exec = (sql, params = []) => {
    const values = api.stringifyParams ? params.map((p) => (p === null ? null : String(p))) : params;
    const stmt = db.raw.prepare(sql);
    if (stmt.columns().length) {
      const results = stmt.all(...values).map((r) => ({ ...r }));
      return { success: true, results, meta: { changes: 0, rows_read: results.length, rows_written: 0 } };
    }
    const r = stmt.run(...values);
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid), rows_read: 0, rows_written: Number(r.changes) } };
  };

  api.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url ?? String(input);
    if (url !== QUERY_URL || init.method !== 'POST') return error(404, `no route ${init.method} ${url}`, 7003);
    const auth = new Headers(init.headers).get('authorization');
    const body = JSON.parse(init.body);
    api.requests.push({ body, auth });
    if (auth !== `Bearer ${TOKEN}`) return error(401, 'Authentication error', 10000);
    const scripted = api.failures.shift();
    if (scripted?.network) throw new TypeError('fetch failed');
    if (scripted?.status === 429) return json({ success: false, errors: [{ code: 971, message: 'Please wait and consider throttling your request speed' }], result: [] }, 429, scripted.retryAfter ? { 'retry-after': scripted.retryAfter } : {});
    if (scripted?.status) return error(scripted.status, scripted.message ?? `upstream ${scripted.status}`);
    if (scripted?.statementFailed) return json({ success: true, errors: [], messages: [], result: [{ success: false, results: [], meta: { changes: 0 } }] });

    const statements = body.batch ?? [{ sql: body.sql, params: body.params }];
    if (!api.atomicBatch) {
      const result = [];
      try { for (const s of statements) result.push(exec(s.sql, s.params ?? [])); }
      catch (err) { return error(400, `${err.message}: SQLITE_ERROR`); }
      return json({ success: true, errors: [], messages: [], result });
    }
    db.raw.exec('BEGIN');
    try {
      const result = statements.map((s) => exec(s.sql, s.params ?? []));
      db.raw.exec('COMMIT');
      return json({ success: true, errors: [], messages: [], result });
    } catch (err) {
      db.raw.exec('ROLLBACK');
      return error(400, `${err.message}: SQLITE_ERROR`);
    }
  };
  return api;
}
