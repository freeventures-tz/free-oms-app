"use client";

import Link, { useLinkStatus } from "next/link";
import { useTranslations } from "next-intl";
import { Tooltip } from "radix-ui";
import { createElement, useState } from "react";

import { navIconFor } from "@/components/nav-icons";
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
 *
 * Two variants, one per region (design.md §3.3–§3.5):
 *
 *   `rail` — the persistent aside. At `lg` it is a 72px icon rail: the label is visually hidden but
 *            stays the link's accessible name, and a tooltip shows it on hover AND keyboard focus.
 *            At `xl` the same element becomes the 264px sidebar row, icon and label side by side.
 *   `full` — the drawer on phones and portrait tablets: icon and label, always.
 */
export type NavLinkVariant = "rail" | "full";

/**
 * The window in which the rail is icon-only. Matches Tailwind's `lg` (64rem) up to, not including,
 * `xl` (80rem). Outside it the label is on screen, and a tooltip repeating it would be noise.
 */
const ICON_ONLY_QUERY = "(min-width: 64rem) and (max-width: 79.999rem)";

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
  const link = (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn("rounded-full", variant === "rail" && "max-xl:mx-auto")}
    >
      <NavSurface href={href} label={label} active={active} variant={variant} />
    </Link>
  );

  return variant === "rail" ? <RailTooltip label={label}>{link}</RailTooltip> : link;
}

/**
 * The rail's label, shown beside an icon-only item. Radix supplies what a hand-rolled one would get
 * wrong: it opens on keyboard focus as well as hover, closes on `Esc`, stays open while the pointer
 * crosses onto it, and is portalled, so the rail's own scroll container cannot clip it.
 *
 * It only ever opens while the rail is icon-only. The `matchMedia` check is read at the moment of
 * opening rather than subscribed to, because that is the only moment the answer matters.
 */
function RailTooltip({ label, children }: { label: string; children: React.ReactElement }) {
  const [open, setOpen] = useState(false);

  return (
    <Tooltip.Root
      open={open}
      onOpenChange={(next) => setOpen(next && window.matchMedia(ICON_ONLY_QUERY).matches)}
    >
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="right"
          sideOffset={8}
          className={cn(
            "z-50 rounded-md bg-sidebar px-3 py-1.5 text-sm font-medium text-sidebar-foreground shadow-md",
            // Opacity only, within the 200ms budget, and nothing at all under reduced motion
            // (design.md §11.9). The label is there either way.
            "animate-in fade-in-0 duration-150 motion-reduce:animate-none",
          )}
        >
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
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
        "relative flex min-h-11 items-center gap-3 rounded-full px-4 text-sm font-medium transition-colors",
        // Icon-only below `xl`: a 44px circle, centred in the rail (design.md §9.9).
        variant === "rail" && "max-xl:size-11 max-xl:justify-center max-xl:px-0",
        selected
          ? "bg-sidebar-primary text-sidebar-primary-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-accent",
      )}
    >
      {/* Looked up by href rather than declared, so it is created as an element, not written as a
          component tag. Decorative either way: the label is what names the link. */}
      {createElement(navIconFor(href), { "aria-hidden": true, className: "size-5 shrink-0" })}
      <span className={cn("min-w-0", variant === "rail" && "max-xl:sr-only")}>{label}</span>
      {/* Always rendered at a fixed size and revealed by visibility, so nothing reflows when a
          navigation starts — the layout is identical in both states. On the icon-only rail it sits
          in the corner of the circle instead of beside a label, so it takes no width from the
          icon. */}
      <span
        aria-hidden
        data-pending={pending || undefined}
        className={cn("fv-nav-hint", variant === "rail" && "max-xl:absolute max-xl:top-1 max-xl:right-1")}
      />
      {pending ? <span className="sr-only">{t("loading")}</span> : null}
    </span>
  );
}
