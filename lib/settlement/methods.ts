/**
 * The six tenders of product.md §12.5, in a module a browser can import.
 *
 * It lives apart from `lib/settlement/commands.ts` for one reason, and the build found it: that
 * file imports `userApi`, which imports `next/headers`, which cannot exist in a client bundle. A
 * client component needing the list of payment buttons would drag the whole server client in
 * behind it. The catalogue keeps `unit-label.ts` separate from `catalogue.ts` for exactly this.
 *
 * CREDIT IS NOT HERE, and its absence is the point. §12.5 lists six ways money actually arrives and
 * then says plainly that credit "is not a tender" — it records no payment. A seventh entry in this
 * array would put a Credit button in a row of tender buttons, which is the presentation §12.5
 * forbids and the fastest route to a till that disagrees with the ledger.
 */
export const PAYMENT_METHODS = [
  "cash",
  "mixx_by_yas",
  "halopesa",
  "mwanga_hakika_transfer",
  "crdb_transfer",
  "cheque",
] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
