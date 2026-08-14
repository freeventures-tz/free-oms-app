import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Button } from "@/components/ui/button";

/**
 * The pending half of the interaction feedback contract (design.md §12.7 rules 1 and 4).
 *
 * Each assertion here stands for a separate way the state could be communicated badly: silently,
 * by colour alone, by a control that resizes under a thumb, or by one that can still be pressed.
 */
describe("a button in its pending state", () => {
  it("announces the state rather than only showing it", () => {
    render(
      <Button pending pendingLabel="Working…">
        Reset password
      </Button>,
    );

    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-busy", "true");
    // The word is what a screen reader hears and what survives a stopped animation. A faded
    // surface and a spinning icon say nothing to either (§11.5, §12.7 rule 6).
    expect(screen.getByText("Working…")).toBeInTheDocument();
  });

  it("keeps its label in the layout, so nothing reflows when the state changes", () => {
    const { rerender } = render(<Button pendingLabel="Working…">Reset password</Button>);
    expect(screen.getByText("Reset password")).toBeVisible();

    rerender(
      <Button pending pendingLabel="Working…">
        Reset password
      </Button>,
    );

    // Still present and still occupying its space — hidden, not removed. Removing it is what makes
    // a row of controls jump under the finger that is still on it.
    const label = screen.getByText("Reset password");
    expect(label).toBeInTheDocument();
    expect(label).toHaveClass("invisible");
  });

  it("refuses a second activation", async () => {
    const onClick = vi.fn();
    render(
      <Button pending pendingLabel="Working…" onClick={onClick}>
        Reset password
      </Button>,
    );

    const button = screen.getByRole("button");
    expect(button).toBeDisabled();

    // `.click()` on a disabled button is refused by the browser itself — the one guard that does
    // not depend on any of our own code being right.
    button.click();
    await userEvent.click(button, { pointerEventsCheck: 0 }).catch(() => {});

    expect(onClick).not.toHaveBeenCalled();
  });

  it("is an ordinary button when it is not pending", async () => {
    const onClick = vi.fn();
    render(
      <Button pendingLabel="Working…" onClick={onClick}>
        Reset password
      </Button>,
    );

    const button = screen.getByRole("button");
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-busy");

    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });
});
