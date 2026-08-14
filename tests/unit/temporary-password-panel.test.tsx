import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import { TemporaryPasswordPanel } from "@/app/(app)/admin/accounts/temporary-password-panel";
import en from "@/messages/en.json";
import sw from "@/messages/sw.json";

function renderPanel(locale: "en" | "sw", onDone = vi.fn()) {
  render(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : sw}>
      <TemporaryPasswordPanel password="Qm7rTk2pVx9Ldb4Z" forName="Asha Mushi" onDone={onDone} />
    </NextIntlClientProvider>,
  );
  return onDone;
}

describe("temporary password panel", () => {
  it("shows the password and names who it is for", () => {
    renderPanel("en");
    expect(screen.getByText("Qm7rTk2pVx9Ldb4Z")).toBeInTheDocument();
    expect(screen.getByText(/Asha Mushi/)).toBeInTheDocument();
  });

  it("warns that it is shown once, before the value can be dismissed", () => {
    renderPanel("en");
    expect(screen.getByText(/shown once/i)).toBeInTheDocument();
  });

  it("renders entirely in Swahili when that is the chosen language", () => {
    renderPanel("sw");
    expect(screen.getByText("Nenosiri la muda")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nakili" })).toBeInTheDocument();
    // No English leaks through when a key resolves.
    expect(screen.queryByText("Temporary password")).not.toBeInTheDocument();
  });

  it("hands control back only when the Director confirms they have passed it on", async () => {
    const onDone = renderPanel("en");
    await userEvent.click(screen.getByRole("button", { name: /given it to them/i }));
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("meets the touch-target floor on the actions", () => {
    renderPanel("en");
    for (const button of screen.getAllByRole("button")) {
      expect(button.className).toMatch(/h-12|min-h-11|size-11/);
    }
  });
});
