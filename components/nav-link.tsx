"use client";

import Link, { useLinkStatus } from "next/link";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

/**
 * A navigation destination that confirms the DESTINATION, not the arrival (design.md §12.7 rule 2).
 *
 * The moment an item is tapped it takes the selected treatment, while the route is still pending.
 * Two seconds of a sidebar that looks exactly as it did before the tap is what makes a person on a
 * slow connection tap again, and in this system a second tap is not free.
 *
 * `useLinkStatus` has to be read from INSIDE the `Link`, so the link itself is a bare wrapper and
 * every visual belongs to the surface underneath it. That also keeps the pending styling out of
 * reach of `:has()` support, which is not something to bet an acknowledgement on.
 *
 * When the destination's `loading` boundary has already been prefetched the route commits
 * immediately and `pending` is never true — the item simply becomes the current page at once, which
 * is the same promise kept by a faster means.
 */
export type NavLinkVariant = "rail" | "full";

export function NavLink({
  href,
  label,
  active,
  variant,
  onNavigate,
}: {
  href: string;
  label: string;
  active: boolean;
  variant: NavLinkVariant;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className="rounded-full"
    >
      <NavSurface href={href} label={label} active={active} variant={variant} />
    </Link>
  );
}

function NavSurface({
  href,
  label,
  active,
  variant,
}: {
  href: string;
  label: string;
  active: boolean;
  variant: NavLinkVariant;
}) {
  const { pending } = useLinkStatus();
  const t = useTranslations("common");

  // Selected because you are here, or selected because you asked to go here. They read the same on
  // purpose: the tap is answered before the server is.
  const selected = active || pending;

  return (
    <span
      data-pending-nav={pending ? href : undefined}
      className={cn(
        "flex min-h-11 items-center gap-2 rounded-full px-4 text-sm font-medium transition-colors",
        variant === "rail" &&
          "justify-center px-2 text-center text-[11px] leading-tight xl:justify-start xl:px-4 xl:text-left xl:text-sm",
        selected
          ? "bg-sidebar-primary text-sidebar-primary-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-accent",
      )}
    >
      {label}
      {/* Always rendered at a fixed size and revealed by visibility, so nothing reflows when a
          navigation starts — the layout is identical in both states. */}
      <span aria-hidden data-pending={pending || undefined} className="fv-nav-hint" />
      {pending ? <span className="sr-only">{t("loading")}</span> : null}
    </span>
  );
}
