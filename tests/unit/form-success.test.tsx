import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FormSuccess } from "@/components/ui/field";

/**
 * The success counterpart of `FormError` (design.md §12.7 rule 5).
 *
 * Two things are under test and they pull in opposite directions. The component declares
 * `React.ComponentProps<"p">`, so a caller is entitled to pass any native paragraph prop and expect
 * it to arrive — a declared contract that silently drops what it is given is worse than a narrower
 * one honestly stated. But the accessible semantics are the component's own: a confirmation that a
 * caller could quietly turn into an assertive alert, or into no live region at all, would defeat the
 * reason this primitive exists.
 */
describe("FormSuccess", () => {
  it("announces a confirmation politely, without stealing focus", () => {
    render(<FormSuccess>Counting unit added and selected.</FormSuccess>);

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Counting unit added and selected.");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).not.toHaveAttribute("tabindex");
  });

  it("forwards the native paragraph props it says it accepts", () => {
    render(
      <FormSuccess id="unit-created" data-testid="unit-confirmation" title="Just created">
        Counting unit added and selected.
      </FormSuccess>,
    );

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("id", "unit-created");
    expect(status).toHaveAttribute("data-testid", "unit-confirmation");
    expect(status).toHaveAttribute("title", "Just created");
  });

  it("keeps its own class alongside one the caller adds", () => {
    render(<FormSuccess className="text-xs">Saved.</FormSuccess>);

    const status = screen.getByRole("status");
    expect(status.className).toContain("text-xs");
    expect(status.className).toContain("text-success");
  });

  it("refuses to have its accessible semantics overridden by a caller", () => {
    render(
      // A caller reaching for `role="alert"` here would interrupt a screen-reader user to tell them
      // something went right. The component owns this, deliberately.
      <FormSuccess role="alert" aria-live="assertive">
        Saved.
      </FormSuccess>,
    );

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders nothing at all when there is nothing to confirm", () => {
    const { container } = render(<FormSuccess>{null}</FormSuccess>);

    // Not an empty live region: an announced blank is a announcement of nothing.
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
