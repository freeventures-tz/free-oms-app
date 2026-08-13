import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
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

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
