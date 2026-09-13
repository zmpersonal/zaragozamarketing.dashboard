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
  await env.DB.prepare(`
    INSERT INTO thread (
      id, source_id, brand_id, channel, subject, customer_name,
      customer_handle, preview, status, is_automated,
      first_inbound_at, last_inbound_at
    ) VALUES (?1,?2,?3,'chat',?4,?5,'chat',?6,?7,?8,?9,?10)
    ON CONFLICT(id) DO UPDATE SET
      preview = excluded.preview,
      last_inbound_at = MAX(thread.last_inbound_at, excluded.last_inbound_at),
      is_automated = excluded.is_automated,
      status = CASE
        WHEN thread.status IN ('blocked','closed') THEN thread.status
        ELSE excluded.status
      END
  `).bind(
    `chat:${c.externalId}`, sourceId, c.brandId,
    'Chat — ' + c.preview.slice(0, 40),
    c.visitorName ?? 'Visitor',
    c.preview.slice(0, 200),
    c.awaitingHuman ? 'waiting' : 'answered',
    c.handledByBot ? 1 : 0,
    c.startedAt, c.lastInboundAt
  ).run();
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
