import * as React from "react";

import { Logo } from "@/components/brand/logo";
import { LanguageSwitcher } from "@/components/language-switcher";
import { cn } from "@/lib/utils";

/**
 * The frame every entry screen shares: sign-in, the forced password change, and the no-access
 * states (design.md §7.1, §7C.1, §7C.4).
 *
 * Deep Twilight canvas, the language switcher floating above, and one White card carrying the
 * lockup. The mockups in `ui-mockups/auth/` give the card the SAME treatment on a phone as on a
 * desktop, which supersedes the earlier "full-screen white on mobile" note: on a bright yard screen
 * the dark surround is what makes the card findable, and it costs nothing in height.
 *
 * Hierarchy is fixed by §7.1: logo → language → prompt → field → action.
 */
export function AuthShell({
  children,
  wide = false,
}: {
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-[var(--fv-twilight)]">
      <div
        className={cn(
          "mx-auto flex w-full flex-1 flex-col items-center justify-center gap-4 px-5 py-8",
          wide ? "max-w-[520px]" : "max-w-[460px]",
        )}
      >
        {/* Above the card, as drawn: the choice of language precedes the choice to sign in. */}
        <LanguageSwitcher />

        <div className="fv-auth-card w-full rounded-xl bg-card px-6 py-8 md:px-8 md:py-10">
          <div className="flex justify-center">
            <Logo />
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

/** The card's title and the one-line prompt beneath it, both centred as in the mockups. */
export function AuthHeading({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mt-8 flex flex-col items-center gap-4 text-center">
      <h1 className="text-2xl font-semibold">{title}</h1>
      {children}
    </div>
  );
}
