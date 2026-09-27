import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import sw from "@/messages/sw.json";
import { ENCRYPTION_OVERHEAD, decryptReceipt, encryptReceipt } from "@/lib/imprest/receipt-crypto";
import { NO_RECEIPT_REASONS, receiptType, settlementFigures } from "@/lib/imprest/spending";
import { fieldErrors } from "@/lib/validation/auth";
import { handOutSchema, registerReceiptSchema, settleSchema } from "@/lib/validation/imprest";

/**
 * Issue #62: the settlement equation, the receipt-or-reason rule and receipt encryption, as the
 * browser applies them before the database applies them again.
 */

const ID = "7d4f5b1e-3c1a-4a55-9a53-2f4c9e1d2b10";
const RECEIPT = "0b8e6c2a-5d44-4f0e-8a61-9b1c3d2e4f50";
const KEY = "9f1b8d1c-6e0a-4d6f-9d5a-1c7b3e2a4f60";

type LineInput = { amount: string; purpose: string; receiptId: string | null; reason: string | null; note: string };
const line = (overrides: Partial<LineInput> = {}): LineInput => ({
  amount: "35000",
  purpose: "Petrol, Dar to Kibaha",
  receiptId: RECEIPT,
  reason: null,
  note: "",
  ...overrides,
});

function settle(lines: LineInput[], returned: string, explanation = "", approved = 60000) {
  return settleSchema.safeParse({
    disbursementId: ID,
    expectedVersion: "3",
    approved: String(approved),
    lines: JSON.stringify(lines),
    returned,
    explanation,
    idempotencyKey: KEY,
  });
}

const errorsOf = (result: ReturnType<typeof settle>) => (result.success ? {} : fieldErrors(result.error));

describe("the settlement equation", () => {
  it("explains the trip allowance: three receipts and TZS 13,000 of change", () => {
    expect(settlementFigures(60000, [35000, 2000, 10000], 13000)).toEqual({
      used: 47000,
      returned: 13000,
      unexplained: 0,
      over: 0,
    });
  });

  it("leaves TZS 3,000 unexplained when the change comes back short", () => {
    expect(settlementFigures(60000, [35000, 2000, 10000], 10000).unexplained).toBe(3000);
  });

  it("reports how far a settlement goes over the approval", () => {
    expect(settlementFigures(60000, [55000], 13000)).toMatchObject({ over: 8000, unexplained: 0 });
  });

  it("treats a called-off trip as all returned and nothing used", () => {
    expect(settlementFigures(60000, [], 60000)).toEqual({ used: 0, returned: 60000, unexplained: 0, over: 0 });
  });

  it("counts a line not yet typed as nothing", () => {
    expect(settlementFigures(20000, [null, 5000], null)).toMatchObject({ used: 5000, unexplained: 15000 });
  });
});

describe("the settle form's checks", () => {
  it("accepts the trip allowance", () => {
    const result = settle(
      [line(), line({ amount: "2000", purpose: "Parking", receiptId: "1b8e6c2a-5d44-4f0e-8a61-9b1c3d2e4f50" })],
      "23000",
    );
    expect(result.success).toBe(true);
  });

  it("refuses Used plus Returned above the approval", () => {
    expect(errorsOf(settle([line({ amount: "55000" })], "13000"))).toMatchObject({
      returned: "spendingErrors.over_approval_field",
    });
  });

  it("requires an explanation for a remainder, and refuses one when nothing is missing", () => {
    expect(errorsOf(settle([line()], "10000"))).toMatchObject({ explanation: "spendingErrors.explanation_required" });
    expect(settle([line()], "10000", "Driver short").success).toBe(true);
    expect(errorsOf(settle([line()], "25000", "Nothing missing"))).toMatchObject({
      explanation: "spendingErrors.explanation_not_needed",
    });
  });

  it("requires a receipt or a reason on every line, never both", () => {
    expect(errorsOf(settle([line({ receiptId: null })], "25000"))).toMatchObject({
      "lines.0.evidence": "spendingErrors.line_evidence_required",
    });
    expect(errorsOf(settle([line({ reason: "transport_fare" })], "25000"))).toMatchObject({
      "lines.0.evidence": "spendingErrors.line_evidence_both",
    });
  });

  it("accepts each of the six No-receipt reasons, with the note the last two need", () => {
    const lines = NO_RECEIPT_REASONS.map((reason) =>
      line({ amount: "1000", receiptId: null, reason, note: reason === "other" || reason === "receipt_lost_or_damaged" ? "Fell in the mixer" : "" }),
    );
    expect(settle(lines, "0", "", 6000).success).toBe(true);
  });

  it("refuses a lost receipt or Other without an explanation", () => {
    for (const reason of ["receipt_lost_or_damaged", "other"]) {
      expect(errorsOf(settle([line({ receiptId: null, reason })], "25000")), reason).toMatchObject({
        "lines.0.note": "spendingErrors.no_receipt_note_required",
      });
    }
  });

  it("refuses one receipt cited on two lines", () => {
    expect(errorsOf(settle([line({ amount: "20000" }), line({ amount: "15000" })], "25000"))).toMatchObject({
      "lines.1.evidence": "spendingErrors.receipt_cited_twice",
    });
  });

  it("refuses more than twenty lines and a zero amount", () => {
    const many = Array.from({ length: 21 }, () => line({ amount: "100", receiptId: null, reason: "transport_fare" }));
    expect(errorsOf(settle(many, "57900"))).toMatchObject({ lines: "spendingErrors.too_many_lines" });
    expect(errorsOf(settle([line({ amount: "0" })], "60000"))).toMatchObject({
      "lines.0.amount": "spendingErrors.amount_invalid",
    });
  });

  it("takes a recipient of 2 to 120 characters and no amount", () => {
    const handOut = (recipient: string) =>
      handOutSchema.safeParse({ disbursementId: ID, expectedVersion: "2", recipient, idempotencyKey: KEY });
    expect(handOut("  Juma  the driver ").data?.recipient).toBe("Juma the driver");
    expect(handOut("J").success).toBe(false);
    expect(handOut("x".repeat(121)).success).toBe(false);
    expect(Object.keys(handOutSchema.shape)).not.toContain("amount");
  });

  it("takes the five receipt types up to 15 MiB", () => {
    const register = (contentType: string, byteSize: number) =>
      registerReceiptSchema.safeParse({ disbursementId: ID, fileName: "r.jpg", contentType, byteSize, idempotencyKey: KEY });
    for (const type of ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"]) {
      expect(register(type, 3_000_000).success, type).toBe(true);
    }
    expect(register("image/gif", 1000).success).toBe(false);
    expect(register("image/jpeg", 15 * 1024 * 1024 + 1).success).toBe(false);
  });
});

describe("receipt types from a phone", () => {
  it("reads the type the browser gives, or the extension when it gives none", () => {
    expect(receiptType({ name: "IMG_0001.JPG", type: "image/jpeg" })).toBe("image/jpeg");
    expect(receiptType({ name: "IMG_0002.HEIC", type: "" })).toBe("image/heic");
    expect(receiptType({ name: "photo.heif", type: "image/heif" })).toBe("image/heic");
    expect(receiptType({ name: "scan.pdf", type: "application/octet-stream" })).toBe("application/pdf");
    expect(receiptType({ name: "notes.txt", type: "text/plain" })).toBeNull();
    expect(receiptType({ name: "fake.jpg", type: "text/html" })).toBeNull();
  });
});

describe("receipt encryption", () => {
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const photo = crypto.getRandomValues(new Uint8Array(4096));

  it("round-trips a file, adding only the nonce and the tag", async () => {
    const stored = await encryptReceipt(photo.slice().buffer, key);
    expect(stored.byteLength).toBe(photo.byteLength + ENCRYPTION_OVERHEAD);
    expect(new Uint8Array(await decryptReceipt(stored.buffer, key))).toEqual(photo);
  });

  it("never stores the same bytes twice, and never the plain bytes", async () => {
    const a = await encryptReceipt(photo.slice().buffer, key);
    const b = await encryptReceipt(photo.slice().buffer, key);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(Buffer.from(a).includes(Buffer.from(photo.subarray(0, 32)))).toBe(false);
  });

  it("refuses the wrong key and a changed byte", async () => {
    const stored = await encryptReceipt(photo.slice().buffer, key);
    const other = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    await expect(decryptReceipt(stored.slice().buffer, other)).rejects.toThrow();
    const tampered = stored.slice();
    tampered[100] ^= 1;
    await expect(decryptReceipt(tampered.buffer, key)).rejects.toThrow();
  });
});

describe("the words on screen", () => {
  const flatten = (value: unknown, prefix = ""): string[] =>
    value && typeof value === "object"
      ? Object.entries(value).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k))
      : [prefix];

  it("has every English key in Swahili, and the reverse", () => {
    expect(flatten(sw).sort()).toEqual(flatten(en).sort());
  });

  it("shows the six No-receipt reasons the Owner approved, word for word", () => {
    expect(Object.values(en.imprest.spending.noReceiptReason)).toEqual([
      "Vendor did not issue receipt",
      "Informal or casual labour",
      "Transport fare",
      "Emergency purchase",
      "Receipt lost or damaged",
      "Other",
    ]);
  });

  it("never shows the word encumber, in English or Swahili", () => {
    // Values only: an older key is named `encumberedTzs`, and what it shows is "Committed".
    const words = (messages: unknown): string[] =>
      messages && typeof messages === "object" ? Object.values(messages).flatMap(words) : [String(messages)];
    expect(words(en).filter((text) => /encumb/i.test(text))).toEqual([]);
    expect(words(sw).filter((text) => /encumb/i.test(text))).toEqual([]);
  });
});
