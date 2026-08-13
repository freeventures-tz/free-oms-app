import { describe, expect, it } from "vitest";

import { landingPathFor, roleMayAccess } from "@/lib/auth/landing";
import { navItemsFor } from "@/lib/nav";
import { APP_ROLES } from "@/lib/auth/roles";

describe("role landing destinations", () => {
  it("matches the approved destinations (design.md §4.1)", () => {
    expect(landingPathFor("sales_rep")).toBe("/orders");
    expect(landingPathFor("cashier")).toBe("/payments");
    expect(landingPathFor("manager")).toBe("/dashboard");
    expect(landingPathFor("director")).toBe("/dashboard");
  });

  it("gives every role a landing page that its own role may open", () => {
    for (const role of APP_ROLES) {
      expect(roleMayAccess(role, landingPathFor(role)), role).toBe(true);
    }
  });
});

describe("route access", () => {
  it("keeps account administration to Directors", () => {
    expect(roleMayAccess("director", "/admin/accounts")).toBe(true);
    for (const role of ["manager", "cashier", "sales_rep"] as const) {
      expect(roleMayAccess(role, "/admin/accounts"), role).toBe(false);
    }
  });

  it("keeps the management dashboard to Manager and Director", () => {
    expect(roleMayAccess("manager", "/dashboard")).toBe(true);
    expect(roleMayAccess("director", "/dashboard")).toBe(true);
    expect(roleMayAccess("cashier", "/dashboard")).toBe(false);
    expect(roleMayAccess("sales_rep", "/dashboard")).toBe(false);
  });

  it("applies to nested paths, not just the exact prefix", () => {
    expect(roleMayAccess("manager", "/admin/accounts/anything")).toBe(false);
  });
});

describe("navigation", () => {
  it("never offers a destination the role cannot open", () => {
    for (const role of APP_ROLES) {
      for (const item of navItemsFor(role)) {
        expect(roleMayAccess(role, item.href), `${role} -> ${item.href}`).toBe(true);
      }
    }
  });

  it("hides account administration from everyone but a Director", () => {
    for (const role of ["manager", "cashier", "sales_rep"] as const) {
      expect(navItemsFor(role).some((item) => item.href.startsWith("/admin"))).toBe(false);
    }
    expect(navItemsFor("director").some((item) => item.href === "/admin/accounts")).toBe(true);
  });

  it("starts each role on its landing destination", () => {
    for (const role of APP_ROLES) {
      expect(navItemsFor(role)[0].href, role).toBe(landingPathFor(role));
    }
  });
});
