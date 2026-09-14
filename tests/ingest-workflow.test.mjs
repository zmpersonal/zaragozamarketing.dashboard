// .github/workflows/ingest.yml: hourly ingest on GitHub Actions. Static checks
// on the workflow (schedule, secrets handling, timeout, minutes budget) and a
// behavioural test of the keepalive step against a local git remote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUN_LIMITS } from '../scripts/_ingest-run.mjs';

const YML = readFileSync(new URL('../.github/workflows/ingest.yml', import.meta.url), 'utf8');
const lines = YML.split('\n');
const SECRETS = ['GOOGLE_SERVICE_ACCOUNT_JSON', 'QUO_API_KEY', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_D1_DATABASE_ID'];

// GitHub Free: 2,000 Actions minutes a month for private repos; billing rounds each job up to the minute.
const FREE_MINUTES = 2000;
const RUNS_PER_MONTH = Math.ceil(24 * 365 / 12); // 730

test('runs hourly on a schedule, and by hand', () => {
  const crons = [...YML.matchAll(/^\s*- cron: '([^']+)'/gm)].map((m) => m[1]);
  assert.equal(crons.length, 1);
  assert.match(crons[0], /^([1-9]|[1-5]\d) \* \* \* \*$/, 'once an hour, off the top of the hour');
  assert.match(YML, /^\s*workflow_dispatch:\s*$/m);
});

test('Actions minutes: even if every run hit the job timeout, the month fits in the free allowance with margin', () => {
  const timeout = Number(YML.match(/^\s*timeout-minutes:\s*(\d+)\s*$/m)?.[1]);
  assert.ok(timeout > 0, 'a job timeout is set');
  const worst = RUNS_PER_MONTH * timeout;
  assert.ok(worst <= FREE_MINUTES * 0.75, `worst case ${worst} of ${FREE_MINUTES} minutes`);
  assert.ok(RUN_LIMITS.quoSeconds + 30 <= timeout * 60, 'the run deadline leaves time for setup and the last item inside the timeout');
  assert.equal([...YML.matchAll(/^\s*runs-on:/gm)].length, 1, 'one job: a second job would double the billed minutes');
});

test('secrets reach the ingest step only as environment variables, and are never echoed', () => {
  for (const name of SECRETS) assert.match(YML, new RegExp(`^\\s+${name}: \\$\\{\\{ secrets\\.${name} \\}\\}\\s*$`, 'm'), name);
  for (const [i, line] of lines.entries()) {
    if (!line.includes('secrets.')) continue;
    assert.match(line, /^\s+[A-Z0-9_]+: \$\{\{ secrets\.[A-Z0-9_]+ \}\}\s*$/, `line ${i + 1} uses a secret outside an env mapping: ${line}`);
  }
  assert.doesNotMatch(YML, /set -x|set -o xtrace|ACTIONS_STEP_DEBUG|ACTIONS_RUNNER_DEBUG|printenv|\benv\s*$|\becho\b[^\n]*(TOKEN|KEY|JSON)/m);
  assert.doesNotMatch(YML, /continue-on-error/, 'an ingest failure must turn the run red');
  assert.match(YML, /run: node scripts\/ingest\.mjs\s*$/m);
  assert.match(YML, /persist-credentials: false/, 'the checkout token is not left in .git/config for the ingest step');
});

test('least privilege, no overlapping runs, official actions only', () => {
  const perms = YML.match(/^permissions:\n((?:\s{2}.+\n)+)/m)?.[1].trim().split('\n').map((l) => l.trim());
  assert.deepEqual(perms, ['contents: write  # keepalive only: an empty commit after 45 quiet days']);
  assert.match(YML, /^concurrency:\n\s+group: ingest\n\s+cancel-in-progress: false/m);
  for (const m of YML.matchAll(/uses: ([^@\s]+)@/g)) assert.match(m[1], /^actions\//, m[1]);
});

// --- keepalive ------------------------------------------------------------------------------

function keepaliveScript() {
  const start = lines.findIndex((l) => /name: Keepalive/.test(l));
  assert.ok(start >= 0, 'a Keepalive step exists');
  const runAt = lines.findIndex((l, i) => i > start && /^\s+run: \|\s*$/.test(l));
  const indent = lines[runAt + 1].match(/^\s*/)[0].length;
  const body = [];
  for (const l of lines.slice(runAt + 1)) { if (l.trim() && l.match(/^\s*/)[0].length < indent) break; body.push(l.slice(indent)); }
  return { step: lines.slice(start, runAt).join('\n'), script: body.join('\n') };
}

function repoQuietFor(days) {
  const dir = mkdtempSync(join(tmpdir(), 'keepalive-'));
  const git = (args, cwd, env = {}) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  git(['init', '-q', '--bare', 'remote.git'], dir);
  git(['clone', '-q', 'remote.git', 'work'], dir);
  const work = join(dir, 'work');
  writeFileSync(join(work, 'f'), 'x');
  git(['add', 'f'], work);
  const when = new Date(Date.now() - days * 86400_000).toISOString();
  git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'old'], work, { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
  git(['push', '-q', 'origin', 'HEAD:main'], work);
  return { dir, work, count: () => git(['rev-list', '--count', 'main'], join(dir, 'remote.git')).stdout.trim() };
}

test('keepalive only runs on the schedule, before ingest, so a failed or timed-out ingest cannot skip it', () => {
  const { step } = keepaliveScript();
  assert.match(step, /if: github\.event_name == 'schedule'/);
  assert.ok(lines.findIndex((l) => /name: Keepalive/.test(l)) < lines.findIndex((l) => /run: node scripts\/ingest\.mjs/.test(l)));
});

test('keepalive: a repo quiet for 45+ days gets one empty commit pushed; a recently active one is left alone; the token is not printed', () => {
  const { script } = keepaliveScript();
  for (const [days, expected] of [[50, '2'], [10, '1']]) {
    const repo = repoQuietFor(days);
    const r = spawnSync('bash', ['-c', script], {
      cwd: repo.work, encoding: 'utf8',
      env: { ...process.env, GH_TOKEN: 'ghs_SECRET_token_abc123', GITHUB_REPOSITORY: 'owner/repo', GITHUB_REF_NAME: 'main', KEEPALIVE_REMOTE: join(repo.dir, 'remote.git') },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(repo.count(), expected, `${days} days quiet`);
    assert.ok(!(r.stdout + r.stderr).includes('ghs_SECRET_token_abc123'));
  }
});
