import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { businessDate } from "@/lib/time/business-date";
import {
  PUBLISHABLE_KEY,
  SECRET_KEY,
  callApiRpc,
  createLiveStaff,
  ensureDirector,
  type Fixture,
} from "@/tests/integration/helpers";
import { runSql } from "@/tests/support/database";
import {
  generateReportFor,
  resetScheduledReportDay,
  type ScheduledReportResult,
} from "@/tests/support/scheduled-report";

/**
 * The daily report's imprest section (issue #82), over real HTTP through PostgREST.
 *
 * pgTAP proves the section's rules inside one rolled-back transaction, the cutoff included. These
 * tests commit real commands as each role, write a report of today with the generator's own attempt,
 * and read it back the way the screen does: a Director and the Manager read the same figures the
 * imprest screen is sent, and a Cashier, a Sales Representative and an anonymous caller read
 * nothing. The section's private reader is on no Data API surface for any key.
 *
 * The fund is shared with every other integration file, so this file opens one of its own below the
 * triggers, as the e2e specs do, and leaves a plain one behind.
 */

type Result = { ok: boolean; reason: string; [key: string]: unknown };
type Row = { id: string; version: number };
type Position = {
  posted_balance_tzs: number;
  set_aside_tzs: number;
  free_to_approve_tzs: number;
  awaiting_verification_tzs: number;
};

let director: Fixture;
let manager: Fixture;
let cashier: Fixture;
let salesRep: Fixture;
let written: ScheduledReportResult;
const today = businessDate();

async function rpc(who: Fixture, fn: string, args: Record<string, unknown>): Promise<Result> {
  const { data, error } = await who.api.rpc(fn, { ...args, p_idempotency_key: randomUUID() });
  if (error) throw new Error(`${fn}: ${error.message}`);
  const result = data as Result;
  if (!result.ok) throw new Error(`${fn}: ${result.reason}`);
  return result;
}

function freshFund(): void {
  runSql(`
    set session_replication_role = replica;
    update public.imprest_funds set is_active = false, retired_at = now() where is_active;
    insert into public.imprest_funds (opened_by) values ('${manager.userId}');
    set session_replication_role = origin;`);
}

async function postFunding(amount: number): Promise<void> {
  const requested = await rpc(manager, "staff_request_imprest_funding", {
    p_amount_tzs: amount,
    p_reason: "Report float",
  });
  const r = requested.funding as Row;
  const approved = await rpc(director, "admin_decide_imprest_funding", {
    p_funding_id: r.id,
    p_expected_version: r.version,
    p_approve: true,
    p_amount_tzs: amount,
    p_reason: null,
  });
  const a = approved.funding as Row;
  const provided = await rpc(director, "admin_record_imprest_provided", {
    p_funding_id: a.id,
    p_expected_version: a.version,
    p_amount_tzs: amount,
  });
  const p = provided.funding as Row & { handover_id: string };
  await rpc(manager, "staff_confirm_imprest_received", {
    p_funding_id: p.id,
    p_expected_version: p.version,
    p_handover_id: p.handover_id,
  });
}

async function handedOut(amount: number): Promise<Row> {
  const proposed = (await rpc(cashier, "staff_propose_imprest_disbursement", {
    p_amount_tzs: amount,
    p_category: "transport_and_delivery",
    p_purpose: "Report trip",
  })).disbursement as Row;
  const approved = (await rpc(manager, "staff_decide_imprest_disbursement", {
    p_id: proposed.id,
    p_expected_version: proposed.version,
    p_approve: true,
    p_reason: null,
  })).disbursement as Row;
  return (await rpc(cashier, "staff_hand_out_imprest_disbursement", {
    p_id: approved.id,
    p_expected_version: approved.version,
    p_recipient: "Juma the driver",
  })).disbursement as Row;
}

async function position(): Promise<Position> {
  const { data, error } = await manager.api.rpc("staff_imprest_spending_position");
  if (error) throw new Error(`position: ${error.message}`);
  return (data as Position[])[0];
}

async function imprestOf(who: Fixture): Promise<Record<string, unknown> | null> {
  const { data, error } = await who.read
    .from("daily_reports")
    .select("content, integrity_ok")
    .eq("run_id", written.run_id!);
  expect(error).toBeNull();
  if (!data || data.length === 0) return null;
  expect(data[0].integrity_ok).toBe(true);
  return (data[0].content as { sections: { imprest: Record<string, unknown> } }).sections.imprest;
}

beforeAll(async () => {
  director = await ensureDirector();
  manager = await createLiveStaff(director, "manager");
  cashier = await createLiveStaff(director, "cashier");
  salesRep = await createLiveStaff(director, "sales_rep");

  freshFund();
  await postFunding(100000);

  // 10,000 out, settled as Used 8,000 and Returned 1,500, verified: an expense of 8,000 and a loss
  // of 500. The Cashier asks for the expense to be 6,000 and a Director approves.
  const trip = await handedOut(10000);
  const settled = (await rpc(cashier, "staff_settle_imprest_disbursement", {
    p_id: trip.id,
    p_expected_version: trip.version,
    p_lines: [
      { amount_tzs: 8000, purpose: "Fare", receipt_id: null, no_receipt_reason: "transport_fare", no_receipt_note: null },
    ],
    p_returned_tzs: 1500,
    p_explanation: "Change lost on the road",
  })).disbursement as Row;
  const { data: s } = await manager.read
    .from("imprest_settlements")
    .select("id")
    .eq("disbursement_id", trip.id)
    .single();
  await rpc(manager, "staff_verify_imprest_disbursement", {
    p_id: trip.id,
    p_expected_version: settled.version,
    p_settlement_id: s!.id,
  });
  const { data: expense } = await manager.read
    .from("imprest_postings")
    .select("id")
    .eq("disbursement_id", trip.id)
    .eq("kind", "expense")
    .eq("entry", "original")
    .single();
  const asked = (await rpc(cashier, "staff_request_imprest_reversal", {
    p_posting_id: expense!.id,
    p_correct_tzs: 6000,
    p_reason: "The receipt says 6,000",
  })).reversal as Row;
  await rpc(director, "admin_decide_imprest_reversal", {
    p_reversal_id: asked.id,
    p_expected_version: asked.version,
    p_approve: true,
    p_reason: null,
  });

  // 5,000 still out, and a count of 300 under expected cash, confirmed by the Manager.
  await handedOut(5000);
  const counted = (await rpc(cashier, "staff_enter_imprest_count", {
    p_business_date: today,
    p_previous_count_id: null,
    p_counted_tzs: 88200,
    p_note: null,
    p_late_reason: null,
  })).count as Row;
  await rpc(manager, "staff_confirm_imprest_count", {
    p_id: counted.id,
    p_expected_version: counted.version,
    p_explanation: "counting_error",
    p_note: null,
  });

  resetScheduledReportDay(today);
  written = generateReportFor(today);
  expect(written.ok, JSON.stringify(written)).toBe(true);
});

afterAll(() => {
  resetScheduledReportDay(today);
  freshFund();
});

describe("the imprest section a Director and the Manager read", () => {
  it("states the count's real outcome, with its figures and reason", async () => {
    const imprest = await imprestOf(director);
    expect(imprest!.reconciliation).toEqual({
      state: "shortage",
      counted_tzs: 88200,
      expected_tzs: 88500,
      variance_tzs: -300,
      variance_reason: "counting_error",
      missing_reason: null,
    });
  });

  it("states the day's expenses with the reversal and replacement, and the loss", async () => {
    const imprest = await imprestOf(director);
    expect(imprest!.approved_expenses).toEqual({
      count: 1,
      amount_tzs: 8000,
      reversed_tzs: 8000,
      replacement_tzs: 6000,
      net_tzs: 6000,
      unexplained_loss_tzs: 500,
    });
  });

  it("states the balance the imprest screen is sent, and expected cash beside it", async () => {
    const imprest = await imprestOf(manager);
    const screen = await position();
    expect(imprest!.position).toEqual({
      as_at: "cutoff",
      posted_tzs: screen.posted_balance_tzs,
      set_aside_tzs: screen.set_aside_tzs,
      available_tzs: screen.free_to_approve_tzs,
      awaiting_verification_tzs: screen.awaiting_verification_tzs,
      expected_cash_tzs: screen.posted_balance_tzs - screen.awaiting_verification_tzs,
    });
    expect(imprest!.position).toMatchObject({ posted_tzs: 93200, expected_cash_tzs: 88200 });
  });

  it("names the fund by its real identity and withholds nothing", async () => {
    const imprest = await imprestOf(manager);
    const { data: fund } = await manager.read.from("imprest_funds").select("id").eq("is_active", true).single();
    expect(imprest!.fund_id).toBe(fund!.id);
    expect(imprest!.unavailable).toBeUndefined();
    expect(JSON.stringify(imprest)).not.toContain("imprest_spending_not_built");
  });

  it("was written by the generator, which recorded its run and correlation identifier", () => {
    const audit = runSql(`
      select a.action || '|' || coalesce(a.actor_role::text, 'system') || '|' || a.entity_type
             || '|' || (a.correlation_id = r.correlation_id)::text || '|' || (a.occurred_at is not null)::text
        from public.audit_events a
        join public.report_snapshots s on s.id = a.entity_id
        join public.report_runs r on r.id = s.run_id
       where r.id = '${written.run_id}'::uuid and a.action = 'scheduled_report_generated';`);
    expect(audit).toBe("scheduled_report_generated|system|report_snapshot|true|true");
  });
});

describe("who is refused it", () => {
  it("hands a Cashier nothing", async () => {
    expect(await imprestOf(cashier)).toBeNull();
  });

  it("hands a Sales Representative nothing", async () => {
    expect(await imprestOf(salesRep)).toBeNull();
  });

  it("hands an anonymous caller nothing", async () => {
    const anonymous = await callApiRpc("report_imprest_section", { p_business_date: today }, PUBLISHABLE_KEY);
    expect(anonymous.status).toBeGreaterThanOrEqual(400);
  });

  it("keeps the section's reader off the Data API for every key and role", async () => {
    for (const who of [director, manager, cashier]) {
      const asUser = await callApiRpc(
        "report_imprest_section",
        { p_business_date: today },
        PUBLISHABLE_KEY,
        who.accessToken,
      );
      expect(asUser.status, who.role).toBeGreaterThanOrEqual(400);
    }
    const asService = await callApiRpc("report_imprest_section", { p_business_date: today }, SECRET_KEY);
    expect(asService.status).toBeGreaterThanOrEqual(400);
  });
});

describe("the read a phone makes", () => {
  it("answers well inside the 2.5 s budget, measured over twenty reads", async () => {
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const started = performance.now();
      await imprestOf(director);
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
    console.log(`report read over HTTP: n=20 p50=${Math.round(samples[9])}ms p95=${Math.round(p95)}ms`);
    expect(p95).toBeLessThan(2500);
  });
});
