import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #69, Greptile on PR #75. A confirmation can empty the page a link was built for. An empty
 * page past the first must not read as an empty list, or the screen would say every day is closed
 * while earlier pages still hold open ones.
 */

const rpc = vi.fn();
vi.mock("@/lib/supabase/api", () => ({ userApi: async () => ({ rpc }) }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabase: vi.fn() }));

const { loadAlertHistory, loadOpenDays } = await import("@/lib/imprest/counts");

const day = (n: number) => ({
  business_date: `2026-09-${String(n).padStart(2, "0")}`,
  state: "not_counted",
  waiting_since: "2026-09-10T21:00:00+00:00",
  not_counted_since: "2026-09-10T21:00:00+00:00",
  awaiting_since: null,
  latest_count_id: null,
  latest_status: null,
  latest_return_reason: null,
  total: 12,
});

/** Twelve open days, answered a page at a time as the database would. */
function twelveOpenDays() {
  rpc.mockImplementation(async (_fn: string, args: { p_limit: number; p_offset: number }) => ({
    data: Array.from({ length: 12 }, (_, i) => day(i + 1)).slice(args.p_offset, args.p_offset + args.p_limit),
    error: null,
  }));
}

// A block body: a function returned from beforeEach runs as its teardown, and would call the mock.
beforeEach(() => {
  rpc.mockReset();
});

describe("a page of open days", () => {
  it("returns the page asked for when it has rows", async () => {
    twelveOpenDays();
    const page = await loadOpenDays(2);
    expect(page).toMatchObject({ page: 2, total: 12 });
    expect(page.rows.map((d) => d.businessDate)).toEqual(["2026-09-11", "2026-09-12"]);
  });

  it("falls back to the last page with rows when the one asked for has emptied", async () => {
    twelveOpenDays();
    const page = await loadOpenDays(5);
    expect(page).toMatchObject({ page: 2, total: 12 });
    expect(page.rows).toHaveLength(2);
  });

  it("says the list is empty only when the first page is", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    expect(await loadOpenDays(3)).toMatchObject({ page: 1, total: 0, rows: [] });
  });

  it("treats a row it cannot place as a failed read", async () => {
    rpc.mockResolvedValue({ data: [{ ...day(1), state: "balanced" }], error: null });
    await expect(loadOpenDays(1)).rejects.toThrow("data_unavailable");
  });
});

describe("a page of resolved alerts", () => {
  it("falls back the same way", async () => {
    rpc.mockImplementation(async (_fn: string, args: { p_offset: number }) => ({
      data:
        args.p_offset === 0
          ? [
              {
                kind: "not_counted",
                business_date: "2026-09-01",
                count_id: null,
                attempt: null,
                raised_at: "2026-09-01T21:00:00+00:00",
                resolved_at: "2026-09-03T08:00:00+00:00",
                resolution: "counted_late",
                total: 1,
              },
            ]
          : [],
      error: null,
    }));
    expect(await loadAlertHistory(4)).toMatchObject({ page: 1, total: 1 });
  });
});
