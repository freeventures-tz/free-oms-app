import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import en from "@/messages/en.json";
import type { CatalogueProduct, Unit } from "@/lib/catalogue/catalogue";
import type { Availability, Order } from "@/lib/sales/sales";

/**
 * What happens when the server REFUSES a confirmation.
 *
 * Confirming an order is a two-step sheet, and `AlertDialog` traps focus inside it. That is right
 * for a decision that creates a financial record — and it is exactly why the refusal has to be
 * rendered in the same surface. Reporting it on the card behind the sheet produced a screen where
 * pressing "Yes, confirm the order" appeared to do nothing, and the only way to discover that the
 * stock had gone was to dismiss the thing that had just told you nothing.
 *
 * The other two claims here are the ones a refusal makes expensive to get wrong: a retry must
 * address the SAME command, so a request that did reach the database is resumed rather than
 * repeated; and a burst on the confirm button must produce one operation, not one per press.
 */

const confirmOrderAction = vi.fn();

vi.mock("@/app/(app)/orders/actions", () => ({
  confirmOrderAction: (...args: unknown[]) => confirmOrderAction(...args),
  cancelOrderAction: vi.fn(),
  approveDiscountAction: vi.fn(),
  rejectDiscountAction: vi.fn(),
  requestDiscountAction: vi.fn(),
  reviseOrderAction: vi.fn(),
}));

const { OrderDetail } = await import("@/app/(app)/orders/[id]/order-detail");

const PRODUCT_ID = "3f1a6b7c-2d4e-4a8f-9c10-5b6d7e8f9a01";

const PRODUCTS: CatalogueProduct[] = [
  {
    id: PRODUCT_ID,
    name: "Marine 18 mm",
    specification: null,
    unitCode: "piece",
    unitContent: null,
    isActive: true,
    priceTzs: 40_000,
    priceSetAt: "2026-08-01T08:00:00.000Z",
  } as CatalogueProduct,
];

const UNITS: Unit[] = [
  { code: "piece", sortOrder: 1, labelEn: "piece", labelSw: "kipande", isActive: true },
];

const AVAILABILITY: Availability[] = [
  { productId: PRODUCT_ID, physical: 3, reserved: 0, committed: 0, available: 3 },
];

function proformaOrder(): Order {
  return {
    id: "8c2f4d6e-1a3b-4c5d-8e9f-0a1b2c3d4e5f",
    orderNo: "FV-ORD-20260831-0001",
    customerId: "6b5a4c3d-2e1f-4a09-8b7c-6d5e4f3a2b1c",
    customerName: "Juma Builders",
    status: "proforma",
    isCashSale: false,
    discountPercent: 0,
    discountReason: null,
    createdByName: "The Rep",
    createdRole: "sales_rep",
    createdAt: "2026-08-31T08:00:00.000Z",
    cancelReason: null,
    lines: [
      {
        id: "1d2c3b4a-5f6e-4708-9a1b-2c3d4e5f6a7b",
        productId: PRODUCT_ID,
        quantity: 8,
        unitPriceTzs: 40_000,
        lineTotalTzs: 320_000,
      },
    ],
    proformas: [
      {
        id: "2e3d4c5b-6a79-4801-9b2c-3d4e5f6a7b8c",
        version: 1,
        proformaNo: "FV-PRO-20260831-0001",
        subtotalTzs: 320_000,
        discountTzs: 0,
        totalTzs: 320_000,
        // Comfortably in the future, so the quotation is not treated as expired.
        validUntil: "2099-12-31",
        issuedAt: "2026-08-31T08:00:00.000Z",
        supersededAt: null,
        lines: [],
      },
    ],
    invoice: null,
    discount: null,
    reservedQuantity: 0,
  };
}

function renderOrder() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <OrderDetail
        order={proformaOrder()}
        products={PRODUCTS}
        units={UNITS}
        availability={AVAILABILITY}
        role="sales_rep"
        idempotencyKey="11111111-2222-3333-4444-555555555555"
      />
    </NextIntlClientProvider>,
  );
}

/** Opens the confirmation sheet and returns it, so every assertion is scoped INSIDE it. */
async function openConfirmation(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /record customer confirmation/i }));
  return screen.getByRole("alertdialog");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  confirmOrderAction.mockReset();
});

describe("a refused confirmation", () => {
  it("reports the refusal inside the sheet, not on the card behind it", async () => {
    const user = userEvent.setup();
    confirmOrderAction.mockResolvedValue({
      error: "salesErrors.insufficient_stock",
      errorValues: { available: 3, requested: 8 },
    });

    renderOrder();
    const sheet = await openConfirmation(user);
    await user.click(within(sheet).getByRole("button", { name: /yes, confirm the order/i }));

    const alert = await within(sheet).findByRole("alert");
    expect(alert).toHaveTextContent(/there is not enough stock/i);
    // The numbers, because "no" on its own leaves the person guessing what to do next.
    expect(alert).toHaveTextContent(/3 can be sold, 8 asked for/i);

    // Still open. Closing it would put the answer behind the thing that was just dismissed.
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("offers a retry in the same surface, addressing the identical request", async () => {
    const user = userEvent.setup();
    confirmOrderAction.mockResolvedValue({ error: "salesErrors.generic" });

    renderOrder();
    const sheet = await openConfirmation(user);
    await user.click(within(sheet).getByRole("button", { name: /yes, confirm the order/i }));

    const dialog = screen.getByRole("alertdialog");

    // Wait for the attempt to SETTLE before reaching for the retry. A control that is still pending
    // is disabled — that is rule 4 of the feedback contract doing its job — and clicking it records
    // nothing, which shows up later as "one call instead of two" and looks like a broken retry.
    await within(dialog).findByRole("alert");
    const retry = await within(dialog).findByRole("button", { name: /try again/i });
    await waitFor(() => expect(retry).toBeEnabled());

    await user.click(retry);

    await waitFor(() => expect(confirmOrderAction).toHaveBeenCalledTimes(2));

    const first = confirmOrderAction.mock.calls[0][1] as FormData;
    const second = confirmOrderAction.mock.calls[1][1] as FormData;

    // The SAME idempotency key, so a command that did reach the database is resumed rather than
    // issued twice. A fresh key here would be a second confirmation of the same order.
    expect(second.get("idempotencyKey")).toBe(first.get("idempotencyKey"));
    expect(second.get("orderId")).toBe(first.get("orderId"));
  });

  it("still produces ONE operation when the confirm button is pressed twice", async () => {
    const user = userEvent.setup();
    const inFlight = deferred<{ error: string }>();
    confirmOrderAction.mockReturnValue(inFlight.promise);

    renderOrder();
    const sheet = await openConfirmation(user);
    const confirm = within(sheet).getByRole("button", { name: /yes, confirm the order/i });

    await user.click(confirm);
    await user.click(confirm);

    expect(confirmOrderAction).toHaveBeenCalledTimes(1);

    inFlight.resolve({ error: "salesErrors.generic" });
    await waitFor(() =>
      expect(within(screen.getByRole("alertdialog")).getByRole("alert")).toBeInTheDocument(),
    );
  });

  it("does not carry a stale refusal into the next decision", async () => {
    const user = userEvent.setup();
    confirmOrderAction.mockResolvedValue({ error: "salesErrors.generic" });

    renderOrder();
    const sheet = await openConfirmation(user);
    await user.click(within(sheet).getByRole("button", { name: /yes, confirm the order/i }));
    await within(screen.getByRole("alertdialog")).findByRole("alert");

    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: /go back/i }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());

    const reopened = await openConfirmation(user);
    expect(within(reopened).queryByRole("alert")).not.toBeInTheDocument();
  });
});
