import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { businessDate } from "@/lib/time/business-date";
import { createLiveStaff, ensureDirector, type Fixture } from "@/tests/integration/helpers";
import { runSql } from "@/tests/support/database";

/**
 * Retirement (issue #72), over real HTTP through PostgREST.
 *
 * pgTAP proves every rule inside one rolled-back transaction. These tests commit, so they prove what
 * only real requests can: the deferred checks at COMMIT (the next fund named before it opens, the
 * balance carried exactly once), authority as PostgREST sees it, a lost answer replayed by its key,
 * and the races that matter: two Directors approving one retirement, and an approval racing a new
 * payment, which must never land in the retired fund.
 *
 * A retirement needs a fund with nothing open and a count of today taken after the last posting.
 * The integration files share one database and leave the shared fund with payments open and today
 * counted, so this file runs last (see `vitest.config.mts`) and starts each scenario on a fund of its
 * own, opened below the triggers as the local database's owner. Everything after that is the real
 * commands.
 */

type Result = {
  ok: boolean;
  reason: string;
  disbursement?: { id: string; version: number; disbursement_no: string };
  count?: { id: string; version: number };
  retirement?: { id: string; version: number; status: string; next_fund_id: string | null };
  blockers?: { kind: string; number: string }[];
  [key: string]: unknown;
};
type Position = {
  fund_id: string;
  posted_funding_tzs: number | null;
  posted_balance_tzs: number | null;
  free_to_approve_tzs: number;
};

let director: Fixture;
let secondDirector: Fixture;
let manager: Fixture;
let cashier: Fixture;
let salesRep: Fixture;

const today = businessDate();

async function rpc(who: Fixture, fn: string, args: Record<string, unknown>): Promise<Result> {
  const { data, error } = await who.api.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as Result;
}

async function position(who: Fixture): Promise<Position> {
  const { data, error } = await who.api.rpc("staff_imprest_spending_position");
  if (error) throw new Error(`position: ${error.message}`);
  return (data as Position[])[0];
}

/** Closes whatever fund is active and opens an empty one, below the triggers. Local stack only. */
function freshFund(): string {
  const id = randomUUID();
  runSql(`begin;
    set local session_replication_role = replica;
    update public.imprest_funds set is_active = false, retired_at = now() where is_active;
    insert into public.imprest_funds (id, opened_by) values ('${id}', '${manager.userId}');
    commit;`);
  return id;
}

async function postFunding(amount: number): Promise<void> {
  const f = async (who: Fixture, fn: string, args: Record<string, unknown>) =>
    (await rpc(who, fn, { ...args, p_idempotency_key: randomUUID() })) as unknown as {
      reason: string;
      funding: { id: string; version: number; handover_id: string };
    };
  const requested = await f(manager, "staff_request_imprest_funding", { p_amount_tzs: amount, p_reason: "Retirement float" });
  const approved = await f(director, "admin_decide_imprest_funding", {
    p_funding_id: requested.funding.id,
    p_expected_version: requested.funding.version,
    p_approve: true,
    p_amount_tzs: amount,
    p_reason: null,
  });
  const provided = await f(director, "admin_record_imprest_provided", {
    p_funding_id: approved.funding.id,
    p_expected_version: approved.funding.version,
    p_amount_tzs: amount,
  });
  const received = await f(manager, "staff_confirm_imprest_received", {
    p_funding_id: provided.funding.id,
    p_expected_version: provided.funding.version,
    p_handover_id: provided.funding.handover_id,
  });
  if (received.reason !== "received") throw new Error(`funding not received: ${received.reason}`);
}

async function propose(amount: number): Promise<Result> {
  return rpc(cashier, "staff_propose_imprest_disbursement", {
    p_amount_tzs: amount,
    p_category: "transport_and_delivery",
    p_purpose: "Trip allowance",
    p_idempotency_key: randomUUID(),
  });
}

/** A payment settled as Used `used` with the rest Returned, and verified. */
async function verifiedPayment(amount: number, used: number): Promise<void> {
  const made = await propose(amount);
  const approved = await rpc(manager, "staff_decide_imprest_disbursement", {
    p_id: made.disbursement!.id,
    p_expected_version: made.disbursement!.version,
    p_approve: true,
    p_reason: null,
    p_idempotency_key: randomUUID(),
  });
  const out = await rpc(cashier, "staff_hand_out_imprest_disbursement", {
    p_id: approved.disbursement!.id,
    p_expected_version: approved.disbursement!.version,
    p_recipient: "Juma the driver",
    p_idempotency_key: randomUUID(),
  });
  const settled = await rpc(cashier, "staff_settle_imprest_disbursement", {
    p_id: out.disbursement!.id,
    p_expected_version: out.disbursement!.version,
    p_lines: [{ amount_tzs: used, purpose: "Fare", receipt_id: null, no_receipt_reason: "transport_fare", no_receipt_note: null }],
    p_returned_tzs: amount - used,
    p_explanation: null,
    p_idempotency_key: randomUUID(),
  });
  const settlementId = runSql(
    `select id from public.imprest_settlements where disbursement_id = '${settled.disbursement!.id}' order by cycle desc limit 1`,
  );
  const done = await rpc(manager, "staff_verify_imprest_disbursement", {
    p_id: settled.disbursement!.id,
    p_expected_version: settled.disbursement!.version,
    p_settlement_id: settlementId,
    p_idempotency_key: randomUUID(),
  });
  if (done.reason !== "verified") throw new Error(`not verified: ${done.reason}`);
}

/** Today's count of `counted`, confirmed as it stands. Returns its id. */
async function confirmedCount(counted: number): Promise<string> {
  const entered = await rpc(cashier, "staff_enter_imprest_count", {
    p_business_date: today,
    p_previous_count_id: null,
    p_counted_tzs: counted,
    p_note: null,
    p_late_reason: null,
    p_idempotency_key: randomUUID(),
  });
  if (entered.reason !== "counted") throw new Error(`not counted: ${entered.reason}`);
  const confirmed = await rpc(manager, "staff_confirm_imprest_count", {
    p_id: entered.count!.id,
    p_expected_version: entered.count!.version,
    p_explanation: null,
    p_note: null,
    p_idempotency_key: randomUUID(),
  });
  if (confirmed.reason !== "confirmed") throw new Error(`not confirmed: ${confirmed.reason}`);
  return entered.count!.id;
}

const submit = (countId: string | null, key = randomUUID()) =>
  rpc(manager, "staff_submit_imprest_retirement", { p_count_id: countId, p_reason: "Month end", p_idempotency_key: key });

const approve = (who: Fixture, id: string, version: number, key = randomUUID()) =>
  rpc(who, "admin_decide_imprest_retirement", {
    p_retirement_id: id,
    p_expected_version: version,
    p_approve: true,
    p_reason: null,
    p_idempotency_key: key,
  });

beforeAll(async () => {
  director = await ensureDirector();
  secondDirector = await createLiveStaff(director, "director", "Second Retirement Director");
  manager = await createLiveStaff(director, "manager", "Retirement Manager");
  cashier = await createLiveStaff(director, "cashier", "Retirement Cashier");
  salesRep = await createLiveStaff(director, "sales_rep");
});

describe("submitting a retirement", () => {
  it("is the Manager's alone, and a refusal names each blocker and is committed", async () => {
    const fund = freshFund();
    await postFunding(100000);
    const open = await propose(10000);

    for (const who of [director, cashier, salesRep]) {
      const { error } = await who.api.rpc("staff_submit_imprest_retirement", {
        p_count_id: null,
        p_reason: "Month end",
        p_idempotency_key: randomUUID(),
      });
      expect(error?.message, who.role).toMatch(/may not perform this command|not a live/i);
    }

    const refused = await submit(null);
    expect(refused.reason).toBe("blocked");
    expect(refused.blockers).toEqual([
      expect.objectContaining({ kind: "disbursement", number: open.disbursement!.disbursement_no }),
    ]);
    expect(
      runSql(`select count(*) from public.audit_events
               where action = 'command_refused' and entity_type = 'imprest_fund' and entity_id = '${fund}'
                 and source_operation = 'api.staff_submit_imprest_retirement'
                 and actor_id = '${manager.userId}' and actor_role = 'manager'
                 and after_state ->> 'reason' = 'blocked' and correlation_id is not null`),
    ).toBe("1");

    // Once the payment is withdrawn only the count is missing.
    await rpc(cashier, "staff_withdraw_imprest_disbursement", {
      p_id: open.disbursement!.id,
      p_expected_version: open.disbursement!.version,
      p_reason: "Not needed",
      p_idempotency_key: randomUUID(),
    });
    expect((await submit(null)).reason).toBe("count_required");
  });

  it("refuses a count taken before the last posting", async () => {
    freshFund();
    await postFunding(50000);
    const countId = await confirmedCount(50000);
    // Funding received after the count: the tin now holds more than it did when counted.
    await postFunding(10000);
    const refused = await submit(countId);
    expect(refused.reason).toBe("count_before_last_posting");
    expect(refused.business_date).toBe(today);
  });
});

describe("approving a retirement", () => {
  it("closes the fund, carries its balance once, and is decided by one Director only", async () => {
    const fund = freshFund();
    await postFunding(80000);
    await verifiedPayment(30000, 25000);
    const countId = await confirmedCount(55000);

    const key = randomUUID();
    const submitted = await submit(countId, key);
    expect(submitted.reason).toBe("submitted");
    // A lost answer, asked again with the same key, is the same submission.
    const replayed = await submit(countId, key);
    expect(replayed.reason).toBe("replayed");
    expect(replayed.retirement!.id).toBe(submitted.retirement!.id);

    const { data: state } = await director.api.rpc("staff_imprest_fund_state");
    expect(state.retirement).toMatchObject({ id: submitted.retirement!.id, closing_balance_tzs: 55000 });

    // Two Directors approve at once: one wins, the other is told it has moved on.
    const answers = await Promise.all([
      approve(director, submitted.retirement!.id, 1),
      approve(secondDirector, submitted.retirement!.id, 1),
    ]);
    expect(answers.map((a) => a.reason).sort()).toEqual(["approved", "stale"]);
    const won = answers.find((a) => a.reason === "approved")!;

    const next = won.retirement!.next_fund_id!;
    expect(runSql(`select is_active::text || ',' || (retired_at is not null)::text from public.imprest_funds where id = '${fund}'`)).toBe(
      "false,true",
    );
    expect(runSql(`select count(*) from public.imprest_fund_openings where from_fund_id = '${fund}'`)).toBe("1");
    expect(runSql(`select amount_tzs from public.imprest_fund_openings where fund_id = '${next}'`)).toBe("55000");

    const now = await position(manager);
    expect(now).toMatchObject({ fund_id: next, posted_funding_tzs: 0, posted_balance_tzs: 55000, free_to_approve_tzs: 55000 });
    // The Cashier sees what may be spent, never the posted figures.
    expect(await position(cashier)).toMatchObject({ posted_balance_tzs: null, free_to_approve_tzs: 55000 });
    const { data: cashierState } = await cashier.api.rpc("staff_imprest_fund_state");
    expect(cashierState).toEqual({ fund_id: next, counting_starts_on: expect.any(String) });

    // The carried balance, the list of retired funds and the fund's record, as the Manager reads them.
    const { data: managerState } = await manager.api.rpc("staff_imprest_fund_state");
    expect(managerState.opening).toMatchObject({ amount_tzs: 55000, from_fund_id: fund });
    const { data: retired } = await manager.api.rpc("staff_imprest_retired_funds", { p_limit: 100, p_offset: 0 });
    expect((retired as { fund_id: string; closing_balance_tzs: number }[]).find((r) => r.fund_id === fund)).toMatchObject({
      closing_balance_tzs: 55000,
    });
    const { data: record } = await manager.api.rpc("staff_imprest_fund_record", { p_fund_id: fund });
    expect(record.figures).toMatchObject({ posted_funding_tzs: 80000, expenses_tzs: 25000, posted_balance_tzs: 55000 });
    expect(record.carried_into).toMatchObject({ fund_id: next, amount_tzs: 55000 });
    const { error: repError } = await salesRep.api.rpc("staff_imprest_fund_record", { p_fund_id: fund });
    expect(repError).not.toBeNull();

    // A new payment joins the new fund.
    const later = await propose(5000);
    expect(runSql(`select fund_id from public.imprest_disbursements where id = '${later.disbursement!.id}'`)).toBe(next);
    await rpc(cashier, "staff_withdraw_imprest_disbursement", {
      p_id: later.disbursement!.id,
      p_expected_version: later.disbursement!.version,
      p_reason: "Not needed",
      p_idempotency_key: randomUUID(),
    });
  });

  it("racing a new payment, never leaves the payment in the retired fund", async () => {
    for (let round = 0; round < 3; round += 1) {
      const fund = freshFund();
      await postFunding(20000);
      const countId = await confirmedCount(20000);
      const submitted = await submit(countId);
      expect(submitted.reason).toBe("submitted");

      const [decided, proposed] = await Promise.all([approve(director, submitted.retirement!.id, 1), propose(1000)]);
      const landedIn = runSql(`select fund_id from public.imprest_disbursements where id = '${proposed.disbursement!.id}'`);
      const retired = runSql(`select (not is_active)::text from public.imprest_funds where id = '${fund}'`) === "true";

      if (decided.reason === "approved") {
        expect(retired, `round ${round}`).toBe(true);
        expect(landedIn, `round ${round}: the payment joined the retired fund`).toBe(decided.retirement!.next_fund_id);
      } else {
        expect(decided.reason, `round ${round}`).toBe("blocked");
        expect(retired, `round ${round}`).toBe(false);
        expect(landedIn, `round ${round}`).toBe(fund);
      }
      await rpc(cashier, "staff_withdraw_imprest_disbursement", {
        p_id: proposed.disbursement!.id,
        p_expected_version: proposed.disbursement!.version,
        p_reason: "Not needed",
        p_idempotency_key: randomUUID(),
      });
    }
  });
});
