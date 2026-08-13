"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { LanguageSwitcher } from "@/components/language-switcher";
import { cn } from "@/lib/utils";

export type NavItem = { href: string; labelKey: string };

/**
 * The application shell, deliberately different per device (design.md §3.2–§3.5):
 *
 *   Desktop (`xl`+) — persistent 264px Deep Twilight sidebar, never auto-collapsing.
 *   Tablet (`md`–`lg`) — 72px icon rail, touch-first, labels always visible under the mark.
 *   Mobile (`xs`–`sm`) — hamburger opening a left drawer over a scrim, single column.
 *
 * Destinations are identical across all three: no destination is desktop-only. The list arrives
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

  // ONE nav element per region, restyled by breakpoint rather than duplicated. Two copies of the
  // same destinations in the DOM is how a "hidden" link becomes reachable by accident, and it makes
  // every assertion about navigation ambiguous.
  const nav = (variant: "rail" | "full") => (
    <nav className="flex flex-col gap-1" aria-label={t("common.menu")}>
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setDrawerOpen(false)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-h-11 items-center rounded-full px-4 text-sm font-medium transition-colors",
              variant === "rail" &&
                "justify-center px-2 text-center text-[11px] leading-tight xl:justify-start xl:px-4 xl:text-left xl:text-sm",
              active
                ? "bg-sidebar-primary text-sidebar-primary-foreground"
                : "text-sidebar-foreground hover:bg-sidebar-accent",
            )}
          >
            {t(item.labelKey)}
          </Link>
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
    <div className="flex min-h-full flex-1 flex-col xl:flex-row">
      {/* Mobile: top bar with the hamburger. */}
      <header className="flex items-center justify-between gap-3 bg-sidebar px-4 py-3 md:hidden">
        <button
          type="button"
          aria-expanded={drawerOpen}
          aria-controls="fv-drawer"
          onClick={() => setDrawerOpen(true)}
          className="flex size-11 items-center justify-center rounded-md text-sidebar-foreground"
        >
          <span aria-hidden className="text-xl leading-none">
            ☰
          </span>
          <span className="sr-only">{t("common.menu")}</span>
        </button>
        <span className="text-sm font-semibold text-sidebar-foreground">
          {t("common.appName")}
        </span>
        <LanguageSwitcher />
      </header>

      {/* Mobile drawer over a scrim. */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-foreground/40"
          />
          <div
            id="fv-drawer"
            className="relative flex h-full w-72 max-w-[85%] flex-col gap-6 bg-sidebar p-4"
          >
            <span className="text-base font-semibold text-sidebar-foreground">
              {t("common.appName")}
            </span>
            {nav("full")}
            <div className="mt-auto">{identity}</div>
          </div>
        </div>
      ) : null}

      {/* Tablet: 72px rail. Desktop: 264px persistent sidebar. */}
      <aside className="hidden shrink-0 bg-sidebar md:flex md:w-[72px] md:flex-col md:gap-4 md:p-2 xl:w-[264px] xl:gap-6 xl:p-5">
        <span className="hidden text-base font-semibold text-sidebar-foreground xl:block">
          {t("common.appName")}
        </span>
        {nav("rail")}
        <div className="mt-auto hidden xl:block">{identity}</div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="hidden items-center justify-end gap-3 border-b border-border bg-card px-6 py-3 md:flex">
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
        <main className="flex flex-1 flex-col gap-6 p-4 md:p-6 xl:p-8">{children}</main>
      </div>
    </div>
  );
}
