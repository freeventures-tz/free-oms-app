import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import en from "@/messages/en.json";

/**
 * The application shell: the one piece of interface every screen sits inside (design.md §3, §11).
 *
 * jsdom has no layout, so what is asserted here is what does not depend on a viewport: which item is
 * current, what each control is called, how the drawer behaves as a dialog, and where focus goes.
 * Breakpoint layout is the e2e suite's job (`e2e/responsive-shell.spec.ts`).
 */

let pathname = "/dashboard";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

// The real `Link` needs the app router mounted around it. What the shell owes is an anchor with the
// right name and `aria-current`, and a link status to read, so that is all this stands in for.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    onClick,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    onClick?: (event: React.MouseEvent) => void;
  } & Record<string, unknown>) => (
    <a
      href={href}
      {...rest}
      onClick={(event) => {
        // jsdom cannot load another document; the router would have prevented this too.
        event.preventDefault();
        onClick?.(event);
      }}
    >
      {children}
    </a>
  ),
  useLinkStatus: () => ({ pending: false }),
}));

vi.mock("@/app/actions/locale", () => ({ setLocale: vi.fn() }));

const { AppShell } = await import("@/components/app-shell");
const { FALLBACK_NAV_ICON, activeHrefFor, navIconFor } = await import("@/components/nav-icons");
const { Boxes, PackagePlus } = await import("lucide-react");

const DIRECTOR_STOCK = [
  { href: "/dashboard", labelKey: "nav.dashboard" },
  { href: "/inventory", labelKey: "nav.inventory" },
  { href: "/inventory/receiving", labelKey: "nav.receiving" },
  { href: "/settings/storekeepers", labelKey: "nav.storekeepers" },
];

function shell(items = DIRECTOR_STOCK) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      <AppShell items={items} userName="Asha Mushi" roleLabel="Director">
        <h1>Page</h1>
      </AppShell>
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  pathname = "/dashboard";
});

describe("the current destination", () => {
  it("is only the most specific match, never two at once", () => {
    pathname = "/inventory/receiving";
    render(shell());

    const nav = screen.getByRole("navigation", { name: /^menu$/i });
    const current = within(nav)
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");

    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAccessibleName(en.nav.receiving);
  });

  it("still covers pages beneath a destination", () => {
    expect(activeHrefFor("/inventory/transfers/new", ["/inventory", "/inventory/receiving"])).toBe(
      "/inventory",
    );
    // A shared prefix that is not a path segment is not a match.
    expect(activeHrefFor("/inventory-old", ["/inventory"])).toBeUndefined();
  });
});

describe("the icon rail", () => {
  it("names every icon-only link by its label", () => {
    render(shell());
    const nav = screen.getByRole("navigation", { name: /^menu$/i });

    for (const item of DIRECTOR_STOCK) {
      const key = item.labelKey.split(".")[1] as keyof typeof en.nav;
      const link = within(nav).getByRole("link", { name: en.nav[key] });
      // The mark is decoration; the name comes from the label alone.
      expect(link.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("gives every destination a mark, including one added later", () => {
    expect(navIconFor("/inventory/receiving")).toBe(PackagePlus);
    // An unmapped child borrows its parent's mark, and an unknown destination gets the fallback.
    expect(navIconFor("/inventory/counts")).toBe(Boxes);
    expect(navIconFor("/till")).toBe(FALLBACK_NAV_ICON);

    render(shell([{ href: "/till", labelKey: "nav.dashboard" }]));
    expect(screen.getByRole("link", { name: en.nav.dashboard }).querySelector("svg")).not.toBeNull();
  });

  describe("while the rail is icon-only", () => {
    const realMatchMedia = window.matchMedia;

    beforeEach(() => {
      // Radix measures the trigger to place the tooltip; jsdom has no ResizeObserver.
      vi.stubGlobal(
        "ResizeObserver",
        class {
          observe() {}
          unobserve() {}
          disconnect() {}
        },
      );
      window.matchMedia = ((query: string) => ({
        ...realMatchMedia(query),
        matches: query.includes("max-width"),
      })) as typeof window.matchMedia;
    });

    afterEach(() => {
      window.matchMedia = realMatchMedia;
      vi.unstubAllGlobals();
    });

    it("shows the label on keyboard focus, not only on hover", async () => {
      render(shell());
      const link = screen.getByRole("link", { name: en.nav.storekeepers });

      act(() => link.focus());

      expect(await screen.findByRole("tooltip")).toHaveTextContent(en.nav.storekeepers);
    });
  });
});

describe("the drawer", () => {
  it("is a named modal dialog that takes focus and gives it back", async () => {
    const user = userEvent.setup();
    render(shell());
    const menu = screen.getByRole("button", { name: /^menu$/i });

    await user.click(menu);

    const drawer = screen.getByRole("dialog", { name: /^menu$/i });
    expect(drawer).toHaveAttribute("aria-modal", "true");
    expect(drawer).toHaveAttribute("id", "fv-drawer");
    expect(drawer).toContainElement(document.activeElement as HTMLElement);
    // It opens on where you are, never on Sign out, which a stray Enter would then press.
    expect(within(drawer).getByRole("link", { current: "page" })).toHaveFocus();
    expect(menu).toHaveAttribute("aria-expanded", "true");

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(menu).toHaveFocus();
  });

  it("closes on arrival at the new page, not on the tap", async () => {
    const user = userEvent.setup();
    const { rerender } = render(shell());

    await user.click(screen.getByRole("button", { name: /^menu$/i }));
    const drawer = screen.getByRole("dialog");
    await user.click(within(drawer).getByRole("link", { name: en.nav.inventory }));

    // The route has not committed yet, so the pending destination stays on screen.
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    pathname = "/inventory";
    rerender(shell());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes when the page you are already on is tapped", async () => {
    const user = userEvent.setup();
    render(shell());

    await user.click(screen.getByRole("button", { name: /^menu$/i }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("link", { name: en.nav.dashboard }),
    );

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says who is signed in", async () => {
    const user = userEvent.setup();
    render(shell());

    await user.click(screen.getByRole("button", { name: /^menu$/i }));
    const drawer = screen.getByRole("dialog");

    expect(within(drawer).getByText(/asha mushi/i)).toBeInTheDocument();
    expect(within(drawer).getByText("Director")).toBeInTheDocument();
  });
});

describe("the skip link", () => {
  it("is the first thing a keyboard reaches, and lands on the page content", async () => {
    const user = userEvent.setup();
    render(shell());

    await user.tab();
    const skip = screen.getByRole("link", { name: en.common.shell.skipToContent });
    expect(skip).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(screen.getByRole("main")).toHaveFocus();
  });
});

describe("the compact language switcher", () => {
  it("shows the code, names the button code-first, and keeps its state", () => {
    render(shell());
    const header = screen.getByRole("banner");

    // Label in name (WCAG 2.5.3): the visible code leads the accessible name.
    const english = within(header).getByRole("button", { name: `EN ${en.common.english}` });
    const swahili = within(header).getByRole("button", { name: `SW ${en.common.swahili}` });

    expect(english).toHaveTextContent("EN");
    expect(swahili).toHaveTextContent("SW");
    expect(english).toHaveAttribute("aria-pressed", "true");
    expect(swahili).toHaveAttribute("aria-pressed", "false");
  });
});
