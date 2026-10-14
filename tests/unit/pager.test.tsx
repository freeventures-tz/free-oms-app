import { render, screen } from "@testing-library/react";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import { Pager } from "@/components/ui/pager";
import en from "@/messages/en.json";
import sw from "@/messages/sw.json";

function pager(total: number) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <Pager page={1} pageSize={25} total={total} param="awaiting" basePath="/payments" label="Waiting" />
    </NextIntlClientProvider>,
  );
}

describe("the pager under a queue", () => {
  // Every paged section states its own empty message. A generic "Nothing to show" under it said
  // the same thing twice, so an empty queue gets no pager at all.
  it("renders nothing when the queue is empty", () => {
    const { container } = pager(0);
    expect(container).toBeEmptyDOMElement();
  });

  it("states the count when there is something to page", () => {
    pager(3);
    expect(screen.getByTestId("pager-count-awaiting")).toHaveTextContent("Showing 1–3 of 3");
  });
});

describe("counts that read as a sentence", () => {
  it("says one report, not one reports", () => {
    const t = createTranslator({ locale: "en", messages: en, namespace: "reports" });
    expect(t("count", { count: 1 })).toBe("1 report");
    expect(t("count", { count: 2 })).toBe("2 reports");
  });

  it("uses the singular noun class in Swahili where it has one", () => {
    const t = createTranslator({ locale: "sw", messages: sw, namespace: "inventory.suppliers" });
    expect(t("count", { count: 1 })).toBe("Muuzaji 1");
    expect(t("count", { count: 2 })).toBe("Wauzaji 2");
  });
});
