import { beforeEach, describe, expect, it, vi } from "vitest";

import en from "@/messages/en.json";
import sw from "@/messages/sw.json";

/**
 * Review F1 on PR #49: an imprest command whose response is lost was reported as "nothing was
 * changed", while the request, approval or receipt may already have committed.
 *
 * postgrest-js does not throw when the connection drops. It RETURNS an error with `code: ""` and
 * status 0, and a gateway that answers with a page rather than PostgREST returns one with no code
 * at all. Only an error that carries a code is an answer from PostgREST or PostgreSQL, and only
 * then did the call's transaction roll back.
 */

const rpc = vi.fn();
vi.mock("@/lib/supabase/api", () => ({ userApi: async () => ({ rpc }) }));

const { confirmReceived, requestFunding } = await import("@/lib/imprest/commands");

const KEY = "0b7b0a55-0000-4000-8000-000000000001";
const FUNDING = "0b7b0a55-0000-4000-8000-000000000002";
const HANDOVER = "0b7b0a55-0000-4000-8000-000000000003";

const lostResponse = {
  data: null,
  error: { message: "TypeError: fetch failed", details: "", hint: "", code: "" },
  status: 0,
};

describe("an imprest command that reached no verdict", () => {
  beforeEach(() => rpc.mockReset());

  it("is reported as unconfirmed when the connection dropped", async () => {
    rpc.mockResolvedValueOnce(lostResponse);
    const result = await requestFunding({ amount: 50000, reason: "Yard float", idempotencyKey: KEY });
    expect(result).toEqual({ ok: false, reason: "unconfirmed" });
  });

  it("is reported as unconfirmed when a gateway answered instead of PostgREST", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: "<html>502</html>" }, status: 502 });
    const result = await confirmReceived({
      fundingId: FUNDING,
      expectedVersion: 3,
      handoverId: HANDOVER,
      idempotencyKey: KEY,
    });
    expect(result).toEqual({ ok: false, reason: "unconfirmed" });
  });

  it("replays on a retry with the same key, which is what the retry sends", async () => {
    rpc.mockResolvedValueOnce(lostResponse);
    rpc.mockResolvedValueOnce({ data: { ok: true, reason: "replayed" }, error: null, status: 200 });
    const input = { amount: 50000, reason: "Yard float", idempotencyKey: KEY };

    expect(await requestFunding(input)).toEqual({ ok: false, reason: "unconfirmed" });
    expect(await requestFunding(input)).toEqual({ ok: true, reason: "replayed" });
    expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0]);
  });
});

describe("an imprest command the database refused", () => {
  beforeEach(() => rpc.mockReset());

  it("is still not permitted when the live role check raised", async () => {
    rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "caller is not a live Director", details: "", hint: "", code: "42501" },
      status: 403,
    });
    const result = await requestFunding({ amount: 50000, reason: "Yard float", idempotencyKey: KEY });
    expect(result).toEqual({ ok: false, reason: "not_permitted" });
  });

  it("is generic, and truly changed nothing, when PostgreSQL or PostgREST answered with a code", async () => {
    for (const code of ["23505", "57014", "PGRST301"]) {
      rpc.mockResolvedValueOnce({ data: null, error: { message: "refused", code }, status: 400 });
      const result = await requestFunding({ amount: 50000, reason: "Yard float", idempotencyKey: KEY });
      expect(result, code).toEqual({ ok: false, reason: "generic" });
    }
  });
});

describe("the unconfirmed message", () => {
  const messages = { en, sw } as const;

  it.each(["en", "sw"] as const)("never claims nothing changed, and points at the same-key retry (%s)", (locale) => {
    const text = messages[locale].imprestErrors.unconfirmed;
    expect(text).toBeTruthy();
    expect(text).not.toBe(messages[locale].imprestErrors.generic);
    expect(text).toContain(messages[locale].common.retry);
    const noChange = locale === "en" ? /nothing was changed/i : /hakuna kilichobadilishwa/i;
    expect(text).not.toMatch(noChange);
  });
});
