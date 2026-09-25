import type { NavItem } from "@/components/app-shell";
import type { AppRole } from "@/lib/auth/roles";

/**
 * Navigation per role (design.md §4.2). A user never sees an entry they cannot use — Director-only
 * destinations are HIDDEN from a Manager, not disabled, because a greyed control with a tooltip
 * leaks the authority structure (§4.3, §4.4).
 *
 * Hiding navigation is a usability measure. It is never the control: the same route refuses the
 * same user server-side, and the database refuses the work again underneath that.
 */
const NAV_BY_ROLE: Record<AppRole, NavItem[]> = {
  sales_rep: [
    { href: "/orders", labelKey: "nav.orders" },
    // Not "Inventory & stock", which §4.2 gives to a Manager and a Director alone. A Sales
    // Representative reaches receiving only because §9.1 lets a receipt be delegated to them, and
    // the screen offers them entry and no decision.
    { href: "/inventory/receiving", labelKey: "nav.receiving" },
  ],
  cashier: [
    { href: "/payments", labelKey: "nav.payments" },
    // §12.6 step 9 puts dispatch assignment on the Cashier, so the queue is theirs to clear.
    { href: "/dispatch", labelKey: "nav.dispatch" },
    { href: "/orders", labelKey: "nav.orders" },
    { href: "/inventory/receiving", labelKey: "nav.receiving" },
    // §13.3: the Cashier proposes imprest disbursements and sees what is free to approve.
    { href: "/imprest", labelKey: "nav.imprest" },
  ],
  manager: [
    { href: "/dashboard", labelKey: "nav.dashboard" },
    { href: "/orders", labelKey: "nav.orders" },
    { href: "/payments", labelKey: "nav.payments" },
    // §12.6 steps 11 and 13 are the Manager's: the physical note number, and the signed release.
    { href: "/dispatch", labelKey: "nav.dispatch" },
    { href: "/inventory", labelKey: "nav.inventory" },
    { href: "/inventory/receiving", labelKey: "nav.receiving" },
    { href: "/inventory/transfers", labelKey: "nav.transfers" },
    { href: "/inventory/adjustments", labelKey: "nav.adjustments" },
    // §4.1 gives batch entry, approval and inspection to the Manager, and names no alternate.
    { href: "/production", labelKey: "nav.production" },
    // §13.2: the Manager requests imprest funding and confirms what was handed over.
    { href: "/imprest", labelKey: "nav.imprest" },
    { href: "/settings/products", labelKey: "nav.products" },
    { href: "/settings/storekeepers", labelKey: "nav.storekeepers" },
    // §18.1 names the recipients of the daily report: both Directors and the Manager, and nobody
    // else. A Cashier and a Sales Representative are not offered the destination and would be
    // refused the route and the data underneath it.
    { href: "/reports", labelKey: "nav.reports" },
  ],
  director: [
    { href: "/dashboard", labelKey: "nav.dashboard" },
    { href: "/orders", labelKey: "nav.orders" },
    { href: "/payments", labelKey: "nav.payments" },
    // A Director READS the dispatch queue and decides nothing on it: §12.6 gives every step to a
    // Cashier or a Manager. What IS theirs here is approving a payment reversal (§4.1).
    { href: "/dispatch", labelKey: "nav.dispatch" },
    { href: "/inventory", labelKey: "nav.inventory" },
    // A Director READS receiving (design.md §4.2) and decides nothing on it: §4.1 names three
    // enterers and one approver, and a Director is none of them. The screen offers them no control
    // at all rather than a greyed one (§4.3, §4.4).
    { href: "/inventory/receiving", labelKey: "nav.receiving" },
    { href: "/inventory/transfers", labelKey: "nav.transfers" },
    // Corrections are the one stock screen where the Director is the decider (§4.1).
    { href: "/inventory/adjustments", labelKey: "nav.adjustments" },
    // A Director READS production and decides nothing on it, for the same reason as receiving:
    // §4.1 names the Manager for every step and no alternate.
    { href: "/production", labelKey: "nav.production" },
    // §13.2: a Director approves, provides and corrects imprest funding.
    { href: "/imprest", labelKey: "nav.imprest" },
    { href: "/settings/products", labelKey: "nav.products" },
    { href: "/settings/suppliers", labelKey: "nav.suppliers" },
    { href: "/settings/storekeepers", labelKey: "nav.storekeepers" },
    { href: "/reports", labelKey: "nav.reports" },
    { href: "/admin/accounts", labelKey: "nav.accounts" },
  ],
};

export function navItemsFor(role: AppRole): NavItem[] {
  return NAV_BY_ROLE[role];
}
