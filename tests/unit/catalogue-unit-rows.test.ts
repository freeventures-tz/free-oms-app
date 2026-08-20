import { describe, expect, it } from "vitest";

import { addUnit, type CatalogueApi } from "@/lib/catalogue/catalogue";

/**
 * What the application will accept as a counting unit, exercised at the seam a Director actually
 * goes through (`addUnit`) rather than at the private mapper behind it.
 *
 * The rule being enforced: a row either produces a whole `Unit` or produces none. There is no third
 * state. A half-built unit reaches the Add product picker, where it renders as a blank option a
 * Director can select and attach a product to permanently — and `code` is what every product row
 * then references, so the damage outlives the render.
 *
 * `is_active` is the subtle one. `false` is a real answer meaning retired. Missing, or a string, or
 * a number, is not "retired" — it is a row nobody can vouch for, and treating it as retired would
 * quietly launder a broken response into a plausible-looking object.
 */

/** A stand-in for the RPC, returning exactly the payload under test. */
function apiReturning(unit: unknown): CatalogueApi {
  return {
    rpc: async () => ({ data: { ok: true, reason: "added", unit }, error: null }),
  } as unknown as CatalogueApi;
}

const COMPLETE = {
  code: "drum",
  sort_order: 70,
  label_en: "drum",
  label_sw: "ngoma",
  is_active: true,
};

const request = { labelEn: "drum", labelSw: "ngoma", idempotencyKey: "k" };

describe("a counting unit returned by the add-unit command", () => {
  it("is accepted when every field is present and well typed", async () => {
    const result = await addUnit(request, apiReturning(COMPLETE));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unit).toEqual({
      code: "drum",
      sortOrder: 70,
      labelEn: "drum",
      labelSw: "ngoma",
      isActive: true,
    });
  });

  it("carries a numeric sort order that arrived as a string", async () => {
    // The command answers in jsonb, where a numeric column can come back quoted. A cast would
    // type-check and hand the picker "70" to sort by; the coercion is deliberate.
    const result = await addUnit(request, apiReturning({ ...COMPLETE, sort_order: "70" }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unit.sortOrder).toBe(70);
  });

  it("accepts a genuinely retired unit, because false is an answer", async () => {
    const result = await addUnit(request, apiReturning({ ...COMPLETE, is_active: false }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unit.isActive).toBe(false);
  });

  it("refuses a row whose active state is missing rather than calling it retired", async () => {
    const withoutActive = { ...COMPLETE } as Record<string, unknown>;
    delete withoutActive.is_active;
    const result = await addUnit(request, apiReturning(withoutActive));

    // Silently reading this as `false` would turn an unanswerable row into a plausible object.
    expect(result.ok).toBe(false);
  });

  it("refuses an active state that is not a boolean", async () => {
    for (const is_active of ["true", 1, null]) {
      const result = await addUnit(request, apiReturning({ ...COMPLETE, is_active }));
      expect(result.ok, `is_active ${JSON.stringify(is_active)} was accepted`).toBe(false);
    }
  });

  it("refuses a row with a missing sort order rather than sorting it to the front", async () => {
    // `Number(null)` is 0, which is a valid finite number and would place a broken row first in
    // the picker. The type has to be checked before the coercion, not after it.
    for (const sort_order of [null, undefined, "", "not a number"]) {
      const result = await addUnit(request, apiReturning({ ...COMPLETE, sort_order }));
      expect(result.ok, `sort_order ${JSON.stringify(sort_order)} was accepted`).toBe(false);
    }
  });

  it("refuses a row missing either label, in either language", async () => {
    for (const field of ["label_en", "label_sw"] as const) {
      const result = await addUnit(request, apiReturning({ ...COMPLETE, [field]: "" }));
      expect(result.ok, `a blank ${field} was accepted`).toBe(false);

      const missing = { ...COMPLETE } as Record<string, unknown>;
      delete missing[field];
      const absent = await addUnit(request, apiReturning(missing));
      expect(absent.ok, `a missing ${field} was accepted`).toBe(false);
    }
  });

  it("refuses a row with no code, which is what every product would reference", async () => {
    const result = await addUnit(request, apiReturning({ ...COMPLETE, code: "" }));
    expect(result.ok).toBe(false);
  });

  it("refuses a response with no unit at all", async () => {
    const result = await addUnit(request, apiReturning(undefined));
    expect(result.ok).toBe(false);
  });
});
