/**
 * Chat ingest — provider-agnostic on purpose.
 *
 * Chat is the one channel where the provider isn't settled yet, so this
 * normalises whatever arrives into the same thread shape as email and phone.
 * Wire the provider's outgoing webhook to POST here.
 *
 * is_automated matters: a conversation the bot fully handled shouldn't sit
 * in the waiting count, but you still want to see it, because a bot that
 * "handled" something badly is how you lose a sale quietly.
 */
import type { Env } from '../index.ts';
import { syncThread } from '../db/threads.ts';

export interface NormalisedChat {
  externalId: string;
  brandId: string;
  visitorName?: string;
  preview: string;
  startedAt: number;        // unix seconds
  lastInboundAt: number;
  awaitingHuman: boolean;   // bot escalated, or visitor asked again
  handledByBot: boolean;
}

export async function upsertChat(env: Env, sourceId: string, c: NormalisedChat) {
  // The provider reports a state, not a message history. Model it as the
  // latest visitor message, followed by a reply at the same instant when
  // nobody is waiting on a human, so lib/thread-state.ts applies the same
  // waiting / reopen rules as email and phone.
  const timeline = [{ at: c.lastInboundAt, inbound: true }];
  if (!c.awaitingHuman) timeline.push({ at: c.lastInboundAt, inbound: false });

  await syncThread(env.DB, {
    id: `chat:${c.externalId}`,
    source_id: sourceId,
    brand_id: c.brandId,
    channel: 'chat',
    subject: 'Chat — ' + c.preview.slice(0, 40),
    customer_name: c.visitorName ?? 'Visitor',
    customer_handle: 'chat',
    refresh_customer: false,
    preview: c.preview.slice(0, 200),
    conversation_started_at: c.startedAt,
    newest_inbound_at: c.lastInboundAt,
    newest_outbound_at: null,
    timeline,
    is_automated: c.handledByBot ? 1 : 0,
  }, Math.floor(Date.now() / 1000));
}

/** Example adapter. Replace the field names once the provider is chosen. */
export function fromTidio(payload: any, brandId: string): NormalisedChat {
  return {
    externalId: payload.conversation_id,
    brandId,
    visitorName: payload.visitor?.name,
    preview: payload.last_message?.text ?? '',
    startedAt: Math.floor(new Date(payload.created_at).getTime() / 1000),
    lastInboundAt: Math.floor(new Date(payload.last_message?.at ?? payload.created_at).getTime() / 1000),
    awaitingHuman: payload.status === 'waiting_for_operator',
    handledByBot: payload.handled_by === 'lyro',
  };
}
