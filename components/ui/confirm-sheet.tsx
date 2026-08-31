"use client";

import { AlertDialog } from "radix-ui";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The confirmation for an action that cannot be undone (design.md §10.8, §11.8, §7A.2).
 *
 * ONE SHAPE, TWO PRESENTATIONS. §10.8: "Desktop uses centred modals; mobile uses bottom sheets."
 * That is a CSS difference over the same markup rather than two components, so the consequence text
 * and the choice cannot drift apart between tiers.
 *
 * TWO STEPS, NEVER ONE. §7A.2 requires the mobile confirmation to be "a two-step sheet, never a
 * swipe": activating the control opens this, and the action itself is a second, separate press on a
 * button that names what will happen. Recording a customer's confirmation creates a financial
 * record and reserves stock, and a single tap is not enough distance from that.
 *
 * IT DOES NOT DISMISS ITSELF. §10.8 exempts irreversible confirmations from closing on `Esc` or a
 * scrim tap: they "require an explicit choice". `AlertDialog` already ignores the scrim, and the
 * escape handler below is prevented for the same reason. Nothing is trapped — the cancel button is
 * a real, focusable, keyboard-reachable choice, and Radix returns focus to the trigger either way
 * (§11.1).
 */
export function ConfirmSheet({
  open,
  onOpenChange,
  title,
  consequence,
  confirmLabel,
  confirmId,
  cancelLabel,
  pending,
  pendingLabel,
  variant = "primary",
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** What will happen, named before it happens (§10.8). Never a generic "Are you sure?". */
  consequence: React.ReactNode;
  confirmLabel: string;
  confirmId: string;
  cancelLabel: string;
  pending?: boolean;
  pendingLabel: string;
  variant?: "primary" | "danger";
  onConfirm: () => void;
  /** Anything the decision needs in front of the person — the figures, a required reason. */
  children?: React.ReactNode;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-foreground/40" />
        <AlertDialog.Content
          onEscapeKeyDown={(event) => event.preventDefault()}
          className={cn(
            "fixed z-50 flex flex-col gap-4 border border-border bg-card p-5 shadow-lg",
            // Phone: a bottom sheet, within thumb reach (§3.5, §11.3).
            "inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-lg",
            // Tablet and desktop: a centred modal.
            "md:inset-x-auto md:bottom-auto md:top-1/2 md:left-1/2 md:w-[min(32rem,calc(100vw-2rem))]",
            "md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-lg",
          )}
        >
          <AlertDialog.Title className="text-base font-semibold">{title}</AlertDialog.Title>
          <AlertDialog.Description className="text-sm text-muted-foreground">
            {consequence}
          </AlertDialog.Description>

          {children}

          {/* The destructive choice is never the visual default and never sits adjacent to the way
              out (§10.3): the cancel comes first in the source order on a phone, where the thumb
              lands lowest. */}
          <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
            <AlertDialog.Cancel asChild>
              <Button type="button" variant="secondary" disabled={pending}>
                {cancelLabel}
              </Button>
            </AlertDialog.Cancel>
            <Button
              type="button"
              id={confirmId}
              variant={variant}
              pending={pending}
              pendingLabel={pendingLabel}
              onClick={onConfirm}
            >
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
