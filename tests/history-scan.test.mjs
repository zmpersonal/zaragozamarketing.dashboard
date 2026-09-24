// scripts/scan-history.mjs is the blocking check before the first push to main
// (RUNBOOK). The working tree being clean proves nothing: a customer address
// removed five rounds ago is still in the history a push publishes. The scan
// must read every blob and commit reachable from the ref being pushed, and
// must never print the address it found.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SCAN = join(ROOT, 'scripts', 'scan-history.mjs');

// Built at run time so this file never contains an address (no-personal-addresses.test.mjs).
const at = (local, domain) => `${local}${String.fromCharCode(64)}${domain}`;
const CONSUMER = ['icloud', 'me', 'mac', 'gmail', 'googlemail', 'yahoo', 'ymail', 'outlook', 'hotmail', 'live', 'msn', 'aol'];

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'scan-history-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test Person');
  git(dir, 'config', 'user.email', at('test', 'example.com'));
  return dir;
}
const commit = (dir, file, body, message = 'change') => {
  writeFileSync(join(dir, file), body);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
};
const scan = (cwd, ...args) => spawnSync(process.execPath, [SCAN, ...args], { cwd, encoding: 'utf8' });

test('a history with only fabricated addresses passes', () => {
  const dir = repo();
  commit(dir, 'notes.md', `write to ${at('someone', 'example.com')} or ${at('a.person', 'inhousewellness.com')}\n`);
  const r = scan(dir);
  assert.equal(r.status, 0, `exit ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /CLEAN/);
  rmSync(dir, { recursive: true, force: true });
});

test('an address deleted in a later commit is still found: the history is what gets pushed', () => {
  const dir = repo();
  const address = at('a.customer', 'icloud.com');
  commit(dir, 'fixture.mjs', `const from = '${address}';\n`, 'add a fixture');
  commit(dir, 'fixture.mjs', 'const from = null;\n', 'remove the address');
  assert.doesNotMatch(git(dir, 'show', 'HEAD:fixture.mjs'), /icloud/, 'the working tree is clean');

  const r = scan(dir);
  assert.equal(r.status, 1, `expected a blocking failure, got ${r.status}\n${r.stdout}${r.stderr}`);
  const output = r.stdout + r.stderr;
  assert.match(output, /fixture\.mjs/, 'names where it is');
  assert.doesNotMatch(output, new RegExp(address.replace('.', '\\.'), 'i'), 'never prints the address itself');
  rmSync(dir, { recursive: true, force: true });
});

test('every consumer mail domain is detected, in blobs and in commit messages', () => {
  for (const domain of CONSUMER) {
    const dir = repo();
    commit(dir, 'a.txt', `contact: ${at('first.last', domain + '.com')}\n`);
    assert.equal(scan(dir).status, 1, `${domain} in a file`);
    rmSync(dir, { recursive: true, force: true });

    const other = repo();
    commit(other, 'a.txt', 'nothing here\n', `reply to ${at('first.last', domain + '.co.uk')}`);
    const r = scan(other);
    assert.equal(r.status, 1, `${domain} in a commit message`);
    assert.match(r.stdout + r.stderr, /commit message/i);
    rmSync(other, { recursive: true, force: true });
  }
});

test('an author identity at a consumer domain is reported too: a push publishes it', () => {
  const dir = repo();
  git(dir, 'config', 'user.email', at('someone', 'gmail.com'));
  commit(dir, 'a.txt', 'nothing here\n');
  const r = scan(dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /author|committer/i);
  rmSync(dir, { recursive: true, force: true });
});

test('only the ref being pushed is scanned', () => {
  const dir = repo();
  commit(dir, 'a.txt', 'clean\n');
  git(dir, 'checkout', '-q', '-b', 'side');
  commit(dir, 'b.txt', `${at('a.customer', 'yahoo.com')}\n`);
  git(dir, 'checkout', '-q', 'main');

  assert.equal(scan(dir, 'main').status, 0, 'main is clean');
  assert.equal(scan(dir, 'side').status, 1, 'side is not');
  rmSync(dir, { recursive: true, force: true });
});

test('this branch is clean: the push in RUNBOOK §4 would pass', () => {
  const r = scan(ROOT, 'HEAD');
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});
