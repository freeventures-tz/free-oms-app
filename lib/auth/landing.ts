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
