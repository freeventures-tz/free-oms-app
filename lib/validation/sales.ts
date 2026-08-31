import { z } from "zod";

import { quantityAtLeastOne } from "@/lib/validation/inventory";

/**
 * Zod 4 schemas for the order Server Actions (architecture.md §5.11).
 *
 * Failures return TRANSLATION KEYS, never English sentences (design.md §8.2).
 *
 * None of this is the authority check. A Sales Representative who submits a perfectly valid 40%
 * discount passes every rule here and is refused by the database, which is where product.md §4
 * actually lives.
 */

const idempotencyKeyField = z.string().uuid({ message: "salesErrors.idempotency_key_conflict" });

export const customerNameField = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, " "))
  .pipe(
    z
      .string()
      .min(1, { message: "salesErrors.customerName.tooShort" })
      .max(120, { message: "salesErrors.customerName.tooLong" }),
  );

/**
 * A discount, as a percentage.
 *
 * product.md §4 states the Manager's limit as a percentage ("up to 5%"), so the percentage is what
 * is entered and the shilling amount is derived from it (§5.2). Two decimals, because a percentage
 * is not a count and 2.5% is a real thing to ask for — the shillings it produces are still rounded
 * to a whole one by the database, in one documented place.
 */
export const discountPercentField = z.string().transform((value, ctx) => {
  const trimmed = value.trim().replace(/\s/g, "").replace(/%$/, "");

  if (trimmed.length === 0 || !/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    ctx.addIssue({ code: "custom", message: "salesErrors.discount.invalid" });
    return z.NEVER;
  }

  const parsed = Number(trimmed);

  if (!(parsed > 0) || parsed > 100) {
    ctx.addIssue({ code: "custom", message: "salesErrors.discount.outOfRange" });
    return z.NEVER;
  }

  return parsed;
});

export const reasonField = z
  .string()
  .transform((value) => value.trim())
  .pipe(
    z
      .string()
      .min(3, { message: "salesErrors.reason.tooShort" })
      .max(500, { message: "salesErrors.reason.tooLong" }),
  );

/**
 * One order line.
 *
 * There is no price field. The price comes from the approved current price at the moment the order
 * is written (product.md §4), and a form that could send one would be a form that could quote a
 * customer a figure no Director set.
 */
export const orderLineSchema = z.object({
  productId: z.string().uuid({ message: "salesErrors.no_product" }),
  quantity: quantityAtLeastOne,
});

export const addCustomerSchema = z.object({
  name: customerNameField,
  idempotencyKey: idempotencyKeyField,
});

export const createOrderSchema = z
  .object({
    customerId: z.string().uuid({ message: "salesErrors.no_customer" }),
    lines: z.array(orderLineSchema).min(1, { message: "salesErrors.lines_required" }),
    idempotencyKey: idempotencyKeyField,
  })
  .refine(
    (value) => new Set(value.lines.map((line) => line.productId)).size === value.lines.length,
    { message: "salesErrors.duplicate_product_line", path: ["lines"] },
  );

export const reviseOrderSchema = z
  .object({
    orderId: z.string().uuid({ message: "salesErrors.no_order" }),
    lines: z.array(orderLineSchema).min(1, { message: "salesErrors.lines_required" }),
    idempotencyKey: idempotencyKeyField,
  })
  .refine(
    (value) => new Set(value.lines.map((line) => line.productId)).size === value.lines.length,
    { message: "salesErrors.duplicate_product_line", path: ["lines"] },
  );

export const requestDiscountSchema = z.object({
  orderId: z.string().uuid({ message: "salesErrors.no_order" }),
  percent: discountPercentField,
  reason: reasonField,
  idempotencyKey: idempotencyKeyField,
});

export const orderDecisionSchema = z.object({
  orderId: z.string().uuid({ message: "salesErrors.no_order" }),
  idempotencyKey: idempotencyKeyField,
});

export const orderReasonSchema = z.object({
  orderId: z.string().uuid({ message: "salesErrors.no_order" }),
  reason: reasonField,
  idempotencyKey: idempotencyKeyField,
});
