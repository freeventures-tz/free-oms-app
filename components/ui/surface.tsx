import * as React from "react";

import { cn } from "@/lib/utils";

/** Cards use a border rather than a shadow at rest; elevation communicates layering only (§9.8). */
export function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("rounded-lg border border-border bg-card p-4 md:p-5 xl:p-6", className)}
      {...props}
    />
  );
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

type ChipTone = "neutral" | "success" | "attention" | "danger";

const CHIP_TONES: Record<ChipTone, string> = {
  neutral: "bg-periwinkle text-foreground",
  success: "bg-success/12 text-success",
  attention: "bg-vanilla text-foreground",
  danger: "bg-danger/10 text-danger",
};

/**
 * Status chips are a fixed shape: pill, 11px caption, icon + label. Colour reinforces meaning but
 * never carries it alone (§10.6, §11.5) — the label is always present.
 */
export function StatusChip({
  tone = "neutral",
  icon,
  children,
}: {
  tone?: ChipTone;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium tracking-[0.02em]",
        CHIP_TONES[tone],
      )}
    >
      {icon}
      {children}
    </span>
  );
}
