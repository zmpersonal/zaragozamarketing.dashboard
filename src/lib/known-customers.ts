/**
 * Owner-verified customers: senders whose mail is always 'customer', even
 * when Gmail files it as spam. Exemptions beat every classifier signal.
 *
 * This is customer contact data in the repo, so keep it to addresses the
 * owner has verified by hand, each with why. Agents marking a sender real in
 * the console write sender_rule rows (verdict 'customer') instead.
 */
export const KNOWN_CUSTOMERS: ReadonlyArray<{ address: string; note: string }> = [
  {
    address: 'verified.customer@example.com',
    note: 'Round 5: Gmail filed "Track A Shipment - Priority1" as spam; owner verified a real customer (same person as customer.alt@example.com).',
  },
];

export const knownCustomerSet = () => new Set(KNOWN_CUSTOMERS.map((k) => k.address.toLowerCase()));
