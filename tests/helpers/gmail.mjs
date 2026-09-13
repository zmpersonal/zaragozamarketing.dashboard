// Fake Gmail API for ingest tests. Serves the token, threads.list and
// threads.get endpoints that src/ingest/gmail.ts calls, from an in-memory
// mailbox the test mutates between ingest runs.
import { makeD1 } from './d1.mjs';

export const MAILBOX = 'support@inhousewellness.com';
export const SOURCE_ID = `gmail:${MAILBOX}`;

export const at = (iso) => Date.parse(iso) / 1000;

/** Inbound message from a customer. */
export const inbound = (iso, from, subject = 'Sauna heater tripping the breaker') => ({
  iso, from, subject, labelIds: ['INBOX'],
});

/** Message we sent. Gmail puts SENT on everything sent from the mailbox, aliases included. */
export const outbound = (iso, from = `InHouse Support <${MAILBOX}>`, subject = 'Re: Sauna heater tripping the breaker') => ({
  iso, from, subject, labelIds: ['SENT'],
});

export function makeEnv() {
  const DB = makeD1();
  DB.raw.exec(`
    INSERT INTO source (id, brand_id, channel, provider, address)
    VALUES ('${SOURCE_ID}', 'inhouse', 'email', 'gmail', '${MAILBOX}');
  `);
  return {
    DB,
    GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-secret',
    GOOGLE_REFRESH_TOKENS: JSON.stringify({ [MAILBOX]: 'test-refresh' }),
  };
}

/** Run fn with fetch answering from `threads` ({ [threadId]: message[] }). */
export async function withGmail(threads, fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    const ok = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

    if (url.href === 'https://oauth2.googleapis.com/token') return ok({ access_token: 'test-access' });

    const path = url.pathname.replace('/gmail/v1/users/me/', '');
    if (path === 'threads') {
      return ok({ threads: Object.keys(threads).map((id) => ({ id })) });
    }
    if (path.startsWith('threads/')) {
      const id = path.slice('threads/'.length);
      const msgs = threads[id];
      if (!msgs) return new Response('not found', { status: 404 });
      return ok({
        id,
        snippet: msgs.at(-1).subject,
        messages: msgs.map((m, i) => ({
          id: `${id}-${i}`,
          threadId: id,
          internalDate: String(Date.parse(m.iso)),
          labelIds: m.labelIds,
          payload: { headers: [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject }] },
        })),
      });
    }
    throw new Error('unexpected fetch in test: ' + url.href);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

export const row = (env, threadId) =>
  env.DB.prepare('SELECT * FROM thread WHERE id = ?1').bind(`gmail:${threadId}`).first();
