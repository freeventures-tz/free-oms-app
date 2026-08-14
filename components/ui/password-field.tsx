"use client";

import { Check, Eye, EyeOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { cn } from "@/lib/utils";

/**
 * The password field for every entry screen.
 *
 * A MASKED field with a reveal control — never fixed-length boxes, and no progress meter. Boxes
 * would publish how long the password is to anyone who loads the page; a meter counting a person's
 * keystrokes back at them is noise on a screen they use every morning. Someone typing a password
 * already knows how far through it they are.
 *
 * `satisfied` is the ONLY thing that turns this field green, and it is left undefined wherever
 * there is nothing to satisfy — sign-in cannot know whether a password is right until the server
 * answers, so it stays in the brand colour and says nothing it does not know. Where conditions do
 * exist, meeting them shows a tick and nothing else.
 */
export function PasswordField({
  id,
  name,
  label,
  value,
  onChange,
  satisfied,
  autoComplete,
  autoFocus,
  disabled,
  invalid,
  shake = 0,
  describedBy,
}: {
  id: string;
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Undefined where the screen has no condition to test. True turns the field green. */
  satisfied?: boolean;
  autoComplete: string;
  autoFocus?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  /** Increment to replay the failure shake; the two animation names alternate so it restarts. */
  shake?: number;
  describedBy?: string;
}) {
  const t = useTranslations("auth.password");
  const [revealed, setRevealed] = useState(false);

  const met = satisfied === true && !invalid;

  return (
    <div className="flex flex-col gap-3">
      <label
        htmlFor={id}
        className="text-center text-[15px] font-medium text-foreground"
      >
        {label}
      </label>

      <div
        className="relative"
        data-fv-shake={shake === 0 ? undefined : shake % 2 === 1 ? "a" : "b"}
      >
        <input
          id={id}
          name={name}
          type={revealed ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          required
          disabled={disabled}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            "fv-entry-input h-14 w-full rounded-lg border-2 bg-card pl-4 text-base text-foreground md:h-13 xl:h-12",
            "tracking-[0.08em]",
            met ? "pr-22" : "pr-14",
            invalid ? "border-danger" : met ? "border-success" : "fv-entry-border",
            disabled && "opacity-60",
          )}
        />

        {met ? (
          <Check
            aria-hidden
            className="fv-tick absolute top-1/2 right-14 size-5 -translate-y-1/2 text-success"
          />
        ) : null}

        <button
          type="button"
          onClick={() => setRevealed((previous) => !previous)}
          aria-pressed={revealed}
          aria-controls={id}
          disabled={disabled}
          // 44px floor on touch (design.md §11.3); it may shrink only on the desktop tier.
          className="absolute top-1/2 right-1.5 grid size-11 -translate-y-1/2 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground xl:size-10"
        >
          {revealed ? <EyeOff aria-hidden className="size-5" /> : <Eye aria-hidden className="size-5" />}
          <span className="sr-only">{revealed ? t("hide") : t("show")}</span>
        </button>
      </div>
    </div>
  );
}
