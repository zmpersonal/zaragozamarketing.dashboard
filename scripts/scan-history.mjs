#!/usr/bin/env node
/**
 * PRE-PUSH GUARD: no personal address anywhere in the history being pushed.
 *
 * tests/no-personal-addresses.test.mjs checks the working tree. A push
 * publishes the history, and a file deleted rounds ago is still in it. Round 7
 * purged a customer address from this branch; "we purged it five rounds ago" is
 * a memory, not a check. This is the check, and RUNBOOK §4 blocks on it.
 *
 *   node scripts/scan-history.mjs [ref]        # default HEAD
 *
 * Reads every blob, commit message and author/committer identity reachable
 * from the ref, and exits 1 on any address at a consumer mail domain. It
 * reports where, never what: printing the address would leak it into a
 * terminal, a scrollback or a CI log.
 *
 * The domain list is the one in tests/no-personal-addresses.test.mjs. Keep them
 * together; they exist for the same reason.
 */
import { spawnSync } from 'node:child_process';

const CONSUMER = ['icloud', 'me', 'mac', 'gmail', 'googlemail', 'yahoo', 'ymail', 'outlook', 'hotmail', 'live', 'msn', 'aol'];
const PERSONAL_ADDRESS = new RegExp(`[A-Za-z0-9._%+-]+@(?:${CONSUMER.join('|')})\\.[A-Za-z]{2,}(?:\\.[A-Za-z]{2,})?\\b`, 'i');

const REF = process.argv[2] ?? 'HEAD';
const MAX_REPORTED = 20;

function fail(msg) {
  console.error('\n  FAILED: ' + msg + '\n');
  process.exit(1);
}

function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
  if (r.error) fail(`could not run git: ${r.error.message}`);
  if (r.status !== 0) fail(`git ${args.slice(0, 2).join(' ')} failed: ${String(r.stderr).trim()}`);
  return r.stdout;
}

git(['rev-parse', '--verify', '--quiet', `${REF}^{commit}`]).trim() || fail(`${REF} is not a commit in this repository.`);

// --- commits: messages and identities -------------------------------------------------------
const SEP = '\u001e';
const commits = git(['log', `--format=${SEP}%H%n%an <%ae>%n%cn <%ce>%n%B`, REF])
  .split(SEP).slice(1)
  .map((record) => {
    const [sha, author, committer, ...message] = record.split('\n');
    return { sha, identity: `${author}\n${committer}`, message: message.join('\n') };
  });

// --- blobs ----------------------------------------------------------------------------------
// rev-list --objects gives "<sha> [path]" for every object reachable from the ref.
const pathBySha = new Map();
for (const line of git(['rev-list', '--objects', REF]).split('\n')) {
  if (!line) continue;
  const space = line.indexOf(' ');
  if (space > 0) pathBySha.set(line.slice(0, space), line.slice(space + 1));
  else pathBySha.set(line, null);
}
const checked = spawnSync('git', ['cat-file', '--batch-check'], {
  encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, input: [...pathBySha.keys()].join('\n') + '\n',
});
if (checked.status !== 0) fail(`git cat-file --batch-check failed: ${String(checked.stderr).trim()}`);
const blobShas = checked.stdout.split('\n')
  .map((l) => l.split(' '))
  .filter(([, type]) => type === 'blob')
  .map(([sha]) => sha);

const offenders = [];
if (blobShas.length) {
  // No `encoding`, so stdout comes back as a Buffer: a blob may be binary.
  const batch = spawnSync('git', ['cat-file', '--batch'], {
    maxBuffer: 1024 * 1024 * 1024, input: blobShas.join('\n') + '\n',
  });
  if (batch.status !== 0) fail(`git cat-file --batch failed: ${String(batch.stderr).trim()}`);
  const buf = batch.stdout;
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf(0x0a, i);
    if (nl < 0) break;
    const [sha, , size] = buf.toString('utf8', i, nl).split(' ');
    const start = nl + 1;
    const end = start + Number(size);
    const content = buf.subarray(start, end);
    i = end + 1; // git writes a newline after each object
    if (content.includes(0)) continue; // binary
    if (PERSONAL_ADDRESS.test(content.toString('utf8'))) {
      offenders.push(`file  ${pathBySha.get(sha) ?? '(no path)'}   — git log --oneline -- '${pathBySha.get(sha) ?? ''}'`);
    }
  }
}

for (const c of commits) {
  if (PERSONAL_ADDRESS.test(c.message)) offenders.push(`commit message  ${c.sha.slice(0, 9)}   — git show -s ${c.sha.slice(0, 9)}`);
  if (PERSONAL_ADDRESS.test(c.identity)) offenders.push(`author/committer identity  ${c.sha.slice(0, 9)}`);
}

console.log(`\n  Scanned ${commits.length} commits and ${blobShas.length} blobs reachable from ${REF}, for ${CONSUMER.length} consumer mail domains.`);

if (!offenders.length) {
  console.log(`  CLEAN: no consumer-domain address in the history of ${REF}.\n`);
  process.exit(0);
}

const unique = [...new Set(offenders)];
console.log('\n  Where they are (the address itself is never printed):');
for (const o of unique.slice(0, MAX_REPORTED)) console.log('    ' + o);
if (unique.length > MAX_REPORTED) console.log(`    … and ${unique.length - MAX_REPORTED} more`);
fail(
  `${unique.length} place(s) in the history of ${REF} hold an address at a consumer mail domain.\n` +
  '  Do not push. A push publishes every commit, not the working tree.\n' +
  '  Either rewrite the history (git filter-repo) and scan again, or push a branch that never held it.',
);
