"use client";

import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The single action on an entry screen (design.md §7.1: the button is the last thing in the
 * hierarchy, and above the fold on a phone).
 *
 * Three states are distinguishable without reading: not ready — a faded bronze surface; ready — the
 * full Golden Bronze fill of the mockups; working — a spinner beside a label that says so, because
 * a spinner alone tells a screen reader nothing and tells a stopped animation nothing either.
 *
 * Text on Golden Bronze is Deep Twilight in every one of those states. White on bronze is 2.8:1 and
 * is never used (design.md §9.3).
 */
export function AuthSubmit({
  children,
  ready,
  pending = false,
  type = "submit",
  onClick,
}: {
  children: ReactNode;
  ready: boolean;
  pending?: boolean;
  type?: "submit" | "button";
  onClick?: () => void;
}) {
  const t = useTranslations("common");
  const disabled = pending || !ready;

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-busy={pending || undefined}
      className={cn(
        "fv-entry-action inline-flex h-14 w-full items-center justify-center gap-2 rounded-lg",
        "text-base font-semibold transition-colors md:h-13 xl:h-12",
        ready && !pending
          ? "bg-primary text-primary-foreground hover:bg-[color-mix(in_srgb,var(--fv-bronze)_92%,black)]"
          : "bg-[color-mix(in_srgb,var(--fv-bronze)_38%,white)] text-[color-mix(in_srgb,var(--fv-twilight)_45%,transparent)]",
      )}
    >
      {pending ? (
        <>
          <Loader2 aria-hidden className="size-5 animate-spin motion-reduce:animate-none" />
          {t("loading")}
        </>
      ) : (
        children
      )}
    </button>
  );
}
