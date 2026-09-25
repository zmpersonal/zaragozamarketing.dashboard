/**
 * Deep links into the provider's own app (round 15).
 *
 * The admin report exists so the owner can read how something was answered,
 * which means opening the real thread, not a copy of it. Both shapes are the
 * documented ones:
 *   Gmail  mail.google.com/mail/u/<mailbox>/#all/<threadId>
 *          `u/<mailbox>` rather than u/0, so it opens in the support mailbox
 *          even when the browser is signed into several accounts, and `#all`
 *          so an archived, filtered or spam-filed thread still opens.
 *   Quo    my.quo.com/inbox/<phoneNumberId>/c/<conversationId>
 *          (www.quo.com/docs/2026-03-30/webhooks-event-payloads, `links.quo`)
 *
 * Both parts are checked against a strict shape rather than escaped: a thread
 * id comes from a provider and the source address from the database, and
 * neither is allowed to shape the URL. Anything that doesn't fit returns null,
 * so the UI shows no link rather than a broken or hostile one.
 */
/** Provider ids: Gmail thread ids are hex, Quo ids are CN…/PN…. Nothing else is a link. */
const NATIVE_ID = /^[A-Za-z0-9_-]+$/;
const MAILBOX = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const PHONE_NUMBER_ID = /^PN[A-Za-z0-9]+$/;

export function threadLink(
  thread: { id: string; channel?: string | null },
  sourceAddress: string | null | undefined,
): string | null {
  if (!sourceAddress) return null;
  const colon = thread.id.indexOf(':');
  if (colon <= 0) return null;
  const provider = thread.id.slice(0, colon);
  const nativeId = thread.id.slice(colon + 1);
  if (!NATIVE_ID.test(nativeId)) return null;

  if (provider === 'gmail' && MAILBOX.test(sourceAddress)) {
    return `https://mail.google.com/mail/u/${sourceAddress}/#all/${nativeId}`;
  }
  if (provider === 'quo' && PHONE_NUMBER_ID.test(sourceAddress)) {
    return `https://my.quo.com/inbox/${sourceAddress}/c/${nativeId}`;
  }
  return null;
}
