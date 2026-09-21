import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  PUBLISHABLE_KEY,
  SUPABASE_URL,
  createLiveStaff,
  ensureDirector,
  type Fixture,
} from "@/tests/integration/helpers";

/**
 * Review F1 on PR #49, against the real database: a funding command COMMITS, its response is lost
 * on the way back, and the application's own command adapter has to say so truthfully.
 *
 * The session is the real one, and the command really reaches PostgREST and commits. Only the
 * response is thrown away, exactly as a dropped connection would. The adapter must then answer
 * `unconfirmed` rather than `generic` ("nothing was changed"), and a retry with the same key must
 * replay the committed result without recording a second request or posting a receipt twice.
 */

let loseNextResponse = false;
let session: Fixture;

/** A fetch that delivers the request, lets the database commit, then loses the answer once. */
async function lossyFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (!loseNextResponse) return response;
  loseNextResponse = false;
  await response.text();
  throw new TypeError("fetch failed");
}

vi.mock("@/lib/supabase/api", () => ({
  userApi: async () =>
    createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${session.accessToken}` }, fetch: lossyFetch },
    }).schema("api"),
}));

const { confirmReceived, requestFunding } = await import("@/lib/imprest/commands");

let director: Fixture;
let manager: Fixture;

async function rpc(who: Fixture, fn: string, args: Record<string, unknown>) {
  const { data, error } = await who.api.rpc(fn, { ...args, p_idempotency_key: randomUUID() });
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as { ok: boolean; reason: string; funding: { id: string; version: number; handover_id: string } };
}

async function posted(): Promise<number> {
  const { data, error } = await director.read.from("imprest_funding_position").select("posted_funding_tzs");
  if (error) throw new Error(error.message);
  return data.length === 0 ? 0 : Number(data[0].posted_funding_tzs);
}

beforeAll(async () => {
  director = await ensureDirector();
  manager = await createLiveStaff(director, "manager", "Lost Response Manager");
});

describe("a funding command whose response is lost after it committed", () => {
  it("is unconfirmed, and the same-key retry replays the one request it created", async () => {
    session = manager;
    const reason = `Lost request ${randomUUID().slice(0, 8)}`;
    const input = { amount: 42000, reason, idempotencyKey: randomUUID() };

    loseNextResponse = true;
    expect(await requestFunding(input)).toEqual({ ok: false, reason: "unconfirmed" });

    // It DID commit, which is exactly why "nothing was changed" would have been false.
    const count = async () => {
      const { data, error } = await director.read.from("imprest_fundings").select("id").eq("reason", reason);
      if (error) throw new Error(error.message);
      return data.length;
    };
    expect(await count()).toBe(1);

    expect(await requestFunding(input)).toEqual({ ok: true, reason: "replayed" });
    expect(await count()).toBe(1);
  });

  it("is unconfirmed on a receipt, and the same-key retry posts it exactly once", async () => {
    session = manager;
    const requested = await rpc(manager, "staff_request_imprest_funding", {
      p_amount_tzs: 31000,
      p_reason: "Lost receipt",
    });
    const approved = await rpc(director, "admin_decide_imprest_funding", {
      p_funding_id: requested.funding.id,
      p_expected_version: requested.funding.version,
      p_approve: true,
      p_amount_tzs: 31000,
      p_reason: null,
    });
    const provided = await rpc(director, "admin_record_imprest_provided", {
      p_funding_id: approved.funding.id,
      p_expected_version: approved.funding.version,
      p_amount_tzs: 31000,
    });
    const before = await posted();
    const input = {
      fundingId: provided.funding.id,
      expectedVersion: provided.funding.version,
      handoverId: provided.funding.handover_id,
      idempotencyKey: randomUUID(),
    };

    loseNextResponse = true;
    expect(await confirmReceived(input)).toEqual({ ok: false, reason: "unconfirmed" });
    expect(await posted()).toBe(before + 31000);

    expect(await confirmReceived(input)).toEqual({ ok: true, reason: "replayed" });
    expect(await posted()).toBe(before + 31000);
  });
});
