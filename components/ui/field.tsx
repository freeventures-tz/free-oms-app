import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Form primitives following design.md §10.4: labels sit ABOVE fields and are never replaced by a
 * placeholder; helper text is persistent, not hover-only; errors sit next to their field.
 */

export function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      className={cn("text-[13px] leading-tight font-medium text-foreground", className)}
      {...props}
    />
  );
}

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "h-12 w-full rounded-sm border border-input bg-card px-3 text-sm text-foreground",
        "placeholder:text-muted-foreground md:h-11 xl:h-10",
        "aria-[invalid=true]:border-danger",
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "h-12 w-full rounded-sm border border-input bg-card px-3 text-sm text-foreground md:h-11 xl:h-10",
        className,
      )}
      {...props}
    />
  );
}

export function Help({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("text-xs text-muted-foreground", className)} {...props} />;
}

export function FieldError({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="text-xs font-medium text-danger">
      {children}
    </p>
  );
}

export function Field({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-2", className)} {...props} />;
}

/** A whole-form failure, shown above the fields — never revealing which detail was wrong. */
export function FormError({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <div
      role="alert"
      className="rounded-sm border border-danger/40 bg-danger/5 px-4 py-3 text-sm text-danger"
    >
      {children}
    </div>
  );
}
