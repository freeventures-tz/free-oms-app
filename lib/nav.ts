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
  sales_rep: [{ href: "/orders", labelKey: "nav.orders" }],
  cashier: [
    { href: "/payments", labelKey: "nav.payments" },
    { href: "/orders", labelKey: "nav.orders" },
  ],
  manager: [
    { href: "/dashboard", labelKey: "nav.dashboard" },
    { href: "/orders", labelKey: "nav.orders" },
    { href: "/payments", labelKey: "nav.payments" },
    { href: "/settings/products", labelKey: "nav.products" },
  ],
  director: [
    { href: "/dashboard", labelKey: "nav.dashboard" },
    { href: "/orders", labelKey: "nav.orders" },
    { href: "/payments", labelKey: "nav.payments" },
    { href: "/settings/products", labelKey: "nav.products" },
    { href: "/admin/accounts", labelKey: "nav.accounts" },
  ],
};

export function navItemsFor(role: AppRole): NavItem[] {
  return NAV_BY_ROLE[role];
}
