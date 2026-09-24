// prove/quo.mjs is run by hand before trusting Quo. It must call the same v1
// endpoints and apply the same timeline rules as src/ingest/quo.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

function runProve(extraEnv = {}, args = []) {
  const log = join(mkdtempSync(join(tmpdir(), 'prove-quo-')), 'requests.log');
  const r = spawnSync(process.execPath, ['--import', './tests/helpers/quo-preload.mjs', 'prove/quo.mjs', ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, QUO_API_KEY: 'test-key', PROVE_REQUEST_LOG: log, ...extraEnv },
  });
  let paths = [];
  try { paths = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean); } catch {}
  return { ...r, paths };
}

test('prove/quo.mjs runs against the v1 API and reports waiting vs answered', async () => {
  const r = runProve();
  assert.equal(r.status, 0, `exit ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /InHouse Support/);
  assert.match(r.stdout, /WAITING.*Marcus Bell/);
  assert.match(r.stdout, /answered.*Rosa Lim/);
});

test('prove/quo.mjs only calls documented v1 endpoints', async () => {
  const r = runProve();
  assert.ok(r.paths.length > 0, 'made requests');
  const nonV1 = r.paths.filter((p) => !p.startsWith('/v1/'));
  assert.deepEqual(nonV1, []);
  assert.ok(r.paths.includes('/v1/messages'), 'reads messages, not only conversation summaries');
});

test('prove/quo.mjs fails clearly without QUO_API_KEY', async () => {
  const r = runProve({ QUO_API_KEY: '' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /QUO_API_KEY/);
});

// RUNBOOK §0 needs the phone-number id and nothing else. Reading conversations
// to find it prints customer names, numbers and message text to a terminal.
test('--quiet prints the phone-number ids only, and reads no conversation', async () => {
  const r = runProve({}, ['--quiet']);
  assert.equal(r.status, 0, `exit ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.equal(r.stdout, 'PN1\n');
  assert.equal(r.stderr, '');
  assert.deepEqual(r.paths, ['/v1/phone-numbers'], 'one request: the number list');
});

test('--quiet still fails clearly without QUO_API_KEY', async () => {
  const r = runProve({ QUO_API_KEY: '' }, ['--quiet']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /QUO_API_KEY/);
});
