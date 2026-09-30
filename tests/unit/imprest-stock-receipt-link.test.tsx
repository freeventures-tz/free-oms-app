import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import en from "@/messages/en.json";
import sw from "@/messages/sw.json";
import type { PaidFromDisbursement, StockReceipt } from "@/lib/inventory/inventory";
import { enterReceiptSchema } from "@/lib/validation/inventory";

/**
 * A delivery paid from imprest, on the receiving screen and on the payment (issue #73).
 *
 * The rules — who may link, which payments can be picked, that a link never changes and moves no
 * figure — are the database's and are proved in pgTAP and over real HTTP. This file proves what the
 * screens add: the form offers Paid from imprest only to someone who can pick, lists each payment by
 * number, payee, category and approved amount, sends the one picked and nothing typed, and asks for
 * a pick before it submits; and a receipt and a payment each show the other.
 */

const enterReceiptAction = vi.fn();

vi.mock("@/app/(app)/inventory/actions", () => ({
  enterReceiptAction: (...args: unknown[]) => enterReceiptAction(...args),
  approveReceiptAction: vi.fn(),
  rejectReceiptAction: vi.fn(),
}));

const { ReceivingBoard } = await import("@/app/(app)/inventory/receiving/receiving-board");
const { DisbursementStockReceipts } = await import("@/app/(app)/imprest/stock-receipts");

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
const LOCATIONS = [{ code: "store", sortOrder: 1 }];
const KEY = "33333333-3333-4333-8333-333333333333";

const SAND: PaidFromDisbursement = {
  id: "44444444-4444-4444-8444-444444444444",
  disbursementNo: "FV-DSB-20261001-0003",
  status: "settled",
  category: "materials_and_supplies",
  recipient: "Simba Sand Ltd",
  approved: 40000,
  handedOutAt: "2026-10-01T07:00:00Z",
};
const BOLTS: PaidFromDisbursement = {
  id: "55555555-5555-4555-8555-555555555555",
  disbursementNo: "FV-DSB-20261001-0001",
  status: "handed_out",
  category: "repairs_and_maintenance",
  recipient: "Kariakoo Bolts",
  approved: 12000,
  handedOutAt: "2026-10-01T06:00:00Z",
};

function receipt(paidFrom: StockReceipt["paidFrom"]): StockReceipt {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    supplierId: SUPPLIER.id,
    supplierName: SUPPLIER.name,
    locationCode: "store",
    deliveryNoteRef: "DN-4471",
    deliveryDate: "2026-10-01",
    enteredByName: "Asha Cashier",
    enteredRole: "cashier",
    enteredAt: "2026-10-01T08:00:00Z",
    approval: { status: "pending", decidedByName: null, decidedRole: null, decidedAt: null, note: null },
    lines: [],
    paidFrom,
  };
}

function renderBoard(props: {
  paymentOptions: PaidFromDisbursement[] | null;
  receipts?: StockReceipt[];
  canOpenImprest?: boolean;
  messages?: typeof en;
  locale?: string;
}) {
  return render(
    <NextIntlClientProvider locale={props.locale ?? "en"} messages={props.messages ?? en}>
      <ReceivingBoard
        receipts={props.receipts ?? []}
        suppliers={[SUPPLIER]}
        products={[PRODUCT]}
        units={[UNIT]}
        locations={LOCATIONS}
        canEnter
        canApprove={false}
        idempotencyKey={KEY}
        today="2026-10-01"
        paymentOptions={props.paymentOptions}
        canOpenImprest={props.canOpenImprest ?? false}
      />
    </NextIntlClientProvider>,
  );
}

async function fillReceipt(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /record a delivery/i }));
  await user.selectOptions(screen.getByLabelText(/^supplier$/i), SUPPLIER.id);
  await user.type(screen.getByLabelText(/delivery note number/i), "DN-4471");
  await user.selectOptions(screen.getByLabelText(/^product$/i), PRODUCT.id);
  await user.type(screen.getByLabelText(/^expected/i), "20");
  await user.type(screen.getByLabelText(/^received$/i), "20");
}

beforeEach(() => {
  enterReceiptAction.mockReset();
  enterReceiptAction.mockResolvedValue({ successKey: "inventory.receiving.entered", businessDate: "2026-10-01" });
});

describe("the schema", () => {
  const base = {
    supplierId: SUPPLIER.id,
    locationCode: "store",
    deliveryDate: "2026-10-01",
    deliveryNoteRef: "DN-1",
    lines: [{ productId: PRODUCT.id, expectedQuantity: "1", receivedQuantity: "1", damagedQuantity: "0", damageNote: "" }],
    idempotencyKey: KEY,
  };

  it("takes no disbursement when the delivery was not paid from imprest", () => {
    const parsed = enterReceiptSchema.parse({ ...base, paidFromImprest: "false", disbursementId: "" });
    expect(parsed.disbursementId).toBeNull();
  });

  it("takes the one picked when it was", () => {
    const parsed = enterReceiptSchema.parse({ ...base, paidFromImprest: "true", disbursementId: SAND.id });
    expect(parsed.disbursementId).toBe(SAND.id);
  });

  it("asks for a pick when Paid from imprest is marked and none is chosen", () => {
    const result = enterReceiptSchema.safeParse({ ...base, paidFromImprest: "true", disbursementId: "" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ["disbursementId"],
      message: "inventoryErrors.disbursement_required",
    });
  });

  it("ignores a stale pick once Paid from imprest is unmarked", () => {
    const parsed = enterReceiptSchema.parse({ ...base, paidFromImprest: "false", disbursementId: SAND.id });
    expect(parsed.disbursementId).toBeNull();
  });
});

describe("the receiving form", () => {
  it("offers Paid from imprest, and lists each payment by number, payee, category and approved amount", async () => {
    const user = userEvent.setup();
    renderBoard({ paymentOptions: [SAND, BOLTS] });
    await user.click(screen.getByRole("button", { name: /record a delivery/i }));

    await user.click(screen.getByRole("checkbox", { name: /paid from imprest/i }));
    const picker = screen.getByLabelText(/which payment/i);
    const options = within(picker).getAllByRole("option").slice(1);
    expect(options.map((option) => option.textContent)).toEqual([
      "FV-DSB-20261001-0003 · Simba Sand Ltd · Materials and supplies · TZS 40,000",
      "FV-DSB-20261001-0001 · Kariakoo Bolts · Repairs and maintenance · TZS 12,000",
    ]);
  });

  it("sends the payment picked, and nothing about it typed", async () => {
    const user = userEvent.setup();
    renderBoard({ paymentOptions: [SAND, BOLTS] });
    await fillReceipt(user);
    await user.click(screen.getByRole("checkbox", { name: /paid from imprest/i }));
    await user.selectOptions(screen.getByLabelText(/which payment/i), BOLTS.id);
    await user.click(screen.getByRole("button", { name: /save delivery/i }));

    const data = enterReceiptAction.mock.calls[0][1] as FormData;
    expect(data.get("paidFromImprest")).toBe("true");
    expect(data.get("disbursementId")).toBe(BOLTS.id);
    // Nothing about the payment travels but its id: no amount, payee or category to re-enter.
    expect([...data.keys()].sort()).toEqual(
      ["deliveryDate", "deliveryNoteRef", "disbursementId", "idempotencyKey", "lines", "locationCode", "paidFromImprest", "supplierId"],
    );
  });

  it("sends no payment when Paid from imprest is not marked", async () => {
    const user = userEvent.setup();
    renderBoard({ paymentOptions: [SAND] });
    await fillReceipt(user);
    await user.click(screen.getByRole("button", { name: /save delivery/i }));

    const data = enterReceiptAction.mock.calls[0][1] as FormData;
    expect(data.get("paidFromImprest")).toBe("false");
    expect(data.get("disbursementId")).toBe("");
  });

  it("says so when no payment can be picked", async () => {
    const user = userEvent.setup();
    renderBoard({ paymentOptions: [] });
    await user.click(screen.getByRole("button", { name: /record a delivery/i }));
    await user.click(screen.getByRole("checkbox", { name: /paid from imprest/i }));
    expect(screen.getByText(/no handed-out payment to pick/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/which payment/i)).toBeNull();
  });

  it("says why it cannot save when Paid from imprest is marked and there is nothing to pick", async () => {
    const user = userEvent.setup();
    enterReceiptAction.mockResolvedValue({ fieldErrors: { disbursementId: "inventoryErrors.disbursement_required" } });
    renderBoard({ paymentOptions: [] });
    await fillReceipt(user);
    await user.click(screen.getByRole("checkbox", { name: /paid from imprest/i }));
    await user.click(screen.getByRole("button", { name: /save delivery/i }));
    expect(await screen.findByText("Choose the payment that paid for this delivery.")).toBeInTheDocument();
  });

  it("is not offered to someone who cannot read imprest payments", async () => {
    const user = userEvent.setup();
    renderBoard({ paymentOptions: null });
    await user.click(screen.getByRole("button", { name: /record a delivery/i }));
    expect(screen.queryByRole("checkbox", { name: /paid from imprest/i })).toBeNull();
  });

  it("clears the pick after a delivery is saved", async () => {
    const user = userEvent.setup();
    renderBoard({ paymentOptions: [SAND] });
    await fillReceipt(user);
    await user.click(screen.getByRole("checkbox", { name: /paid from imprest/i }));
    await user.selectOptions(screen.getByLabelText(/which payment/i), SAND.id);
    await user.click(screen.getByRole("button", { name: /save delivery/i }));

    expect(await screen.findByText(/delivery recorded/i)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /paid from imprest/i })).not.toBeChecked();
  });

  it("carries matching Swahili", async () => {
    const user = userEvent.setup();
    renderBoard({ paymentOptions: [SAND], messages: sw as unknown as typeof en, locale: "sw" });
    await user.click(screen.getByRole("button", { name: sw.inventory.receiving.new }));
    expect(screen.getByRole("checkbox", { name: sw.inventory.receiving.paidFromImprest })).toBeInTheDocument();
  });
});

describe("a receipt paid from imprest", () => {
  it("shows its payment, linked for someone who can open it", () => {
    renderBoard({ paymentOptions: null, canOpenImprest: true, receipts: [receipt({
      disbursement: SAND, linkedBy: "Asha Cashier", linkedRole: "cashier", linkedAt: "2026-10-01T08:00:00Z",
    })] });
    const record = screen.getByTestId(`paid-from-${receipt(null).id}`);
    expect(record).toHaveTextContent("Paid from imprest");
    expect(record).toHaveTextContent("Simba Sand Ltd · Materials and supplies · TZS 40,000");
    expect(within(record).getByRole("link", { name: SAND.disbursementNo })).toHaveAttribute(
      "href", `/imprest/disbursements/${SAND.id}`,
    );
  });

  it("names the payment without a link for someone who cannot open imprest", () => {
    renderBoard({ paymentOptions: null, canOpenImprest: false, receipts: [receipt({
      disbursement: SAND, linkedBy: "Asha Cashier", linkedRole: "cashier", linkedAt: "2026-10-01T08:00:00Z",
    })] });
    const record = screen.getByTestId(`paid-from-${receipt(null).id}`);
    expect(record).toHaveTextContent(SAND.disbursementNo);
    expect(within(record).queryByRole("link")).toBeNull();
  });

  it("says nothing of imprest when it was not paid from it", () => {
    renderBoard({ paymentOptions: null, receipts: [receipt(null)] });
    expect(screen.queryByTestId(`paid-from-${receipt(null).id}`)).toBeNull();
  });
});

describe("a payment's stock receipts", () => {
  function renderList(receipts: Parameters<typeof DisbursementStockReceipts>[0]["receipts"]) {
    return render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Dar_es_Salaam">
        <DisbursementStockReceipts receipts={receipts} />
      </NextIntlClientProvider>,
    );
  }

  it("lists each delivery it paid for, with its supplier, note, date, who entered it and where it stands", () => {
    renderList([
      {
        receiptId: "r1", supplier: "Simba Sand", deliveryNoteRef: "DN-2", deliveryDate: "2026-10-01",
        locationCode: "yard", enteredBy: "Asha Cashier", enteredRole: "cashier",
        linkedAt: "2026-10-01T09:00:00Z", approvalStatus: "approved",
      },
      {
        receiptId: "r2", supplier: "Simba Sand", deliveryNoteRef: "DN-1", deliveryDate: "2026-10-01",
        locationCode: "store", enteredBy: "Juma Manager", enteredRole: "manager",
        linkedAt: "2026-10-01T08:00:00Z", approvalStatus: "pending",
      },
    ]);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Simba Sand · DN-2");
    expect(items[0]).toHaveTextContent("Entered by Asha Cashier (Cashier)");
    expect(items[0]).toHaveTextContent("Approved");
    expect(items[1]).toHaveTextContent("Waiting for approval");
  });

  it("says when it paid for none", () => {
    renderList([]);
    expect(screen.getByText(/no stock receipt is marked as paid from this payment/i)).toBeInTheDocument();
  });
});
