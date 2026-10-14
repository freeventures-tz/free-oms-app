"use client";

import { Menu } from "lucide-react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Dialog, Tooltip } from "radix-ui";
import { useEffect, useRef, useState } from "react";

import { LanguageSwitcher } from "@/components/language-switcher";
import { NavLink, type NavLinkVariant } from "@/components/nav-link";
import { activeHrefFor } from "@/components/nav-icons";

export type NavItem = { href: string; labelKey: string };

/** Tailwind's `lg`: from here up the persistent aside replaces the drawer. */
const ASIDE_QUERY = "(min-width: 64rem)";

/**
 * The application shell, deliberately different per device (design.md §3.2–§3.5):
 *
 *   Desktop (`xl`+) — persistent 264px Deep Twilight sidebar, icon and label, never auto-collapsing.
 *   Tablet landscape / small laptop (`lg`) — 72px icon rail. Each icon's label is its accessible
 *     name and shows as a tooltip on hover and on keyboard focus (§3.4).
 *   Tablet portrait (`md`) and mobile (`xs`–`sm`) — hamburger opening a left drawer over a scrim.
 *     A 72px rail at `md` could not hold the labels ("Storekeepers" alone needs 69px of the ~26px
 *     the rail had left), and §3.4 gives portrait the drawer anyway.
 *
 * Destinations are identical across all tiers: no destination is desktop-only. The list arrives
 * already filtered by role from the server, so nothing a user cannot use is ever rendered.
 */
export function AppShell({
  items,
  userName,
  roleLabel,
  children,
}: {
  items: NavItem[];
  userName: string;
  roleLabel: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const t = useTranslations();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);

  /**
   * The drawer closes on ARRIVAL, not on tap (design.md §12.7 rules 1–2).
   *
   * Closing it in the click handler took the acknowledgement away at the exact moment it was owed:
   * on a phone the menu vanished, the previous page stayed, and nothing anywhere said a tap had
   * registered until the new page arrived. That is the two seconds of silence Part A exists to
   * remove, and it was worst on the tier most of the staff actually use.
   *
   * Keeping it open costs nothing when the route commits at once — the pathname changes in the same
   * frame and this closes it — and on a slow connection it is the only place the pending
   * destination is visible.
   */
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // A tablet rotated to landscape with the drawer open would otherwise keep a modal that CSS has
  // hidden: the page inert, scrolling locked, and nothing on screen to close it with.
  useEffect(() => {
    const query = window.matchMedia(ASIDE_QUERY);
    const close = () => {
      if (query.matches) setDrawerOpen(false);
    };
    query.addEventListener("change", close);
    return () => query.removeEventListener("change", close);
  }, []);

  // Several destinations can contain the current path (`/inventory` and `/inventory/receiving`);
  // only the most specific one is current.
  const activeHref = activeHrefFor(
    pathname,
    items.map((item) => item.href),
  );

  // ONE nav element per region, restyled by breakpoint rather than duplicated. Two copies of the
  // same destinations in the DOM is how a "hidden" link becomes reachable by accident, and it makes
  // every assertion about navigation ambiguous.
  const nav = (variant: NavLinkVariant) => (
    <nav className="flex flex-col gap-1" aria-label={t("common.menu")}>
      {items.map((item) => {
        const active = item.href === activeHref;
        return (
          <NavLink
            key={item.href}
            href={item.href}
            label={t(item.labelKey)}
            active={active}
            variant={variant}
            // Tapping where you already are produces no pathname change, so nothing would close
            // the drawer. That one case still closes on tap.
            onNavigate={active ? () => setDrawerOpen(false) : undefined}
          />
        );
      })}
    </nav>
  );

  const identity = (
    <div className="flex flex-col gap-3 border-t border-sidebar-border pt-4">
      <p className="text-xs text-sidebar-foreground/70">
        {t("common.signedInAs", { name: userName })}
      </p>
      <p className="text-xs font-medium text-sidebar-foreground">{roleLabel}</p>
      <form action="/auth/sign-out" method="post">
        <button
          type="submit"
          className="min-h-11 w-full rounded-md border border-sidebar-border px-4 text-sm font-medium text-sidebar-foreground hover:bg-sidebar-accent xl:min-h-10"
        >
          {t("common.signOut")}
        </button>
      </form>
    </div>
  );

  return (
    // A row from `lg` up, where the aside appears; below it the top bar stacks over the page.
    <div className="flex min-h-full flex-1 flex-col lg:flex-row">
      {/* The first thing a keyboard reaches on every page (design.md §11.1). Hidden until focused,
          then shown over whatever is at the top-left, so it never costs layout space. */}
      <a
        href="#main"
        onClick={(event) => {
          // Focus moves without writing `#main` into the address bar, where it would follow the
          // person into a shared link.
          event.preventDefault();
          document.getElementById("main")?.focus();
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:flex focus:min-h-11 focus:items-center focus:rounded-md focus:bg-primary focus:px-4 focus:text-sm focus:font-medium focus:text-primary-foreground focus:shadow-md"
      >
        {t("common.shell.skipToContent")}
      </a>

      {/* Phone and portrait tablet: top bar with the hamburger. */}
      <header className="flex items-center justify-between gap-3 bg-sidebar px-4 py-3 lg:hidden">
        <button
          ref={menuButton}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={drawerOpen}
          aria-controls="fv-drawer"
          onClick={() => setDrawerOpen(true)}
          className="flex size-11 shrink-0 items-center justify-center rounded-md text-sidebar-foreground hover:bg-sidebar-accent"
        >
          <Menu aria-hidden className="size-6" />
          <span className="sr-only">{t("common.menu")}</span>
        </button>
        <span className="min-w-0 truncate text-sm font-semibold text-sidebar-foreground">
          {t("common.appName")}
        </span>
        <LanguageSwitcher compact className="shrink-0" />
      </header>

      {/* Phone and portrait tablet: the drawer, a real modal (design.md §3.5, §10.8). Radix gives it
          the dialog role, a name, focus moved in and held there, `Esc` and the scrim to close it,
          scrolling locked underneath, and focus handed back to the menu button afterwards. */}
      <Dialog.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-foreground/40 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 motion-reduce:animate-none lg:hidden" />
          {/* The panel FADES in where it sits rather than sliding in from off screen. Its links prefetch
              their page's loading skeleton once they are in view; a panel that starts outside the
              viewport puts them in view only when the slide ends, so a quick tap got the generic
              skeleton instead of the page-shaped one (design.md §12.7 rule 3). */}
          <Dialog.Content
            id="fv-drawer"
            // Radix makes everything outside inert by hiding it; this says the same thing to the
            // assistive technology that reads the dialog itself rather than its surroundings.
            aria-modal="true"
            // The title names the dialog; there is no separate description to point at.
            aria-describedby={undefined}
            // Radix hands focus back to its own `Dialog.Trigger`. The menu button is not one, because
            // a trigger's `aria-controls` would point at Radix's generated id instead of `fv-drawer`,
            // so the hand-back is done here (design.md §11.1).
            // Radix would focus the first tabbable control, which measured as Sign out: one stray Enter
            // from leaving. Focus starts on where you are instead, so the drawer opens on the answer
            // to "which page is this?" and the arrow-free Tab order runs down from there.
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              const drawer = event.currentTarget as HTMLElement;
              const here =
                drawer.querySelector<HTMLElement>('a[aria-current="page"]') ??
                drawer.querySelector<HTMLElement>("nav a");
              here?.focus();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              menuButton.current?.focus();
            }}
            className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85%] flex-col gap-6 overflow-y-auto bg-sidebar p-4 duration-200 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 motion-reduce:animate-none lg:hidden"
          >
            <Dialog.Title className="sr-only">{t("common.menu")}</Dialog.Title>
            <span className="text-base font-semibold text-sidebar-foreground">
              {t("common.appName")}
            </span>
            {nav("full")}
            <div className="mt-auto">{identity}</div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* `lg`: 72px icon rail. `xl`: 264px persistent sidebar. Sticky and scrolling on its own, so the
          destinations and the identity stay in reach on a long page or a short laptop screen. */}
      <aside className="hidden shrink-0 bg-sidebar lg:sticky lg:top-0 lg:flex lg:h-dvh lg:w-[72px] lg:flex-col lg:gap-4 lg:self-start lg:overflow-y-auto lg:p-2 lg:py-4 xl:w-[264px] xl:gap-6 xl:p-5">
        <span className="hidden text-base font-semibold text-sidebar-foreground xl:block">
          {t("common.appName")}
        </span>
        <Tooltip.Provider delayDuration={300}>{nav("rail")}</Tooltip.Provider>
        <div className="mt-auto hidden xl:block">{identity}</div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="hidden items-center justify-end gap-3 border-b border-border bg-card px-6 py-3 lg:flex">
          {/* The rail has no room for who is signed in, so at `lg` it is said here instead. */}
          <p className="mr-auto min-w-0 truncate text-sm xl:hidden">
            {t("common.signedInAs", { name: userName })}
            <span className="text-muted-foreground"> · {roleLabel}</span>
          </p>
          <LanguageSwitcher />
          <form action="/auth/sign-out" method="post" className="xl:hidden">
            <button
              type="submit"
              className="min-h-11 rounded-md border border-border px-4 text-sm font-medium"
            >
              {t("common.signOut")}
            </button>
          </form>
        </div>
        {/* The skip link's target. Focusable by script only, and without a ring: it is a landing
            point, not a control. */}
        <main
          id="main"
          tabIndex={-1}
          className="flex flex-1 flex-col gap-6 p-4 outline-none md:p-6 xl:p-8"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
