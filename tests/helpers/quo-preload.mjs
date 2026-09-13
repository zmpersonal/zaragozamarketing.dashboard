// Preloaded with `node --import` so a CLI script (prove/quo.mjs) runs against
// the fake Quo v1 API. Every requested URL is appended to PROVE_REQUEST_LOG.
import { appendFileSync } from 'node:fs';
import { makeQuoAccount, withQuo } from './quo.mjs';

const now = Math.floor(Date.now() / 1000);
const account = makeQuoAccount();
account.conversation('CN1', { participants: ['+15125550142'], name: 'Marcus Bell', createdAt: now - 5 * 3600 });
account.text('CN1', now - 3 * 3600, 'incoming');
account.conversation('CN2', { participants: ['+17375550198'], name: 'Rosa Lim', createdAt: now - 5 * 3600 });
account.text('CN2', now - 4 * 3600, 'incoming');
account.text('CN2', now - 2 * 3600, 'outgoing');

// withQuo swaps globalThis.fetch for the duration of fn; keep it swapped for the whole process.
let release;
withQuo(account, () => new Promise((r) => { release = r; }));
const fake = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url ?? String(input);
  if (process.env.PROVE_REQUEST_LOG) appendFileSync(process.env.PROVE_REQUEST_LOG, new URL(url).pathname + '\n');
  return fake(input, init);
};
process.on('beforeExit', () => release?.());
