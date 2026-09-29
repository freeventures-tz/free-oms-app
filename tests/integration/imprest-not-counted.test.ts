import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { businessDate } from "@/lib/time/business-date";
import {
  SECRET_KEY,
  callApiRpc,
  createLiveStaff,
  ensureDirector,
  type Fixture,
} from "@/tests/integration/helpers";

/**
 * Days nobody counted (issue #69), over real HTTP through PostgREST.
 *
 * pgTAP proves every state and refusal inside one rolled-back transaction, with its business clock
 * moved by hand. These tests commit, so the deferred checks run at COMMIT, and they prove what only
 * real requests can: who may read the open days and the history, two Cashiers racing to count two
 * missed days, a refusal that commits to the audit trail, and a missed day blocking nothing.
 *
 * The integration files share one database and one real day, and today is counted and confirmed by
 * `imprest-daily-count.test.ts`, which runs before this file (see `vitest.config.mts`). So this file
 * opens three missed days behind today, by moving the fund's opening and the counting start back as
 * the local database's owner, counts them late, and leaves no count waiting.
 */

type Count = { id: string; business_date: string; version: number; late_reason: string | null };
type Result = { ok: boolean; reason: string; count?: Count; [key: string]: unknown };
type OpenDay = {
  business_date: string;
  state: string;
  waiting_since: string;
  not_counted_since: string | null;
  awaiting_since: string | null;
  latest_count_id: string | null;
  total: number;
};
type Alert = { kind: string; business_date: string; attempt: number | null; resolution: string; resolved_at: string };

let director: Fixture;
let secondDirector: Fixture;
let manager: Fixture;
let cashier: Fixture;
let secondCashier: Fixture;
let salesRep: Fixture;

const today = businessDate();
/** `YYYY-MM-DD`, `n` days before today, on the calendar (no clock involved). */
const daysBefore = (n: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const [threeAgo, twoAgo, yesterday] = [daysBefore(3), daysBefore(2), daysBefore(1)];

/** SQL as the local database's owner. Never pointed at a hosted database. */
function asOwner(sql: string): void {
  const url = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error("asOwner runs against the local stack only");
  try {
    execFileSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-q", "-f", "-"], {
      input: sql,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
    execFileSync(
      "docker",
      [
        "exec", "-i",
        process.env.SUPABASE_DB_CONTAINER ?? "supabase_db_free-oms-app",
        "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q",
      ],
      { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
  }
}

function startCountingOn(day: string): void {
  asOwner(`
    create or replace function private.imprest_counting_starts_on() returns date
    language sql immutable set search_path = '' as $b$ select '${day}'::date $b$;
  `);
}

async function rpc(who: Fixture, fn: string, args: Record<string, unknown>): Promise<Result> {
  const { data, error } = await who.api.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as Result;
}

async function openDays(who: Fixture, limit = 100, offset = 0): Promise<OpenDay[]> {
  const { data, error } = await who.api.rpc("staff_imprest_open_count_days", { p_limit: limit, p_offset: offset });
  if (error) throw new Error(`open days: ${error.message}`);
  return data as OpenDay[];
}

async function history(who: Fixture): Promise<Alert[]> {
  const { data, error } = await who.api.rpc("staff_imprest_count_alert_history", { p_limit: 100, p_offset: 0 });
  if (error) throw new Error(`history: ${error.message}`);
  return data as Alert[];
}

async function expectedCash(): Promise<number> {
  const { data, error } = await manager.api.rpc("staff_imprest_spending_position");
  if (error) throw new Error(`position: ${error.message}`);
  const p = (data as { posted_balance_tzs: number; awaiting_verification_tzs: number }[])[0];
  return Number(p.posted_balance_tzs) - Number(p.awaiting_verification_tzs);
}

const late = (who: Fixture, day: string, counted: number, reason: string | null, previous: string | null = null, key = randomUUID()) =>
  rpc(who, "staff_enter_imprest_count", {
    p_business_date: day,
    p_previous_count_id: previous,
    p_counted_tzs: counted,
    p_note: null,
    p_late_reason: reason,
    p_idempotency_key: key,
  });

const confirm = (who: Fixture, c: Count, explanation: string | null = null) =>
  rpc(who, "staff_confirm_imprest_count", {
    p_id: c.id,
    p_expected_version: c.version,
    p_explanation: explanation,
    p_note: null,
    p_idempotency_key: randomUUID(),
  });

/** Midnight in Dar es Salaam at the end of `day`, as an instant. */
const closeOf = (day: string) => new Date(`${day}T00:00:00+03:00`).getTime() + 24 * 60 * 60 * 1000;

beforeAll(async () => {
  director = await ensureDirector();
  secondDirector = await createLiveStaff(director, "director", "Second Missed Director");
  manager = await createLiveStaff(director, "manager", "Missed Manager");
  cashier = await createLiveStaff(director, "cashier", "Missed Cashier");
  secondCashier = await createLiveStaff(director, "cashier", "Second Missed Cashier");
  salesRep = await createLiveStaff(director, "sales_rep", "Missed Rep");

  // Three days the fund was open and nobody counted.
  asOwner(`update public.imprest_funds set opened_at = opened_at - interval '5 days' where is_active;`);
  startCountingOn(threeAgo);
});

afterAll(() => {
  startCountingOn(today);
});

describe("days nobody counted, over HTTP", () => {
  let won: Count;

  it("shows each missed day as Not counted, from its close, to both Directors, the Manager and the Cashier", async () => {
    for (const who of [director, secondDirector, manager, cashier]) {
      const days = await openDays(who);
      expect(days.map((d) => `${d.business_date}:${d.state}`), who.role).toEqual([
        `${threeAgo}:not_counted`,
        `${twoAgo}:not_counted`,
        `${yesterday}:not_counted`,
      ]);
    }
    const [oldest] = await openDays(manager);
    expect(new Date(oldest.waiting_since).getTime()).toBe(closeOf(threeAgo));
    expect(Number(oldest.total)).toBe(3);

    // One page at a time, and each page says how many there are in all.
    const second = await openDays(manager, 1, 1);
    expect(second.map((d) => d.business_date)).toEqual([twoAgo]);
    expect(Number(second[0].total)).toBe(3);
  });

  it("refuses the open days to a Sales Representative, and the history to anybody but a Director or the Manager", async () => {
    const rep = await salesRep.api.rpc("staff_imprest_open_count_days", { p_limit: 10, p_offset: 0 });
    expect(rep.error?.message).toMatch(/may not perform this command/);
    for (const who of [cashier, salesRep]) {
      const { error } = await who.api.rpc("staff_imprest_count_alert_history", { p_limit: 10, p_offset: 0 });
      expect(error?.message, who.role).toMatch(/may not perform this command/);
    }
    expect((await callApiRpc("staff_imprest_open_count_days", { p_limit: 10, p_offset: 0 }, SECRET_KEY)).status)
      .toBeGreaterThanOrEqual(400);
    expect(await history(director)).toEqual(expect.any(Array));
    expect(await history(manager)).toEqual(expect.any(Array));
  });

  it("refuses a late count from anybody but the Cashier, and one without a good reason, recording the refusal", async () => {
    for (const who of [director, manager, salesRep]) {
      const { error } = await who.api.rpc("staff_enter_imprest_count", {
        p_business_date: threeAgo,
        p_previous_count_id: null,
        p_counted_tzs: 1000,
        p_note: null,
        p_late_reason: "Nobody was in",
        p_idempotency_key: randomUUID(),
      });
      expect(error?.message, who.role).toMatch(/may not perform this command/);
    }
    expect((await late(cashier, threeAgo, 1000, "no")).reason).toBe("late_reason_invalid");
    expect(await late(cashier, daysBefore(4), 1000, "Before counting began")).toMatchObject({
      ok: false,
      reason: "day_not_countable",
    });

    const { data } = await director.read
      .from("audit_events")
      .select("actor_role, correlation_id, after_state")
      .eq("entity_type", "imprest_count")
      .eq("action", "command_refused")
      .eq("actor_id", cashier.userId);
    const reasons = (data ?? []).map((row) => (row.after_state as { reason: string }).reason);
    expect(reasons).toEqual(expect.arrayContaining(["late_reason_invalid", "day_not_countable"]));
    expect((data ?? []).every((row) => row.actor_role === "cashier" && row.correlation_id)).toBe(true);
  });

  it("lets exactly one of two Cashiers counting two missed days at once enter a count", async () => {
    const expected = await expectedCash();
    const results = await Promise.all([
      late(cashier, threeAgo, expected, "Cashier was off sick"),
      late(secondCashier, twoAgo, expected, "Cashier was off sick"),
    ]);
    const counted = results.filter((r) => r.reason === "counted");
    expect(counted).toHaveLength(1);
    const refused = results.find((r) => r.reason !== "counted")!;
    expect(["earlier_count_waiting", "later_count_waiting"]).toContain(refused.reason);
    won = counted[0].count!;
    expect(won.late_reason).toBe("Cashier was off sick");
    expect(refused.business_date).toBe(won.business_date);
  });

  it("keeps the day open while the late count waits, and closes it once the Manager confirms", async () => {
    const waiting = (await openDays(director)).find((d) => d.business_date === won.business_date)!;
    expect(waiting.state).toBe("awaiting_confirmation");
    expect(waiting.latest_count_id).toBe(won.id);
    expect(new Date(waiting.not_counted_since!).getTime()).toBe(closeOf(won.business_date));

    expect((await confirm(manager, won)).reason).toBe("confirmed");
    expect((await openDays(manager)).map((d) => d.business_date)).not.toContain(won.business_date);

    const resolved = await history(secondDirector);
    const forDay = resolved.filter((a) => a.business_date === won.business_date);
    expect(forDay.map((a) => `${a.kind}:${a.resolution}`).sort()).toEqual([
      "awaiting_confirmation:confirmed",
      "not_counted:counted_late",
    ]);
    // Most recently resolved first.
    const times = resolved.map((a) => new Date(a.resolved_at).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("blocks nothing else while days stay Not counted", async () => {
    expect((await openDays(manager)).some((d) => d.state === "not_counted")).toBe(true);
    const proposed = await rpc(cashier, "staff_propose_imprest_disbursement", {
      p_amount_tzs: 1000,
      p_category: "fuel_and_lubricants",
      p_purpose: "Generator diesel",
      p_idempotency_key: randomUUID(),
    });
    expect(proposed.ok).toBe(true);
  });

  it("records a late count with its actor, live role, day, reason and correlation id", async () => {
    const { data, error } = await director.read
      .from("audit_events")
      .select("actor_id, actor_role, correlation_id, source_operation, after_state")
      .eq("entity_type", "imprest_count")
      .eq("action", "imprest_count_entered")
      .eq("entity_id", won.id);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({
      actor_role: "cashier",
      source_operation: "api.staff_enter_imprest_count",
      after_state: { late: true, late_reason: "Cashier was off sick", business_date: won.business_date },
    });
    expect(data![0].correlation_id).toBeTruthy();
  });

  it("counts the other missed days late and leaves no count waiting", async () => {
    for (const day of [threeAgo, twoAgo, yesterday].filter((d) => d !== won.business_date)) {
      const entered = await late(cashier, day, await expectedCash(), "Counted the next week");
      expect(entered.reason, day).toBe("counted");
      expect((await confirm(manager, entered.count!)).reason, day).toBe("confirmed");
    }
    expect(await openDays(manager)).toEqual([]);
  });
});
