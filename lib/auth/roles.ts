/**
 * Role and locale vocabulary, deliberately free of any server-only import.
 *
 * Client Components need these values (a role select, a language switcher), and the module that
 * RESOLVES a viewer reads cookies and the database. Keeping them apart is what stops
 * `next/headers` — and with it the whole server client — being pulled into a browser bundle.
 */

export type AppRole = "director" | "manager" | "cashier" | "sales_rep";
export type Locale = "en" | "sw";

/** Exactly one of these is active per user, enforced by a unique constraint on `user_roles`. */
export const APP_ROLES: readonly AppRole[] = ["director", "manager", "cashier", "sales_rep"];
