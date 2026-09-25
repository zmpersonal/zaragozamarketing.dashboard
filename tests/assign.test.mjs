// Assignment (round 15). There is no agent table and there will not be one:
// identity is the Access JWT and OWNERS, as it has been since round 3. The
// people who can be assigned come from config (AGENTS), and who assigned whom
// is recorded the way every other human touch is — an action row with the
// actor's own address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { makeApiEnv, withAccess, mintToken, apiRequest, insertThread, OWNER } from './helpers/access.mjs';

const AGENT = 'dana.agent@inhousewellness.com';
const MARIANNE = 'marianne@inhousewellness.com';

function env0() {
  const env = makeApiEnv();
  env.AGENTS = `julian@inhousewellness.com, ${MARIANNE}, charlie@inhousewellness.com`;
  insertThread(env, { id: 'gmail:t1' });
  return env;
}
async function call(env, body, email = OWNER, path = 'threads/gmail%3At1/assign') {
  const token = await mintToken({ email });
  const res = await withAccess(() => worker.fetch(apiRequest(path, { token, method: 'POST', body }), env));
  return { status: res.status, body: await res.json() };
}
const thread = (env) => env.DB.raw.prepare("SELECT * FROM thread WHERE id = 'gmail:t1'").get();
const actions = (env) => env.DB.raw.prepare("SELECT * FROM action WHERE thread_id = 'gmail:t1' ORDER BY id").all();

test('assigning sets the assignee and logs who did it, to whom', async () => {
  const env = env0();
  assert.equal((await call(env, { assignee: MARIANNE })).status, 200);
  assert.equal(thread(env).assignee, MARIANNE);
  const [a] = actions(env);
  assert.equal(a.kind, 'assigned');
  assert.equal(a.actor, OWNER.toLowerCase(), 'the signed-in person, from the Access token');
  assert.match(a.body, new RegExp(MARIANNE));
});

test('unassigning is allowed, and is also logged', async () => {
  const env = env0();
  await call(env, { assignee: MARIANNE });
  assert.equal((await call(env, { assignee: null })).status, 200);
  assert.equal(thread(env).assignee, null);
  assert.equal(actions(env).length, 2);
  assert.match(actions(env)[1].body, /unassigned/i);
});

test('an agent can take a thread themselves', async () => {
  const env = env0();
  env.AGENTS = `${env.AGENTS}, ${AGENT}`;
  assert.equal((await call(env, { assignee: AGENT }, AGENT)).status, 200);
  assert.equal(thread(env).assignee, AGENT);
});

test('only someone the console knows can be assigned', async () => {
  const env = env0();
  const r = await call(env, { assignee: 'stranger@example.com' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /assignee/i);
  assert.equal(thread(env).assignee, null);
  assert.equal(actions(env).length, 0);
});

test('the shape is checked, and an unknown thread is a 404', async () => {
  const env = env0();
  assert.equal((await call(env, { assignee: 42 })).status, 400);
  assert.equal((await call(env, {})).status, 400, 'assignee is required, even to clear it');
  assert.equal((await call(env, { assignee: MARIANNE }, OWNER, 'threads/gmail%3Anope/assign')).status, 404);
});

test('the people who can be assigned reach the UI from config, owners included', async () => {
  const env = env0();
  const token = await mintToken({ email: OWNER });
  const res = await withAccess(() => worker.fetch(apiRequest('board', { token }), env));
  const body = await res.json();
  assert.deepEqual(body.agents, ['julian@inhousewellness.com', MARIANNE, 'charlie@inhousewellness.com']);
});

test('with AGENTS unset the picker is empty rather than wrong', async () => {
  const env = env0();
  delete env.AGENTS;
  const token = await mintToken({ email: OWNER });
  const res = await withAccess(() => worker.fetch(apiRequest('board', { token }), env));
  assert.deepEqual((await res.json()).agents, []);
  assert.equal((await call(env, { assignee: MARIANNE })).status, 400);
});
