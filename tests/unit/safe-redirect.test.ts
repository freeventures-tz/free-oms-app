import { describe, expect, it } from "vitest";

import { safeNextPath } from "@/lib/auth/safe-redirect";

/**
 * The previous rule was `next.startsWith("/")`. `//evil.example` satisfies it, and a browser
 * resolves that to another origin — an open redirect on the one screen where a member of staff has
 * just typed their password.
 */
describe("sign-in redirect targets", () => {
  it("accepts ordinary same-origin paths", () => {
    expect(safeNextPath("/orders")).toBe("/orders");
    expect(safeNextPath("/admin/accounts")).toBe("/admin/accounts");
    expect(safeNextPath("/orders?status=open")).toBe("/orders?status=open");
    expect(safeNextPath("/orders#top")).toBe("/orders#top");
  });

  it("rejects protocol-relative URLs", () => {
    expect(safeNextPath("//evil.example")).toBeNull();
    expect(safeNextPath("//evil.example/orders")).toBeNull();
    expect(safeNextPath("///evil.example")).toBeNull();
  });

  it("rejects absolute URLs", () => {
    expect(safeNextPath("https://evil.example")).toBeNull();
    expect(safeNextPath("http://evil.example/orders")).toBeNull();
    expect(safeNextPath("javascript:alert(1)")).toBeNull();
    expect(safeNextPath("data:text/html,<script>")).toBeNull();
  });

  it("rejects backslash variants, which browsers treat as slashes", () => {
    expect(safeNextPath("\\\\evil.example")).toBeNull();
    expect(safeNextPath("/\\evil.example")).toBeNull();
    expect(safeNextPath("\\/evil.example")).toBeNull();
    expect(safeNextPath("/orders\\..\\admin")).toBeNull();
  });

  it("rejects control characters and whitespace used to smuggle a scheme", () => {
    const TAB = String.fromCharCode(9);
    const NEWLINE = String.fromCharCode(10);
    const NUL = String.fromCharCode(0);

    expect(safeNextPath("/ /evil.example")).toBeNull();
    expect(safeNextPath(TAB + "//evil.example")).toBeNull();
    expect(safeNextPath("/orders" + NEWLINE + "/admin")).toBeNull();
    expect(safeNextPath("/ orders")).toBeNull();
    expect(safeNextPath("java" + TAB + "script:alert(1)")).toBeNull();
    expect(safeNextPath("/orders" + NUL)).toBeNull();
  });

  it("rejects anything that is not a rooted path", () => {
    expect(safeNextPath("orders")).toBeNull();
    expect(safeNextPath("")).toBeNull();
    expect(safeNextPath("   ")).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath(42)).toBeNull();
    expect(safeNextPath(`/${"a".repeat(600)}`)).toBeNull();
  });

  it("never returns a value whose origin differs from the application's", () => {
    const candidates = [
      "//evil.example",
      "https://evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "//evil.example\\@good",
    ];

    for (const candidate of candidates) {
      const result = safeNextPath(candidate);
      if (result === null) continue;
      expect(new URL(result, "http://app.local").origin, candidate).toBe("http://app.local");
    }
  });
});
