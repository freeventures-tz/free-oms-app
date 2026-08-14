import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * Heights are mobile-first and step DOWN with viewport, because the touch target is the binding
 * constraint: 48px mobile · 44px tablet · 40px desktop (design.md §9.9). 44×44 is a floor on touch
 * devices, icon-only buttons included.
 *
 * Text on Golden Bronze is always Deep Twilight. White on bronze measures 2.8:1 and is never used.
 */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-colors select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground hover:bg-[color-mix(in_srgb,var(--fv-bronze)_92%,black)]",
        secondary:
          "border border-input bg-card text-foreground hover:bg-[color-mix(in_srgb,var(--fv-periwinkle)_20%,transparent)]",
        ghost:
          "text-bronze-text hover:bg-[color-mix(in_srgb,var(--fv-vanilla)_35%,transparent)]",
        danger: "border border-danger/40 bg-card text-danger hover:bg-danger/10",
      },
      size: {
        default: "h-12 px-5 md:h-11 xl:h-10",
        small: "h-11 px-4 text-[0.8rem] md:h-10 xl:h-8",
        icon: "size-11 md:size-11 xl:size-8",
        block: "h-12 w-full px-5 md:h-11 xl:h-10",
      },
    },
    defaultVariants: { variant: "primary", size: "default" },
  },
);

/**
 * `pending` is the interaction feedback contract in one prop (design.md §12.7 rules 1, 4).
 *
 * Three things have to be true at once, and each of them is a separate failure if it is missing:
 *
 *   the button must not change size — the label stays in the layout and is hidden with
 *   `invisible`, and the indicator is laid over it, so a row of controls cannot reflow under
 *   someone's thumb mid-tap;
 *
 *   the state must not be carried by colour — `aria-busy`, a spinner, and a word are all present,
 *   because a faded surface says nothing to a screen reader and nothing under stopped animation
 *   (§11.5, §12.7 rule 6);
 *
 *   a second activation must not reach the handler — `disabled` refuses it at the browser, which
 *   is the guard that does not depend on any of our own code being correct. It is the first of the
 *   layers that stopped one double-click issuing two credentials (memory.md §6).
 *
 * `pendingLabel` is required whenever `pending` can be true, because "Working…" has to exist in
 * both languages rather than be improvised at the call site.
 */
function Button({
  className,
  variant,
  size,
  asChild = false,
  pending = false,
  pendingLabel,
  disabled,
  children,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    pending?: boolean;
    pendingLabel?: string;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  // `asChild` hands rendering to someone else's element, so there is nothing here to overlay.
  if (asChild) {
    return (
      <Comp
        data-slot="button"
        className={cn(buttonVariants({ variant, size, className }))}
        {...props}
      >
        {children}
      </Comp>
    );
  }

  return (
    <button
      data-slot="button"
      data-pending={pending || undefined}
      aria-busy={pending || undefined}
      disabled={disabled || pending}
      className={cn("relative", buttonVariants({ variant, size, className }))}
      {...props}
    >
      <span className={cn("inline-flex items-center gap-2", pending && "invisible")}>
        {children}
      </span>
      {pending ? (
        <span className="absolute inset-0 inline-flex items-center justify-center gap-2">
          <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
          <span className="sr-only">{pendingLabel}</span>
        </span>
      ) : null}
    </button>
  );
}

export { Button, buttonVariants };
