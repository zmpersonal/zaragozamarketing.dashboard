// Cloudflare Access on a Worker protects every hostname and path of that Worker
// (workers.dev, previews, custom domains), and its bypass is whole-Worker only
// (developers.cloudflare.com/workers/configuration/cloudflare-access, read round 11).
// Quo can't log in, so a webhook on the console Worker would be blocked the day
// Access is turned on. The webhook therefore runs as its own Worker with no
// Access, trusting only its signature, bound to the same database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import console_ from '../src/index.ts';
import hooks from '../src/hooks.ts';
import { makeQuoEnv, CUSTOMER } from './helpers/quo.mjs';
import { deliver, messageReceived } from './helpers/quo-webhook.mjs';

const toml = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8').replace(/#.*$/gm, '');
const value = (src, key) => src.match(new RegExp(`^\\s*${key}\\s*=\\s*"?([^"\\n]+)"?`, 'm'))?.[1];

test('the hooks Worker ingests a signed Quo delivery and serves nothing else', async () => {
  const env = makeQuoEnv();
  const r = await deliver(env, messageReceived({ cn: 'CN1', at: Math.floor(Date.now() / 1000) - 60, from: CUSTOMER }));
  assert.equal(r.status, 200);
  assert.equal(env.DB.raw.prepare("SELECT status FROM thread WHERE id = 'quo:CN1'").get().status, 'waiting');
  for (const path of ['/', '/index.html', '/api/queue', '/api/board', '/hooks/other']) {
    const res = await hooks.fetch(new Request(`https://inhouse-ops-hooks.example.workers.dev${path}`), { ...env, QUO_WEBHOOK_SECRET: 'whsec_AAAA' });
    assert.equal(res.status, 404, path);
  }
});

test('the console Worker no longer answers /hooks/quo (it will sit behind Access)', async () => {
  const res = await console_.fetch(new Request('https://inhouse-ops.example.workers.dev/hooks/quo', { method: 'POST', body: '{}' }), { ...makeQuoEnv(), ASSETS: { fetch: async () => new Response('asset') }, QUO_WEBHOOK_SECRET: 'whsec_AAAA' });
  assert.equal(res.status, 404);
});

test('both Workers bind the same D1 database; the hooks Worker has no static assets; preview URLs are off on both', () => {
  const main = toml('wrangler.toml');
  const hk = toml('wrangler.hooks.toml');
  assert.equal(value(hk, 'main'), 'src/hooks.ts');
  assert.equal(value(hk, 'name'), 'inhouse-ops-hooks');
  assert.equal(value(hk, 'database_id'), value(main, 'database_id'));
  assert.equal(value(hk, 'account_id'), value(main, 'account_id'));
  assert.doesNotMatch(hk, /\[assets\]/);
  for (const [name, src] of [['wrangler.toml', main], ['wrangler.hooks.toml', hk]]) {
    assert.equal(value(src, 'preview_urls'), 'false', `${name}: preview URLs would be a second, unprotected hostname`);
    assert.equal(value(src, 'workers_dev'), 'true', name);
  }
});

test('npm run build dry-runs both Workers', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts.build, /wrangler deploy --dry-run[^&]*&&[^&]*wrangler deploy --dry-run -c wrangler\.hooks\.toml/);
});
