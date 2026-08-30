import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import en from "@/messages/en.json";
import { businessDate } from "@/lib/time/business-date";

/**
 * The date a new receipt starts with, on a page that has been open a while.
 *
 * A receiving screen is not a page somebody opens and closes. It is left open on a phone in the
 * store for a shift, and a shift crosses midnight. The delivery date is therefore decided twice:
 * once on the server when the page renders, and again on the server when a receipt succeeds — and
 * the second answer is the one the NEXT delivery must start with.
 *
 * The bug this file exists to prevent: resetting from the `today` prop captured at render. That is
 * correct all day and silently a day stale from midnight until the page is reloaded, on the record
 * where the date is permanent once approved. It cannot be caught by a browser test, because only
 * the server's clock decides either value.
 */

const enterReceiptAction = vi.fn();

vi.mock("@/app/(app)/inventory/actions", () => ({
  enterReceiptAction: (...args: unknown[]) => enterReceiptAction(...args),
  approveReceiptAction: vi.fn(),
  rejectReceiptAction: vi.fn(),
}));

const { ReceivingBoard } = await import("@/app/(app)/inventory/receiving/receiving-board");

/** 23:59 in Dar es Salaam — the page renders, and the server says it is still the 30th. */
const OPENED_AT = new Date("2026-08-30T20:59:00Z");
/** 00:01 in Dar es Salaam, two minutes later — the receipt succeeds on the 31st. */
const SUCCEEDED_AT = new Date("2026-08-30T21:01:00Z");

const SUPPLIER = { id: "11111111-1111-4111-8111-111111111111", name: "Nyati Hardware", isActive: true };
const PRODUCT = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Marine",
  specification: "18 mm",
  unitCode: "sheet",
  unitContent: null,
  isActive: true,
  priceTzs: null,
  priceSetAt: null,
};
const UNIT = { code: "sheet", sortOrder: 1, labelEn: "sheets", labelSw: "mabati", isActive: true };
const LOCATIONS = [
  { code: "store", sortOrder: 1 },
  { code: "warehouse", sortOrder: 2 },
];

function renderBoard(today: string) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ReceivingBoard
        receipts={[]}
        suppliers={[SUPPLIER]}
        products={[PRODUCT]}
        units={[UNIT]}
        locations={LOCATIONS}
        canEnter
        canApprove={false}
        idempotencyKey="33333333-3333-4333-8333-333333333333"
        today={today}
      />
    </NextIntlClientProvider>,
  );
}

/** Opens the form and fills in everything except the date, which is the value under test. */
async function fillReceipt(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /record a delivery/i }));

  await user.selectOptions(screen.getByLabelText(/^supplier$/i), SUPPLIER.id);
  await user.type(screen.getByLabelText(/delivery note number/i), "DN-4471");
  await user.selectOptions(screen.getByLabelText(/^product$/i), PRODUCT.id);
  await user.type(screen.getByLabelText(/^expected/i), "20");
  await user.type(screen.getByLabelText(/^received$/i), "20");
}

const dateField = () => screen.getByLabelText(/delivery date/i) as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the delivery date after a receipt is saved", () => {
  it("the two instants really do fall on different business days", () => {
    // The premise of every case below. If EAT ever stopped being UTC+3 this would fail first, and
    // loudly, rather than the tests below quietly proving nothing.
    expect(businessDate(OPENED_AT)).toBe("2026-08-30");
    expect(businessDate(SUCCEEDED_AT)).toBe("2026-08-31");
  });

  it("resets to the date the SERVER returned, not the one the page opened with", async () => {
    const user = userEvent.setup();
    enterReceiptAction.mockResolvedValue({
      successKey: "inventory.receiving.entered",
      businessDate: businessDate(SUCCEEDED_AT),
    });

    renderBoard(businessDate(OPENED_AT));
    await fillReceipt(user);

    // What the page opened with: the server's answer at render time, still the 30th.
    expect(dateField().value).toBe("2026-08-30");

    await user.click(screen.getByRole("button", { name: /save delivery/i }));

    // The page has been open across midnight. The next delivery belongs to the new day, and the
    // stale prop is still sitting in this component saying otherwise.
    await waitFor(() => expect(dateField().value).toBe("2026-08-31"));
  });

  it("does not compute the new date in the browser", async () => {
    const user = userEvent.setup();
    // A date no clock anywhere would produce, so the only way it can reach the field is by being
    // read out of the response.
    enterReceiptAction.mockResolvedValue({
      successKey: "inventory.receiving.entered",
      businessDate: "2031-12-25",
    });

    renderBoard("2026-08-30");
    await fillReceipt(user);
    await user.click(screen.getByRole("button", { name: /save delivery/i }));

    await waitFor(() => expect(dateField().value).toBe("2031-12-25"));
  });

  it("falls back to the rendered date if a success carried none", async () => {
    const user = userEvent.setup();
    enterReceiptAction.mockResolvedValue({ successKey: "inventory.receiving.entered" });

    renderBoard("2026-08-30");
    await fillReceipt(user);
    await user.click(screen.getByRole("button", { name: /save delivery/i }));

    // Never blank. An emptied field would make the person type what the server already knows.
    await waitFor(() => expect(dateField().value).toBe("2026-08-30"));
  });

  it("a REFUSAL keeps the entered date and every other value, and resets nothing", async () => {
    const user = userEvent.setup();
    enterReceiptAction.mockResolvedValue({ error: "inventoryErrors.delivery_date_future" });

    renderBoard(businessDate(OPENED_AT));
    await fillReceipt(user);

    // The person corrected the date themselves before submitting.
    await user.clear(dateField());
    await user.type(dateField(), "2026-08-28");

    await user.click(screen.getByRole("button", { name: /save delivery/i }));
    expect(await screen.findByText(/cannot be dated in the future/i)).toBeVisible();

    // Their date, not the rendered one and not a server one — a refusal is not a reset.
    expect(dateField().value).toBe("2026-08-28");
    expect((screen.getByLabelText(/delivery note number/i) as HTMLInputElement).value).toBe(
      "DN-4471",
    );
    expect((screen.getByLabelText(/^received$/i) as HTMLInputElement).value).toBe("20");
  });
});
