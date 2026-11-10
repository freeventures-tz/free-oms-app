import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import { Reveal, REVEAL_STEP } from "@/components/ui/reveal";
import en from "@/messages/en.json";

function board(total: number) {
  const rows = Array.from({ length: total }, (_, index) => `row ${index + 1}`);
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <Reveal rows={rows} label="Waiting" name="pending">
        {(row) => <p key={row}>{row}</p>}
      </Reveal>
    </NextIntlClientProvider>,
  );
}

describe("a board that draws its newest rows first", () => {
  // A short list is the whole list, so it carries no count and no control to explain.
  it("draws every row of a short list and adds nothing", () => {
    board(REVEAL_STEP);
    expect(screen.getAllByText(/^row \d+$/)).toHaveLength(REVEAL_STEP);
    expect(screen.queryByTestId("reveal-count-pending")).toBeNull();
    expect(screen.queryByTestId("reveal-more-pending")).toBeNull();
  });

  // The cost of the board must not grow with what the business has recorded, and a cut list must
  // never read as the whole one.
  it("draws one step of a long list and says how many there are", () => {
    board(85);
    expect(screen.getAllByText(/^row \d+$/)).toHaveLength(REVEAL_STEP);
    expect(screen.getByText("row 1")).toBeInTheDocument();
    expect(screen.getByTestId("reveal-count-pending")).toHaveTextContent(`Showing 1–${REVEAL_STEP} of 85`);
  });

  it("adds a step for each press, and drops the control once everything is drawn", async () => {
    const user = userEvent.setup();
    board(REVEAL_STEP * 2 + 5);
    await user.click(screen.getByTestId("reveal-more-pending"));
    expect(screen.getAllByText(/^row \d+$/)).toHaveLength(REVEAL_STEP * 2);
    await user.click(screen.getByTestId("reveal-more-pending"));
    expect(screen.getAllByText(/^row \d+$/)).toHaveLength(REVEAL_STEP * 2 + 5);
    expect(screen.getByTestId("reveal-count-pending")).toHaveTextContent(`Showing 1–${REVEAL_STEP * 2 + 5} of ${REVEAL_STEP * 2 + 5}`);
    expect(screen.queryByTestId("reveal-more-pending")).toBeNull();
  });
});
