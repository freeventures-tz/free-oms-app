import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { businessDate } from "@/lib/time/business-date";
import { createLiveStaff, ensureDirector, type Fixture } from "@/tests/integration/helpers";
import { runSql } from "@/tests/support/database";

/**
 * Accountability decisions (issue #84), over real HTTP through PostgREST.
 *
 * pgTAP proves every rule inside one rolled-back transaction. These tests commit, so they prove what
 * only real requests can: authority as PostgREST sees it for every role, refusals that stay on the
 * audit trail after the request ends, the deferred checks at COMMIT, the reads the screens make, a
 * lost answer replayed by its key, and two Directors racing to decide one subject.
 *
 * It needs an unexplained loss and a confirmed shortage of today, so like the retirement file it
 * runs last (see `vitest.config.mts`) on a fund of its own, opened below the triggers as the local
 * database's owner. Everything after that is the real commands.
 */

type Result = {
  ok: boolean;
  reason: string;
  disbursement?: { id: string; version: number };
  count?: { id: string; version: number };
  decision?: { id: string; decision: string; nobody_identified: boolean; responsible: { id: string }[] };
  [key: string]: unknown;
};
type Undecided = { subject_type: string; subject_id: string; fund_id: string; amount_tzs: number };

let director: Fixture;
let secondDirector: Fixture;
let manager: Fixture;
let cashier: Fixture;
let salesRep: Fixture;
let fund: string;
let lossId: string;
let shortageId: string;
let disbursementId: string;

const today = businessDate();

async function rpc(who: Fixture, fn: string, args: Record<string, unknown> = {}): Promise<Result> {
  const { data, error } = await who.api.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as Result;
}

const decide = (
  who: Fixture,
  subjectType: string,
  subjectId: string,
  extra: { decision?: string; nobody?: boolean; staff?: string[]; key?: string } = {},
) =>
  who.api.rpc("admin_record_accountability_decision", {
    p_subject_type: subjectType,
    p_subject_id: subjectId,
    p_decision: extra.decision ?? "The driver lost the change and repays it.",
    p_nobody_identified: extra.nobody ?? true,
    p_responsible_staff: extra.staff ?? [],
    p_idempotency_key: extra.key ?? randomUUID(),
  });

async function reason(call: ReturnType<typeof decide>): Promise<string> {
  const { data, error } = await call;
  if (error) return `error:${error.code}`;
  return (data as Result).reason;
}

async function undecided(): Promise<Undecided[]> {
  const queue = (await rpc(director, "admin_accountability_queue")) as unknown as { undecided: Undecided[] };
  return queue.undecided.filter((u) => u.fund_id === fund);
}

const figures = async () => {
  const { data } = await manager.api.rpc("staff_imprest_spending_position");
  return (data as unknown[])[0];
};

beforeAll(async () => {
  director = await ensureDirector();
  secondDirector = await createLiveStaff(director, "director", "Second Accountability Director");
  manager = await createLiveStaff(director, "manager", "Accountability Manager");
  cashier = await createLiveStaff(director, "cashier", "Accountability Cashier");
  salesRep = await createLiveStaff(director, "sales_rep", "Accountability Rep");

  fund = randomUUID();
  runSql(`begin;
    set local session_replication_role = replica;
    update public.imprest_funds set is_active = false, retired_at = now() where is_active;
    insert into public.imprest_funds (id, opened_by) values ('${fund}', '${manager.userId}');
    commit;`);

  const f = async (who: Fixture, fn: string, args: Record<string, unknown>) =>
    (await rpc(who, fn, { ...args, p_idempotency_key: randomUUID() })) as unknown as {
      reason: string;
      funding: { id: string; version: number; handover_id: string };
    };
  const requested = await f(manager, "staff_request_imprest_funding", { p_amount_tzs: 50000, p_reason: "Float" });
  const approved = await f(director, "admin_decide_imprest_funding", {
    p_funding_id: requested.funding.id,
    p_expected_version: requested.funding.version,
    p_approve: true,
    p_amount_tzs: 50000,
    p_reason: null,
  });
  const provided = await f(secondDirector, "admin_record_imprest_provided", {
    p_funding_id: approved.funding.id,
    p_expected_version: approved.funding.version,
    p_amount_tzs: 50000,
  });
  await f(manager, "staff_confirm_imprest_received", {
    p_funding_id: provided.funding.id,
    p_expected_version: provided.funding.version,
    p_handover_id: provided.funding.handover_id,
  });

  // A trip of 10,000 settled as Used 8,000 and Returned 1,500: a 500 unexplained loss.
  const made = await rpc(cashier, "staff_propose_imprest_disbursement", {
    p_amount_tzs: 10000,
    p_category: "transport_and_delivery",
    p_purpose: "Trip allowance",
    p_idempotency_key: randomUUID(),
  });
  disbursementId = made.disbursement!.id;
  const ok = await rpc(manager, "staff_decide_imprest_disbursement", {
    p_id: disbursementId,
    p_expected_version: made.disbursement!.version,
    p_approve: true,
    p_reason: null,
    p_idempotency_key: randomUUID(),
  });
  const out = await rpc(cashier, "staff_hand_out_imprest_disbursement", {
    p_id: disbursementId,
    p_expected_version: ok.disbursement!.version,
    p_recipient: "Juma the driver",
    p_idempotency_key: randomUUID(),
  });
  const settled = await rpc(cashier, "staff_settle_imprest_disbursement", {
    p_id: disbursementId,
    p_expected_version: out.disbursement!.version,
    p_lines: [{ amount_tzs: 8000, purpose: "Fare", receipt_id: null, no_receipt_reason: "transport_fare", no_receipt_note: null }],
    p_returned_tzs: 1500,
    p_explanation: "Change lost on the road",
    p_idempotency_key: randomUUID(),
  });
  const { data: s } = await manager.read.from("imprest_settlements").select("id").eq("disbursement_id", disbursementId).single();
  const verified = await rpc(manager, "staff_verify_imprest_disbursement", {
    p_id: disbursementId,
    p_expected_version: settled.disbursement!.version,
    p_settlement_id: s!.id,
    p_idempotency_key: randomUUID(),
  });
  expect(verified.reason).toBe("verified");
  const { data: loss } = await manager.read
    .from("imprest_postings")
    .select("id")
    .eq("disbursement_id", disbursementId)
    .eq("kind", "unexplained_loss")
    .single();
  lossId = loss!.id;

  // Today's count, short, confirmed.
  const entered = await rpc(cashier, "staff_enter_imprest_count", {
    p_business_date: today,
    p_previous_count_id: null,
    p_counted_tzs: 1000,
    p_note: null,
    p_late_reason: null,
    p_idempotency_key: randomUUID(),
  });
  const confirmed = await rpc(manager, "staff_confirm_imprest_count", {
    p_id: entered.count!.id,
    p_expected_version: entered.count!.version,
    p_explanation: "counting_error",
    p_note: null,
    p_idempotency_key: randomUUID(),
  });
  expect(confirmed.reason).toBe("confirmed");
  const { data: shortage } = await manager.read
    .from("imprest_count_postings")
    .select("id")
    .eq("count_id", entered.count!.id)
    .single();
  shortageId = shortage!.id;
});

describe("accountability decisions", () => {
  it("lists both subjects for a Director, and nobody else may read the list", async () => {
    const waiting = await undecided();
    expect(waiting.map((u) => u.subject_type).sort()).toEqual(["imprest_count_shortage", "imprest_unexplained_loss"]);
    expect(waiting.find((u) => u.subject_id === lossId)?.amount_tzs).toBe(500);

    for (const who of [manager, cashier, salesRep]) {
      const { error } = await who.api.rpc("admin_accountability_queue");
      expect(error?.code, who.role).toBe("42501");
    }
  });

  it("refuses the Manager, the Cashier and the Sales Representative, and commits each refusal", async () => {
    for (const who of [manager, cashier, salesRep]) {
      expect(await reason(decide(who, "imprest_unexplained_loss", lossId)), who.role).toBe("director_only");
      const committed = runSql(`select count(*) from public.audit_events
        where action = 'command_refused' and actor_id = '${who.userId}' and actor_role = '${who.role}'
          and entity_type = 'imprest_posting' and entity_id = '${lossId}'
          and source_operation = 'api.admin_record_accountability_decision'
          and correlation_id is not null and after_state ->> 'reason' = 'director_only'`);
      expect(committed.trim(), who.role).toBe("1");
    }
    expect(runSql(`select count(*) from public.accountability_decisions where fund_id = '${fund}'`).trim()).toBe("0");
  });

  it("records a decision that names staff, posts nothing, and closes the subject", async () => {
    const before = await figures();
    const key = randomUUID();
    const recorded = await decide(director, "imprest_unexplained_loss", lossId, {
      decision: "Juma lost the change.\nHe repays it in cash this week.",
      nobody: false,
      staff: [cashier.userId],
      key,
    });
    expect(recorded.error).toBeNull();
    const result = recorded.data as Result;
    expect(result.reason).toBe("recorded");
    expect(result.decision?.decision).toBe("Juma lost the change.\nHe repays it in cash this week.");
    expect(result.decision?.responsible.map((r) => r.id)).toEqual([cashier.userId]);

    // The same request under the same key, as after a lost answer.
    expect(
      await reason(
        decide(director, "imprest_unexplained_loss", lossId, {
          decision: "Juma lost the change.\nHe repays it in cash this week.",
          nobody: false,
          staff: [cashier.userId],
          key,
        }),
      ),
    ).toBe("replayed");

    expect(await figures()).toEqual(before);
    expect((await undecided()).map((u) => u.subject_id)).toEqual([shortageId]);

    const audited = runSql(`select count(*) from public.audit_events e
        join public.accountability_decisions a on a.id = e.entity_id
       where e.action = 'accountability_decision_recorded' and a.imprest_posting_id = '${lossId}'
         and e.actor_id = '${director.userId}' and e.actor_role = 'director'
         and e.correlation_id = a.correlation_id`);
    expect(audited.trim()).toBe("1");

    // The payment's own page reads it as decided; a Cashier is shown no accountability record.
    const { data: asManager } = await manager.read
      .from("imprest_postings")
      .select("id, accountability_decisions(decided_at)")
      .eq("id", lossId)
      .single();
    expect((asManager as { accountability_decisions: unknown }).accountability_decisions).not.toBeNull();
    const { data: asCashier } = await cashier.read.from("accountability_decisions").select("id");
    expect(asCashier).toEqual([]);
  });

  it("gives a subject one decision when two Directors race for it", async () => {
    const answers = await Promise.all([
      reason(decide(director, "imprest_count_shortage", shortageId, { decision: "Nobody could explain it." })),
      reason(decide(secondDirector, "imprest_count_shortage", shortageId, { decision: "Counting slip." })),
    ]);
    expect(answers.sort()).toEqual(["already_decided", "recorded"]);
    expect(
      runSql(`select count(*) from public.accountability_decisions where imprest_count_posting_id = '${shortageId}'`).trim(),
    ).toBe("1");
    expect(await undecided()).toEqual([]);
  });

  it("refuses an empty decision and an unanswered question of who is responsible", async () => {
    expect(await reason(decide(director, "imprest_unexplained_loss", lossId, { decision: "  " }))).toBe(
      "decision_required",
    );
    expect(await reason(decide(director, "imprest_unexplained_loss", lossId, { decision: "\n\t \r\n" }))).toBe(
      "decision_required",
    );
    const { data } = await director.api.rpc("admin_record_accountability_decision", {
      p_subject_type: "imprest_unexplained_loss",
      p_subject_id: lossId,
      p_decision: "Somebody",
      p_nobody_identified: false,
      p_responsible_staff: [],
      p_idempotency_key: randomUUID(),
    });
    expect((data as Result).reason).toBe("responsible_required");
  });
});
