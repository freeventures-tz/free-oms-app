import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Loading placeholders (design.md §12.4, §12.7 rule 3).
 *
 * A skeleton exists to hold the SHAPE of the content it is standing in for. One of the wrong shape
 * is worse than none at all: the content arrives, the layout jumps, and the reader loses their
 * place — a second layout shift bought with the first one.
 *
 * Every block is `aria-hidden`; a screen reader is told what is happening once, by the surrounding
 * `LoadingRegion`, rather than hearing a description of a grey rectangle.
 */
export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div aria-hidden data-slot="skeleton" className={cn("fv-skeleton", className)} {...props} />
  );
}

/**
 * Wraps a skeleton so the wait is announced rather than merely drawn.
 *
 * `role="status"` with a polite live region is the accessible half of the same acknowledgement the
 * skeleton makes visually — §12.7 rule 6: feedback that survives a stopped animation and a reader
 * who cannot see the screen.
 */
export function LoadingRegion({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div role="status" aria-live="polite" aria-busy className={cn("flex flex-col gap-6", className)}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/** The header every page in the shell opens with, so the title area never jumps (§7 screens). */
export function PageHeaderSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-8 w-[220px] rounded-md" />
      <Skeleton className="h-4 w-[min(320px,80%)] rounded-sm" />
    </div>
  );
}

/** A card body of `lines` text rows, matching `Card`'s padding and radius. */
export function CardSkeleton({ lines = 2 }: { lines?: number }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 md:p-5 xl:p-6">
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          className={cn("h-4 rounded-sm", index === 0 ? "w-[60%]" : "w-[40%]")}
        />
      ))}
    </div>
  );
}
