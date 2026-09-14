// Signed Quo webhook deliveries (Standard Webhooks, API 2026-03-30) built from
// the documented event payloads (www.quo.com/docs/2026-03-30/webhooks-event-payloads,
// read round 10), and a way to turn a fake Quo account's activity into the
// events Quo would have sent, so webhook and polling can be compared.
import worker from '../../src/hooks.ts';
import { PHONE } from './quo.mjs';

export const WEBHOOK_SECRET = 'whsec_' + Buffer.from('round-10-webhook-signing-key-0123456789').toString('base64');
const OUR_NUMBER = '+15125550100';
const nowSec = () => Math.floor(Date.now() / 1000);
const iso = (unixSec) => new Date(unixSec * 1000).toISOString();

async function mac(content) {
  const raw = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(content))).toString('base64');
}

let deliveries = 0;
/** POST one signed delivery to the Worker. Returns { status, body }. */
export async function deliver(env, event, { webhookId = `msg_${++deliveries}_${Math.random().toString(36).slice(2)}` } = {}) {
  const body = JSON.stringify(event);
  const ts = String(nowSec());
  const req = new Request('https://console.example/hooks/quo', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'webhook-id': webhookId, 'webhook-timestamp': ts, 'webhook-signature': `v1,${await mac(`${webhookId}.${ts}.${body}`)}` },
    body,
  });
  const res = await worker.fetch(req, { QUO_WEBHOOK_SECRET: WEBHOOK_SECRET, ...env });
  return { status: res.status, body: await res.json().catch(() => null), webhookId };
}

const envelope = (type, resource, context) => ({
  id: `EV${Math.random().toString(36).slice(2, 10)}`, apiVersion: '2026-03-30', createdAt: resource.createdAt, type,
  data: { resource, context: { orgId: 'OR1', userId: 'US1', ...context }, links: { quo: 'https://my.quo.com/inbox/x' } },
});
const messageContext = ({ cn, phone = PHONE, sender, recipients }) => ({
  phoneNumberId: phone, conversationId: cn, contacts: { ids: [], lookupStatus: 'none' }, senderIdentifier: sender, recipientIdentifiers: recipients,
});
const callContext = ({ cn, phone = PHONE, external }) => ({
  phoneNumberId: phone, conversationId: cn, phoneNumberType: 'shared', contacts: { ids: [], lookupStatus: 'none' },
  participants: { workspace: [OUR_NUMBER], external, resolution: 'available' },
});

export const messageReceived = ({ cn, at, from, text = `incoming at ${at}`, phone }) =>
  envelope('message.received', { id: `AC-m-${cn}-${at}`, direction: 'incoming', text, media: [], status: 'received', createdAt: iso(at) },
    messageContext({ cn, phone, sender: from, recipients: [OUR_NUMBER] }));

export const messageDelivered = ({ cn, at, to, text = `outgoing at ${at}`, phone }) =>
  envelope('message.delivered', { id: `AC-m-${cn}-${at}`, direction: 'outgoing', text, media: [], status: 'delivered', createdAt: iso(at) },
    messageContext({ cn, phone, sender: OUR_NUMBER, recipients: [to] }));

export const messageUndelivered = ({ cn, at, to, phone }) =>
  envelope('message.undelivered', { id: `AC-m-${cn}-${at}`, direction: 'outgoing', text: 'x', media: [], status: 'undelivered', errorCode: '30007', createdAt: iso(at) },
    messageContext({ cn, phone, sender: OUR_NUMBER, recipients: [to] }));

export const callCompleted = ({ cn, at, direction, answeredAfter = null, external, phone }) =>
  envelope('call.completed', {
    id: `AC-c-${cn}-${at}`, direction, status: answeredAfter === null ? 'unanswered' : 'answered', createdAt: iso(at),
    answeredAt: answeredAfter === null ? null : iso(at + answeredAfter), completedAt: iso(at + (answeredAfter ?? 0) + 60),
    updatedAt: iso(at + 60), duration: answeredAfter === null ? null : 60, hasVoicemail: false,
  }, callContext({ cn, phone, external }));

export const callMissed = ({ cn, at, external, phone }) =>
  envelope('call.missed', { id: `AC-c-${cn}-${at}`, createdAt: iso(at), updatedAt: iso(at + 30) }, callContext({ cn, phone, external }));

/** The events Quo would have sent for everything in a fake account (see helpers/quo.mjs), oldest first. */
export function eventsFor(account) {
  const out = [];
  for (const [cn, msgs] of Object.entries(account.messages)) {
    const customer = account.conversations[cn].participants[0];
    for (const m of msgs) {
      const at = Date.parse(m.createdAt) / 1000;
      out.push([at, m.direction === 'incoming' ? messageReceived({ cn, at, from: customer, text: m.text })
        : m.status === 'undelivered' ? messageUndelivered({ cn, at, to: customer })
        : messageDelivered({ cn, at, to: customer, text: m.text })]);
    }
  }
  for (const [cn, calls] of Object.entries(account.calls)) {
    const external = account.conversations[cn].participants;
    for (const c of calls) {
      const at = Date.parse(c.createdAt) / 1000;
      const answeredAfter = c.answeredAt ? Date.parse(c.answeredAt) / 1000 - at : null;
      out.push([at, callCompleted({ cn, at, direction: c.direction, answeredAfter, external })]);
    }
  }
  return out.sort((a, b) => a[0] - b[0]).map(([, e]) => e);
}
