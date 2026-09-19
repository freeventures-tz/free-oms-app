import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import en from "@/messages/en.json";
import sw from "@/messages/sw.json";
import type { CatalogueProduct, Unit } from "@/lib/catalogue/catalogue";
import type { AppRole } from "@/lib/auth/roles";
import type { Availability, Invoice, InvoiceSettlement, Order } from "@/lib/sales/sales";

/**
 * What the invoice card on an order says about money.
 *
 * It said "Unpaid". Always — to everybody, on every invoice, however much the customer had
 * actually handed over, because the card was written in the stage before payments existed and was
 * never revisited when they arrived. A Cashier could take TZS 600,000 at the till, open the order
 * the money was for, and read that it had not been paid.
 *
 * That is the one kind of defect product.md §12.3 exists to prevent: a status a person reads as a
 * fact about money, derived from nothing. The figures below come from `invoice_settlement` — the
 * same view the payments screen reads — and the card now states what it was told, or says plainly
 * that it was told nothing.
 */

vi.mock("@/app/(app)/orders/actions", () => ({
  confirmOrderAction: vi.fn(),
  cancelOrderAction: vi.fn(),
  approveDiscountAction: vi.fn(),
  rejectDiscountAction: vi.fn(),
  requestDiscountAction: vi.fn(),
  reviseOrderAction: vi.fn(),
}));

const { OrderDetail } = await import("@/app/(app)/orders/[id]/order-detail");

const PRODUCT_ID = "3f1a6b7c-2d4e-4a8f-9c10-5b6d7e8f9a01";
const INVOICE_NO = "FV-INV-20260901-0007";

const PRODUCTS: CatalogueProduct[] = [
  {
    id: PRODUCT_ID,
    name: "Marine 18 mm",
    specification: null,
    unitCode: "piece",
    unitContent: null,
    isActive: true,
    priceTzs: 100_000,
    priceSetAt: "2026-08-01T08:00:00.000Z",
  } as CatalogueProduct,
];

const UNITS: Unit[] = [
  { code: "piece", sortOrder: 1, labelEn: "piece", labelSw: "kipande", isActive: true },
];

const AVAILABILITY: Availability[] = [
  { productId: PRODUCT_ID, physical: 6, reserved: 6, committed: 0, available: 0 },
];

function invoiceOf(settlement: InvoiceSettlement | null, cancelled: boolean): Invoice {
  return {
    id: "7a6b5c4d-3e2f-4109-8a7b-6c5d4e3f2a1b",
    invoiceNo: INVOICE_NO,
    subtotalTzs: 600_000,
    discountTzs: 0,
    totalTzs: 600_000,
    businessDate: "2026-09-01",
    issuedAt: "2026-09-01T08:00:00.000Z",
    cancelledAt: cancelled ? "2026-09-01T10:00:00.000Z" : null,
    cancelReason: cancelled ? "customer changed their mind" : null,
    lines: [],
    settlement,
  };
}

function confirmedOrder(invoice: Invoice): Order {
  return {
    id: "8c2f4d6e-1a3b-4c5d-8e9f-0a1b2c3d4e5f",
    orderNo: "FV-ORD-20260901-0007",
    customerId: "6b5a4c3d-2e1f-4a09-8b7c-6d5e4f3a2b1c",
    customerName: "Juma Builders",
    status: invoice.cancelledAt ? "cancelled" : "confirmed",
    isCashSale: false,
    discountPercent: 0,
    discountReason: null,
    createdByName: "The Rep",
    createdRole: "sales_rep",
    createdAt: "2026-09-01T08:00:00.000Z",
    cancelReason: invoice.cancelReason,
    lines: [],
    proformas: [],
    invoice,
    discount: null,
    reservedQuantity: 0,
  };
}

function renderCard(
  settlement: InvoiceSettlement | null,
  options: { role?: AppRole; cancelled?: boolean; locale?: "en" | "sw" } = {},
) {
  const locale = options.locale ?? "en";

  render(
    <NextIntlClientProvider locale={locale} messages={locale === "sw" ? sw : en}>
      <OrderDetail
        order={confirmedOrder(invoiceOf(settlement, options.cancelled ?? false))}
        products={PRODUCTS}
        units={UNITS}
        availability={AVAILABILITY}
        role={options.role ?? "cashier"}
        idempotencyKey="11111111-2222-3333-4444-555555555555"
      />
    </NextIntlClientProvider>,
  );

  return screen.getByRole("article", { name: INVOICE_NO });
}

function settlementOf(over: Partial<InvoiceSettlement> = {}): InvoiceSettlement {
  return {
    totalTzs: 600_000,
    amountPaidTzs: 0,
    approvedCreditTzs: 0,
    outstandingTzs: 600_000,
    status: "unpaid",
    ...over,
  };
}

describe("the status the invoice card states", () => {
  it("says Paid once the money has all been received", () => {
    const card = renderCard(
      settlementOf({ amountPaidTzs: 600_000, outstandingTzs: 0, status: "paid" }),
    );

    expect(within(card).getByText(/^paid$/i)).toBeVisible();
    // The defect, named: a fully paid invoice used to read Unpaid on this very card.
    expect(within(card).queryByText(/^unpaid$/i)).toBeNull();
  });

  it("says Partly paid, and states the money actually received beside what is left", () => {
    const card = renderCard(
      settlementOf({ amountPaidTzs: 200_000, outstandingTzs: 400_000, status: "partially_paid" }),
    );

    expect(within(card).getByText(/^partly paid$/i)).toBeVisible();
    expect(within(card).getByTestId("invoice-received")).toHaveTextContent("TZS 200,000");
    expect(within(card).getByTestId("invoice-outstanding")).toHaveTextContent("TZS 400,000");
  });

  it("still says Unpaid when nothing has been received, and shows the whole bill outstanding", () => {
    const card = renderCard(settlementOf());

    expect(within(card).getByText(/^unpaid$/i)).toBeVisible();
    expect(within(card).getByTestId("invoice-received")).toHaveTextContent("TZS 0");
    expect(within(card).getByTestId("invoice-outstanding")).toHaveTextContent("TZS 600,000");
  });

  it("keeps a fully credited invoice Unpaid, with the credit labelled apart from the money", () => {
    // product.md §12.5: credit is a settlement decision, not a tender. Nothing was paid.
    const card = renderCard(settlementOf({ approvedCreditTzs: 600_000 }));

    expect(within(card).getByText(/^unpaid$/i)).toBeVisible();
    expect(within(card).getByTestId("invoice-received")).toHaveTextContent("TZS 0");
    expect(within(card).getByTestId("invoice-credit")).toHaveTextContent("TZS 600,000");
  });

  it("judges part tender plus credit on the tender alone", () => {
    const card = renderCard(
      settlementOf({
        amountPaidTzs: 200_000,
        approvedCreditTzs: 400_000,
        outstandingTzs: 400_000,
        status: "partially_paid",
      }),
    );

    expect(within(card).getByText(/^partly paid$/i)).toBeVisible();
    expect(within(card).queryByText(/^paid$/i)).toBeNull();
    expect(within(card).getByTestId("invoice-credit")).toHaveTextContent("TZS 400,000");
  });

  it("says nothing about credit when none was approved", () => {
    const card = renderCard(
      settlementOf({ amountPaidTzs: 600_000, outstandingTzs: 0, status: "paid" }),
    );

    expect(within(card).queryByTestId("invoice-credit")).toBeNull();
  });
});

describe("a cancelled invoice", () => {
  it("stays visibly Cancelled and offers no payment figures", () => {
    const card = renderCard(settlementOf({ status: "cancelled" }), {
      cancelled: true,
      role: "director",
    });

    expect(within(card).getByText(/^cancelled$/i)).toBeVisible();
    expect(within(card).queryByText(/^unpaid$/i)).toBeNull();
    expect(within(card).queryByTestId("invoice-outstanding")).toBeNull();
    expect(within(card).getByText(/cancelled: customer changed their mind/i)).toBeVisible();
  });

  it("reads the same to a Sales Representative, who is withheld no fact they had", () => {
    const card = renderCard(null, { cancelled: true, role: "sales_rep" });

    expect(within(card).getByText(/^cancelled$/i)).toBeVisible();
    expect(within(card).queryByText(/not shown/i)).toBeNull();
  });
});

describe("a role that may not read settlement facts", () => {
  it("is told so, rather than told the invoice is unpaid", () => {
    const card = renderCard(null, { role: "sales_rep" });

    // Not a status, and not a figure: §12.3 has three statuses and none of them means "we did not
    // ask". Printing Unpaid here would be a confident false statement about money.
    expect(within(card).queryByText(/^unpaid$/i)).toBeNull();
    expect(within(card).queryByTestId("invoice-received")).toBeNull();
    expect(within(card).queryByTestId("invoice-outstanding")).toBeNull();
    expect(within(card).getByText(/payment status not shown/i)).toBeVisible();
  });

  it("keeps every invoice fact the role is entitled to", () => {
    const card = renderCard(null, { role: "sales_rep" });

    expect(within(card).getByText(INVOICE_NO)).toBeVisible();
    expect(within(card).getByText(/an invoice cannot be changed/i)).toBeVisible();
  });

  it("says it in Swahili too, with the same meaning and no status word", () => {
    const card = renderCard(null, { role: "sales_rep", locale: "sw" });

    expect(within(card).getByText(/hali ya malipo haionyeshwi/i)).toBeVisible();
    expect(within(card).queryByText(/^haijalipwa$/i)).toBeNull();
  });
});
