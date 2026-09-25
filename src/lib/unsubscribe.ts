/**
 * List-Unsubscribe, parsed for the agent (round 15).
 *
 * What the real mailbox carries (prove/unsubscribe.mjs, 30 days, 297 threads):
 * 76 have the header, none of them mailto-only, 49 https-only, 27 both, and 63
 * advertise RFC 8058 one-click.
 *
 * This parses; it never acts. We hold gmail.readonly, so nothing here can send
 * the mailto on the mailbox's behalf, and the one-click POST is deliberately
 * not made from the Worker — see HANDOFF, "Unsubscribe".
 *
 * The header comes from the sender, so only http, https and mailto survive:
 * a javascript: or data: URL in a link the agent clicks would be the sender
 * choosing what our console runs.
 */
export interface Unsubscribe {
  /** http(s) link for the agent to open, or null. */
  url: string | null;
  /** mailto: URI, or null. Opens the agent's own mail client, not the mailbox. */
  mailto: string | null;
  /** The sender advertises RFC 8058 one-click. Reported only. */
  one_click: boolean;
}

const NONE: Unsubscribe = { url: null, mailto: null, one_click: false };

export function parseUnsubscribe(header: unknown, post?: unknown): Unsubscribe {
  if (typeof header !== 'string') return { ...NONE };
  // RFC 2369: one or more <URI> entries, comma separated. A bare URI is not valid.
  const uris = [...header.matchAll(/<([^>]*)>/g)].map((m) => m[1].trim());
  const scheme = (u: string) => u.slice(0, u.indexOf(':')).toLowerCase();
  return {
    url: uris.find((u) => scheme(u) === 'https' || scheme(u) === 'http') ?? null,
    mailto: uris.find((u) => scheme(u) === 'mailto') ?? null,
    one_click: typeof post === 'string' && /one-click/i.test(post),
  };
}
