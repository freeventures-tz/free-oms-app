import { describe, expect, it } from "vitest";

import {
  MANAGER_DISCOUNT_MAX_PERCENT,
  MANAGER_DISCOUNT_MIN_SUBTOTAL_TZS,
  discountNeedsDirector,
  mayDecideDiscount,
} from "@/lib/sales/discount-authority";

/**
 * Whose decision a discount is (product.md §4).
 *
 * These are the boundary values `private.discount_needs_director` is asserted on in pgTAP. The two
 * copies exist because the database must ENFORCE the rule and the screen must not OFFER a decision
 * the person cannot make — and they are tested over the same numbers so a change to one that is not
 * made to the other fails here rather than in front of a Manager.
 */

describe("the limit itself", () => {
  it("is the two figures product.md §4 states, not numbers invented here", () => {
    expect(MANAGER_DISCOUNT_MAX_PERCENT).toBe(5);
    expect(MANAGER_DISCOUNT_MIN_SUBTOTAL_TZS).toBe(1_000_000);
  });

  it("keeps a Manager inside 5% on an order ABOVE one million", () => {
    expect(discountNeedsDirector(5, 1_000_001)).toBe(false);
    expect(discountNeedsDirector(4.5, 2_000_000)).toBe(false);
  });

  it("sends anything above 5% to a Director however large the order", () => {
    expect(discountNeedsDirector(5.01, 50_000_000)).toBe(true);
    expect(discountNeedsDirector(100, 50_000_000)).toBe(true);
  });

  it("sends ANY discount on an order of one million or below to a Director", () => {
    // The boundary is "above TZS 1,000,000", so exactly one million is not above it.
    expect(discountNeedsDirector(1, 1_000_000)).toBe(true);
    expect(discountNeedsDirector(0.5, 999_999)).toBe(true);
    expect(discountNeedsDirector(1, 1_000_001)).toBe(false);
  });
});

describe("who may decide one", () => {
  it("lets a Director decide every discount there is", () => {
    expect(mayDecideDiscount("director", 100, 0)).toBe(true);
    expect(mayDecideDiscount("director", 1, 5_000_000)).toBe(true);
  });

  it("lets a Manager decide only the ones inside their limit", () => {
    expect(mayDecideDiscount("manager", 5, 1_000_001)).toBe(true);
    expect(mayDecideDiscount("manager", 6, 1_000_001)).toBe(false);
    expect(mayDecideDiscount("manager", 1, 1_000_000)).toBe(false);
  });

  it("offers the decision to nobody else, whatever the figures", () => {
    // §4.1 names a Manager and a Director. A Sales Representative raises the request and a Cashier
    // has nothing to do with it, and neither becomes a decider because the numbers are small.
    expect(mayDecideDiscount("sales_rep", 1, 5_000_000)).toBe(false);
    expect(mayDecideDiscount("cashier", 1, 5_000_000)).toBe(false);
  });

  it("treats rejection as the same authority as approval", () => {
    // Not a separate function on purpose. §4.3 makes a rejection a completed decision that closes
    // the request, so the screen asks one question — may this person decide this? — and gets one
    // answer for both controls.
    const beyondManager = mayDecideDiscount("manager", 9, 4_000_000);
    expect(beyondManager).toBe(false);
    expect(mayDecideDiscount("director", 9, 4_000_000)).toBe(true);
  });
});
