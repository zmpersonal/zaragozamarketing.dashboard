// The thread's start-of-conversation column is conversation_started_at.
// Its meaning: when the conversation began. Immutable. It is NOT the response
// clock; awaiting_since is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { makeD1 } from './helpers/d1.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

test('thread has conversation_started_at (NOT NULL) and no first_inbound_at', () => {
  const cols = makeD1().raw.prepare('PRAGMA table_info(thread)').all();
  const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
  assert.ok(byName.conversation_started_at, 'conversation_started_at column missing');
  assert.equal(byName.conversation_started_at.notnull, 1);
  assert.equal(byName.first_inbound_at, undefined, 'first_inbound_at must be gone');
});

test('no code, schema, UI, test or CLAUDE.md still says first_inbound_at', () => {
  // RUNLOG and HANDOFF are history and may name the old column.
  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
  const files = [
    ...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'tests')), ...walk(join(ROOT, 'public')),
    join(ROOT, 'schema.sql'), join(ROOT, 'CLAUDE.md'),
  ].filter((p) => !p.endsWith('schema.test.mjs'));

  const offenders = files.filter((p) => readFileSync(p, 'utf8').includes('first_inbound_at'))
    .map((p) => relative(ROOT, p));
  assert.deepEqual(offenders, []);
});
