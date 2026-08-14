"use client";

import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";

import { setLocale } from "@/app/actions/locale";
import { cn } from "@/lib/utils";

/**
 * Available on the sign-in screen and in the account menu (design.md §8.1). Two languages, so a
 * segmented pair rather than a dropdown: one tap, and both options are always visible.
 */
export function LanguageSwitcher({ className }: { className?: string }) {
  const locale = useLocale();
  const t = useTranslations("common");
  const [pending, startTransition] = useTransition();

  const options = [
    { value: "en", label: t("english") },
    { value: "sw", label: t("swahili") },
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
            disabled={pending}
            onClick={() => startTransition(() => setLocale(option.value))}
            className={cn(
              "min-h-11 rounded-full px-4 text-[13px] font-medium transition-colors xl:min-h-8",
              active
                ? "bg-primary text-primary-foreground"
                : "text-foreground hover:bg-[color-mix(in_srgb,var(--fv-periwinkle)_25%,transparent)]",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
