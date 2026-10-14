import {
  ArrowLeftRight,
  Boxes,
  Building2,
  ChartColumn,
  ClipboardList,
  Compass,
  Factory,
  HandCoins,
  LayoutDashboard,
  type LucideIcon,
  Package,
  PackagePlus,
  SlidersHorizontal,
  Truck,
  UserCog,
  UsersRound,
  Wallet,
} from "lucide-react";

/**
 * The mark for each destination, keyed by where it goes rather than by its label key.
 *
 * The navigation list itself (`lib/nav.ts`) knows nothing about icons: it is the role contract, and
 * an icon is a presentation of it. Keying by href keeps the two from drifting — a renamed label
 * keeps its icon, and a destination added to the list without an entry here still renders.
 */
const ICON_BY_HREF: Record<string, LucideIcon> = {
  "/dashboard": LayoutDashboard,
  "/orders": ClipboardList,
  "/payments": Wallet,
  "/dispatch": Truck,
  "/inventory": Boxes,
  "/inventory/receiving": PackagePlus,
  "/inventory/transfers": ArrowLeftRight,
  "/inventory/adjustments": SlidersHorizontal,
  "/production": Factory,
  "/imprest": HandCoins,
  "/settings/products": Package,
  "/settings/suppliers": Building2,
  "/settings/storekeepers": UserCog,
  "/reports": ChartColumn,
  "/admin/accounts": UsersRound,
};

/** What a destination with no entry above shows: a mark that says "a place", never a blank. */
export const FALLBACK_NAV_ICON: LucideIcon = Compass;

/** True when `pathname` is `href` itself or a page beneath it. */
export function matchesHref(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The icon for a destination: its own, else the nearest ancestor's (a future `/inventory/counts`
 * borrows Stock's), else the fallback. Longest prefix wins, the same rule as the current page.
 */
export function navIconFor(href: string): LucideIcon {
  let best: string | undefined;
  for (const candidate of Object.keys(ICON_BY_HREF)) {
    if (matchesHref(href, candidate) && (!best || candidate.length > best.length)) {
      best = candidate;
    }
  }
  return best ? ICON_BY_HREF[best] : FALLBACK_NAV_ICON;
}

/**
 * The ONE destination that is current for `pathname`, or none.
 *
 * Several items can contain the path: on `/inventory/receiving`, both Stock (`/inventory`) and
 * Supplier receiving match by prefix. Only the most specific is where you are, so only it carries
 * `aria-current` — two current pages is a contradiction a screen reader reads out loud.
 */
export function activeHrefFor(pathname: string, hrefs: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const href of hrefs) {
    if (matchesHref(pathname, href) && (!best || href.length > best.length)) best = href;
  }
  return best;
}
