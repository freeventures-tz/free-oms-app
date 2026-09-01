import { describe, expect, it, vi } from "vitest";

/**
 * What reaches the Cashier's dispatch board about a storekeeper.
 *
 * The board is a client component, so whatever the server hands it is serialised into the page and
 * readable by anyone holding the browser. It renders a `<select>` of names and codes (design.md
 * §7.10) and it was being handed the full §3.2 personnel record — phone number, start date and
 * note — for a control that displays neither.
 *
 * The narrowing is done in the SELECT rather than by mapping the extra fields away afterwards,
 * because a field that never leaves the database cannot be re-leaked by a later change that forgets
 * to drop it again. So this test asserts BOTH: the columns asked for, and the shape returned.
 *
 * It is not a role change. The same three roles read the same table under the same policy; what
 * changes is how much of a row travels.
 */

const createServerSupabase = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: () => createServerSupabase(),
}));

const { loadStorekeeperOptions, loadStorekeepers } = await import("@/lib/settlement/settlement");

const FULL_ROW = {
  id: "3f6a1b2c-4d5e-4f60-8a91-b2c3d4e5f607",
  storekeeper_code: "SK-0001",
  full_name: "Juma Mwenda",
  phone: "+255712345678",
  is_active: true,
  start_date: "2026-01-04",
  note: "works the yard side",
};

/** A client shaped like PostgREST's builder, recording what was asked for. */
function fakeClient(rows: Record<string, unknown>[]) {
  const asked = { columns: "", filters: [] as [string, unknown][], orders: [] as string[] };

  const chain: Record<string, unknown> = {
    select: (columns: string) => {
      asked.columns = columns;
      return chain;
    },
    eq: (column: string, value: unknown) => {
      asked.filters.push([column, value]);
      return chain;
    },
    order: (column: string) => {
      asked.orders.push(column);
      return chain;
    },
    then: (resolve: (value: unknown) => unknown) => resolve({ data: rows, error: null }),
  };

  createServerSupabase.mockResolvedValue({ from: () => chain });
  return asked;
}

describe("the storekeeper options a dispatch assignment is offered", () => {
  it("asks the database for three columns and no more", async () => {
    const asked = fakeClient([FULL_ROW]);

    await loadStorekeeperOptions();

    const columns = asked.columns.replace(/\s+/g, "");
    expect(columns).toBe("id,storekeeper_code,full_name");

    for (const secret of ["phone", "start_date", "note"]) {
      expect(asked.columns, `the assignment read asked for ${secret}`).not.toContain(secret);
    }
  });

  it("returns exactly id, code and display name", async () => {
    // The row it is handed carries everything, as a real one would if the SELECT ever widened.
    fakeClient([FULL_ROW]);

    const [option] = await loadStorekeeperOptions();

    expect(Object.keys(option).sort()).toEqual(["code", "fullName", "id"]);
    expect(option).toEqual({
      id: FULL_ROW.id,
      code: FULL_ROW.storekeeper_code,
      fullName: FULL_ROW.full_name,
    });

    // The value assertions above are the ones that matter, and the serialised check below names
    // the three fields individually so a failure says WHICH one leaked rather than only that the
    // shape changed.
    const serialised = JSON.stringify(option);
    expect(serialised).not.toContain(FULL_ROW.phone);
    expect(serialised).not.toContain(FULL_ROW.start_date);
    expect(serialised).not.toContain(FULL_ROW.note);
  });

  it("offers only storekeepers who are working", async () => {
    // §3.2: deactivated, never deleted — and a switched-off storekeeper cannot take a new dispatch.
    const asked = fakeClient([FULL_ROW]);

    await loadStorekeeperOptions();

    expect(asked.filters).toContainEqual(["is_active", true]);
  });

  it("orders on a unique column last, so a page of them is stable", async () => {
    const asked = fakeClient([FULL_ROW]);

    await loadStorekeeperOptions();

    expect(asked.orders.at(-1)).toBe("id");
  });

  it("leaves the administration record whole, because Settings needs all of it", async () => {
    // The same table, the other reader. §3.2 specifies exactly these fields and the Director's
    // screen shows them; narrowing that one would be removing the feature.
    const asked = fakeClient([FULL_ROW]);

    const [keeper] = await loadStorekeepers();

    expect(asked.columns).toContain("phone");
    expect(asked.columns).toContain("start_date");
    expect(asked.columns).toContain("note");
    expect(keeper.phone).toBe(FULL_ROW.phone);
    expect(keeper.startDate).toBe(FULL_ROW.start_date);
    expect(keeper.note).toBe(FULL_ROW.note);
  });
});
