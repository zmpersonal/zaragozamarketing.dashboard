/**
 * inhouse-ops-hooks — the public webhook Worker (wrangler.hooks.toml).
 *
 * Cloudflare Access on a Worker covers every hostname and path it serves, and
 * can only be bypassed for the whole Worker. The console must be behind Access
 * and Quo can't sign in, so the webhook lives here instead: no Access, no UI,
 * no API, only /hooks/quo, trusted by its signature. Same D1 database.
 */
import { handleQuoWebhook, type HooksEnv } from './webhook.ts';

export default {
  async fetch(req: Request, env: HooksEnv): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/hooks/quo') return handleQuoWebhook(req, env);
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  },
};
