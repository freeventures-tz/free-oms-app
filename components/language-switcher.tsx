"use client";

import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";

import { setLocale } from "@/app/actions/locale";
import { cn } from "@/lib/utils";

/**
 * Available on the sign-in screen and in the account menu (design.md §8.1). Two languages, so a
 * segmented pair rather than a dropdown: one tap, and both options are always visible.
 *
 * `compact` is for the phone and portrait-tablet top bar, which also holds the menu button and the
 * app name and must fit a 320px screen. The buttons show the two-letter code, keep the full
 * language name as their accessible name, and keep the 44px target (design.md §9.9).
 */
export function LanguageSwitcher({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  const locale = useLocale();
  const t = useTranslations("common");
  const [pending, startTransition] = useTransition();

  const options = [
    { value: "en", code: "EN", label: t("english") },
    { value: "sw", code: "SW", label: t("swahili") },
  ];

  return (
    <div
      role="group"
      aria-label={t("language")}
      className={cn("inline-flex rounded-full border border-border bg-card p-1", className)}
    >
      {options.map((option) => {
        const active = locale === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            aria-label={compact ? option.label : undefined}
            disabled={pending}
            onClick={() => startTransition(() => setLocale(option.value))}
            className={cn(
              "min-h-11 rounded-full px-4 text-[13px] font-medium transition-colors xl:min-h-8",
              compact && "min-w-11 px-2",
              active
                ? "bg-primary text-primary-foreground"
                : "text-foreground hover:bg-[color-mix(in_srgb,var(--fv-periwinkle)_25%,transparent)]",
            )}
          >
            {compact ? option.code : option.label}
          </button>
        );
      })}
    </div>
  );
}
