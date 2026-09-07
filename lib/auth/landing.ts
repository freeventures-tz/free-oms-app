import type { AppRole } from "@/lib/auth/roles";

/**
 * Role landing destinations (design.md §4.1). Resolved server-side from live state, never from the
 * JWT claim: the claim may choose a route, and this is that choice being made where the role is
 * known to be current.
 */
export const ROLE_LANDING: Record<AppRole, string> = {
  sales_rep: "/orders",
  cashier: "/payments",
  manager: "/dashboard",
  director: "/dashboard",
};

export function landingPathFor(role: AppRole): string {
  return ROLE_LANDING[role];
}

/**
 * Which roles a route belongs to. The route guard consults this; it is a usability and routing
 * concern, and the database refuses the same work independently.
 */
export const ROUTE_ROLES: { prefix: string; roles: readonly AppRole[] }[] = [
  { prefix: "/admin", roles: ["director"] },
  { prefix: "/dashboard", roles: ["manager", "director"] },
  { prefix: "/payments", roles: ["cashier", "manager", "director"] },
  { prefix: "/orders", roles: ["sales_rep", "cashier", "manager", "director"] },

  // Products & prices: Manager and Director only (design.md §4.2). A Manager reaches it to LOOK —
  // the price is read-only for them and the editing controls are absent, not greyed (§4.3).
  //
  // This is the SCREEN, not the data. Every live role may read the catalogue and its prices in the
  // database, because a Sales Representative cannot write an order without knowing what a thing
  // costs. Restricting the route is a navigation decision; nothing here is a secret.
  { prefix: "/settings/products", roles: ["manager", "director"] },

  // Dispatch: every role that touches a release. A Sales Representative is not one of them —
  // §12.6 steps 9 to 14 name the Cashier and the Manager, and a Director reads for oversight.
  { prefix: "/dispatch", roles: ["cashier", "manager", "director"] },

  // Storekeeper records: Director registers, Manager reads (product.md §3.2, design.md §4.2).
  { prefix: "/settings/storekeepers", roles: ["manager", "director"] },

  // Production: the Manager runs it and a Director reads it (design.md §4.2). §4.1 gives batch
  // entry, approval and inspection to the Manager and names no alternate, so a Director reaches
  // the screen for oversight and is offered no control on it. A Cashier and a Sales Representative
  // do not work a mixer and cannot reach the route at all.
  { prefix: "/production", roles: ["manager", "director"] },

  // Suppliers: Director registers, Manager reads (product.md §9 requires the record; who creates
  // one is a derived decision recorded in the Stage 10D plan).
  { prefix: "/settings/suppliers", roles: ["manager", "director"] },

  // Supplier receiving is the one stock route a Cashier and a Sales Representative reach, because
  // §9.1 lets receipt ENTRY be delegated to them. It is listed BEFORE `/inventory` so the more
  // specific prefix wins: `rolesAllowedFor` takes the first match, and `/inventory` would otherwise
  // swallow it and refuse both roles.
  { prefix: "/inventory/receiving", roles: ["sales_rep", "cashier", "manager", "director"] },

  // Everything else under Inventory is Manager and Director (design.md §4.2). What each of them may
  // DO there differs by screen and is decided by the database, not by this list.
  { prefix: "/inventory", roles: ["manager", "director"] },
];

export function rolesAllowedFor(pathname: string): readonly AppRole[] | null {
  const match = ROUTE_ROLES.find(
    (entry) => pathname === entry.prefix || pathname.startsWith(`${entry.prefix}/`),
  );
  return match ? match.roles : null;
}

export function roleMayAccess(role: AppRole, pathname: string): boolean {
  const allowed = rolesAllowedFor(pathname);
  return allowed === null ? true : allowed.includes(role);
}
