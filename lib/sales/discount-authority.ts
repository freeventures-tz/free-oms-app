import type { AppRole } from "@/lib/auth/roles";

/**
 * Whose decision a discount is (product.md §4).
 *
 *   "Manager approval of discounts: up to 5%, and only for orders above TZS 1,000,000.
 *    Anything beyond these limits requires Director approval."
 *
 * This is a COPY of a rule the database owns. `private.discount_needs_director` is the authority,
 * re-checked inside both `api.staff_approve_discount` and `api.staff_reject_discount` against the
 * order total as it stands at the moment of the decision. Nothing here can grant anybody anything:
 * a Manager who reaches the approve command anyway is refused by the database.
 *
 * It exists so the screen does not OFFER a decision the person cannot make. design.md §4.4 puts
 * that under "hidden": their role can never decide this particular discount, and greying a control
 * they will never be able to use — on an order that will never grow — teaches nothing. The two
 * copies are kept honest by a unit test on this file and a pgTAP assertion on the function, over
 * the same boundary values.
 */

export const MANAGER_DISCOUNT_MAX_PERCENT = 5;
export const MANAGER_DISCOUNT_MIN_SUBTOTAL_TZS = 1_000_000;

/** Above 5%, OR any discount at all on an order of TZS 1,000,000 or below. */
export function discountNeedsDirector(percent: number, subtotalTzs: number): boolean {
  return percent > MANAGER_DISCOUNT_MAX_PERCENT || subtotalTzs <= MANAGER_DISCOUNT_MIN_SUBTOTAL_TZS;
}

/**
 * Whether THIS person may decide THIS discount — approve it or reject it.
 *
 * Rejection is not a lesser decision than approval. §4.3 makes it a completed decision that closes
 * the request, so a Manager who could refuse a discount only a Director may grant would be deciding
 * it either way, and no Director would ever see it.
 */
export function mayDecideDiscount(
  role: AppRole,
  percent: number,
  subtotalTzs: number,
): boolean {
  if (role === "director") return true;
  if (role !== "manager") return false;
  return !discountNeedsDirector(percent, subtotalTzs);
}
