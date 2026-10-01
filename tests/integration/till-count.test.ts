import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { businessDate } from "@/lib/time/business-date";
import { runSql } from "@/tests/support/database";
import { SECRET_KEY, callApiRpc, createLiveStaff, ensureDirector, type Fixture } from "@/tests/integration/helpers";

/**
 * The till count (issue #83), over real HTTP through PostgREST.
 *
 * pgTAP proves every rule inside one rolled-back transaction, and moves its business clock to prove
 * all five states. These tests commit, so the deferred checks run at COMMIT, and they prove what
 * only real requests can: each role as PostgREST sees it, a leaked secret key, two Cashiers
 * submitting the same day at once, two Managers deciding one count at once, what a Cashier's own
 * session can read, and that every committed refusal is on the audit trail.
 *
 * A business day takes one confirmed till count, and the integration files share one database and
 * one day. So this file is one day, in order. No other file enters a till count.
 */

const METHODS = ["cash", "mixx_by_yas", "halopesa", "mwanga_hakika_transfer", "crdb_transfer", "cheque"] as const;
type Figures = Record<(typeof METHODS)[number], number>;
type Count = {
  id: string;
  attempt: number;
  version: number;
  status: string;
  counted_by: string;
  lines: { line: string; expected_tzs: number; counted_tzs: number; variance_tzs: number }[];
};
type Result = { ok: boolean; reason: string; count?: Count };

let director: Fixture;
let manager: Fixture;
let secondManager: Fixture;
let cashier: Fixture;
let secondCashier: Fixture;
let salesRep: Fixture;

const today = businessDate();

async function rpc(who: Fixture, fn: string, args: Record<string, unknown>): Promise<Result> {
  const { data, error } = await who.api.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as Result;
}

const enter = (who: Fixture, counted: unknown, previous: string | null = null, key = randomUUID()) =>
  rpc(who, "staff_enter_till_count", {
    p_business_date: today,
    p_previous_count_id: previous,
    p_counted: counted,
    p_note: null,
    p_late_reason: null,
    p_idempotency_key: key,
  });

const confirm = (who: Fixture, c: Count, explanation: string | null, note: string | null = null) =>
  rpc(who, "staff_confirm_till_count", {
    p_id: c.id,
    p_expected_version: c.version,
    p_explanation: explanation,
    p_note: note,
    p_idempotency_key: randomUUID(),
  });

const sendBack = (who: Fixture, c: Count, reason = "Count the Halopesa messages again") =>
  rpc(who, "staff_send_back_till_count", {
    p_id: c.id,
    p_expected_version: c.version,
    p_reason: reason,
    p_idempotency_key: randomUUID(),
  });

/** What the till should hold now, as the Manager reads it. */
async function expectedNow(): Promise<Figures> {
  const { data, error } = await manager.api.rpc("staff_till_expected", { p_business_date: today });
  if (error) throw new Error(`expected: ${error.message}`);
  return Object.fromEntries((data as { line: string; expected_tzs: number }[]).map((r) => [r.line, Number(r.expected_tzs)])) as Figures;
}

async function audit(entityId: string | null, action: string) {
  let query = director.read
    .from("audit_events")
    .select("actor_id, actor_role, action, source_operation, after_state, correlation_id, occurred_at")
    .eq("entity_type", "reconciliation")
    .eq("action", action);
  query = entityId === null ? query.is("entity_id", null) : query.eq("entity_id", entityId);
  const { data, error } = await query;
  if (error) throw new Error(`audit: ${error.message}`);
  return data ?? [];
}

beforeAll(async () => {
  director = await ensureDirector();
  manager = await createLiveStaff(director, "manager", "Till Manager");
  secondManager = await createLiveStaff(director, "manager", "Second Till Manager");
  cashier = await createLiveStaff(director, "cashier", "Till Cashier");
  secondCashier = await createLiveStaff(director, "cashier", "Second Till Cashier");
  salesRep = await createLiveStaff(director, "sales_rep", "Till Rep");

  // Today's takings, so there is something to count: one invoice paid by cash and Halopesa.
  runSql(`
    do $$
    declare c uuid := gen_random_uuid(); o uuid := gen_random_uuid(); i uuid := gen_random_uuid();
            d date := (now() at time zone 'Africa/Dar_es_Salaam')::date;
    begin
      insert into public.customers (id, name) values (c, 'Till Integration Customer');
      insert into public.orders (id, order_no, customer_id, status, is_cash_sale, created_by, created_role,
                                 created_at, confirmed_at)
      values (o, 'ORD-TILL-INT', c, 'confirmed', false, '${salesRep.userId}', 'sales_rep', now(), now());
      insert into public.invoices (id, invoice_no, order_id, customer_id, subtotal_tzs, discount_tzs,
                                   total_tzs, business_date, issued_at)
      values (i, 'INV-TILL-INT', o, c, 1000000, 0, 1000000, d, now());
      insert into public.payments (invoice_id, amount_tzs, method, received_by, received_role,
                                   business_date, correlation_id)
      values (i, 120000, 'cash', '${cashier.userId}', 'cashier', d, gen_random_uuid()),
             (i, 45000, 'halopesa', '${cashier.userId}', 'cashier', d, gen_random_uuid());
    end $$;
  `);
});

describe("one business day of the till, over HTTP", () => {
  let expected: Figures;
  let winner: Fixture;
  let loser: Fixture;
  let winnerKey: string;
  let first: Count;
  let second: Count;

  it("refuses a count from anybody but a live Cashier, and from the secret key", async () => {
    for (const who of [director, manager, salesRep]) {
      const { error } = await who.api.rpc("staff_enter_till_count", {
        p_business_date: today,
        p_previous_count_id: null,
        p_counted: {},
        p_note: null,
        p_late_reason: null,
        p_idempotency_key: randomUUID(),
      });
      expect(error?.message, who.role).toMatch(/may not perform this command/);
    }

    const response = await callApiRpc(
      "staff_enter_till_count",
      { p_business_date: today, p_previous_count_id: null, p_counted: {}, p_note: null, p_late_reason: null, p_idempotency_key: randomUUID() },
      SECRET_KEY,
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("shows expected figures to Directors and the Manager, and never to the Cashier before counting", async () => {
    expected = await expectedNow();
    expect(expected.cash).toBeGreaterThanOrEqual(120000);
    expect(expected.halopesa).toBeGreaterThanOrEqual(45000);

    const { error } = await cashier.api.rpc("staff_till_expected", { p_business_date: today });
    expect(error?.message).toMatch(/may not perform this command/);
    const { error: repError } = await salesRep.api.rpc("staff_till_days", { p_limit: 10, p_offset: 0 });
    expect(repError?.message).toMatch(/may not perform this command/);
    const { data: directorRead } = await director.api.rpc("staff_till_expected", { p_business_date: today });
    expect(directorRead).toHaveLength(6);
  });

  it("refuses a count that does not give every method a whole figure, and audits the refusal", async () => {
    const result = await enter(cashier, { cash: 1000 });
    expect(result).toMatchObject({ ok: false, reason: "amount_invalid" });
    const refusals = await audit(null, "command_refused");
    expect(
      refusals.some(
        (r) =>
          r.actor_id === cashier.userId &&
          r.actor_role === "cashier" &&
          r.source_operation === "api.staff_enter_till_count" &&
          (r.after_state as { reason: string }).reason === "amount_invalid" &&
          r.correlation_id,
      ),
    ).toBe(true);
  });

  it("lets one of two Cashiers submitting at once stand, and refuses the other", async () => {
    const figures = { ...expected, halopesa: expected.halopesa - 5000 };
    const keys = [randomUUID(), randomUUID()];
    const [a, b] = await Promise.all([enter(cashier, figures, null, keys[0]), enter(secondCashier, figures, null, keys[1])]);
    const reasons = [a.reason, b.reason].sort();
    expect(reasons).toEqual(["count_awaiting_confirmation", "counted"]);
    [winner, loser] = a.reason === "counted" ? [cashier, secondCashier] : [secondCashier, cashier];
    winnerKey = a.reason === "counted" ? keys[0] : keys[1];
    first = (a.reason === "counted" ? a : b).count!;
    expect(first.attempt).toBe(1);
    expect(first.lines.find((l) => l.line === "halopesa")).toMatchObject({
      expected_tzs: expected.halopesa,
      counted_tzs: expected.halopesa - 5000,
      variance_tzs: -5000,
    });

    const { data: all } = await director.api.rpc("staff_till_counts", { p_limit: 10, p_offset: 0 });
    expect(all).toHaveLength(1);
  });

  it("replays a lost answer with the same key, and makes no second count", async () => {
    const replay = await enter(winner, { ...expected, halopesa: expected.halopesa - 5000 }, null, winnerKey);
    expect(replay.reason).toBe("replayed");
    expect(replay.count!.id).toBe(first.id);
    const conflict = await enter(winner, { ...expected }, null, winnerKey);
    expect(conflict.reason).toBe("idempotency_key_conflict");
    const { data: all } = await manager.api.rpc("staff_till_counts", { p_limit: 10, p_offset: 0 });
    expect(all).toHaveLength(1);
  });

  it("shows a Cashier only the counts they entered, through the read and through the tables", async () => {
    const { data: mine } = await winner.api.rpc("staff_till_counts", { p_limit: 10, p_offset: 0 });
    expect(mine).toHaveLength(1);
    const { data: theirs } = await loser.api.rpc("staff_till_counts", { p_limit: 10, p_offset: 0 });
    expect(theirs).toEqual([]);
    for (const table of ["reconciliations", "reconciliation_lines"]) {
      const { data } = await loser.read.from(table).select("*");
      expect(data, table).toEqual([]);
      const { data: own } = await winner.read.from(table).select("*");
      expect((own ?? []).length, table).toBeGreaterThan(0);
    }
    const { data: rep } = await salesRep.read.from("reconciliation_lines").select("*");
    expect(rep).toEqual([]);

    // Both read where the day stands, with no figures.
    const { data: days } = await loser.api.rpc("staff_till_days", { p_limit: 1, p_offset: 0 });
    expect((days as { state: string }[])[0].state).toBe("awaiting_confirmation");
  });

  it("refuses every direct write, whoever holds the session", async () => {
    for (const who of [winner, manager, director]) {
      const insert = await who.read
        .from("reconciliation_lines")
        .insert({ reconciliation_id: first.id, line: "cash", expected_tzs: 0, counted_tzs: 0 });
      expect(insert.error, who.role).not.toBeNull();
      const update = await who.read.from("reconciliations").update({ status: "confirmed" }).eq("id", first.id).select();
      expect(update.data ?? [], who.role).toEqual([]);
    }
  });

  it("refuses a decision from a Director or a Cashier, and lets the Manager send the count back", async () => {
    for (const who of [director, winner]) {
      const { error } = await who.api.rpc("staff_send_back_till_count", {
        p_id: first.id,
        p_expected_version: first.version,
        p_reason: "Count again",
        p_idempotency_key: randomUUID(),
      });
      expect(error?.message, who.role).toMatch(/may not perform this command/);
    }
    const result = await sendBack(manager, first);
    expect(result.reason).toBe("sent_back");
    const [row] = await audit(first.id, "till_count_sent_back");
    expect(row).toMatchObject({ actor_id: manager.userId, actor_role: "manager", source_operation: "api.staff_send_back_till_count" });
  });

  it("takes the other Cashier's recount as a new record, and keeps the first", async () => {
    const result = await enter(loser, { ...expected, halopesa: expected.halopesa - 5000 }, first.id);
    expect(result.reason).toBe("counted");
    second = result.count!;
    expect(second.attempt).toBe(2);

    const { data: mine } = await loser.api.rpc("staff_till_counts", { p_limit: 10, p_offset: 0 });
    expect((mine as { attempt: number }[]).map((c) => c.attempt)).toEqual([2]);
    const { data: all } = await director.api.rpc("staff_till_counts", { p_limit: 10, p_offset: 0 });
    expect((all as { status: string }[]).map((c) => c.status)).toEqual(["awaiting_confirmation", "sent_back"]);
  });

  it("lets a confirmation or a send-back win when two Managers race, never both", async () => {
    const [a, b] = await Promise.all([
      confirm(manager, second, "change_not_returned"),
      sendBack(secondManager, second),
    ]);
    const wins = [a, b].filter((r) => r.ok);
    expect(wins).toHaveLength(1);
    const lost = [a, b].find((r) => !r.ok)!;
    expect(["stale", "not_awaiting_confirmation"]).toContain(lost.reason);

    if (wins[0].reason === "sent_back") {
      // The send-back won: count once more and confirm, so the day still closes.
      const third = (await enter(loser, { ...expected, halopesa: expected.halopesa - 5000 }, second.id)).count!;
      expect((await confirm(manager, third, "change_not_returned")).reason).toBe("confirmed");
    }

    const { data: days } = await director.api.rpc("staff_till_days", { p_limit: 1, p_offset: 0 });
    expect((days as { state: string }[])[0].state).toBe("shortage");
    const { data: confirmed } = await director.read.from("reconciliation_confirmations").select("outcome, short_tzs, explanation");
    expect(confirmed).toEqual([{ outcome: "shortage", short_tzs: 5000, explanation: "change_not_returned" }]);
  });

  it("refuses any further count of a confirmed day, and audits every committed command", async () => {
    const again = await enter(cashier, { ...expected }, null);
    expect(again.reason).not.toBe("counted");

    const { data: rows } = await director.read
      .from("audit_events")
      .select("actor_id, actor_role, action, source_operation, correlation_id, occurred_at, entity_id")
      .eq("entity_type", "reconciliation");
    const committed = (rows ?? []).filter((r) => r.action !== "command_refused");
    expect(committed.length).toBeGreaterThanOrEqual(4);
    for (const r of rows ?? []) {
      expect(r.actor_id).toBeTruthy();
      expect(r.actor_role).toBeTruthy();
      expect(r.source_operation).toMatch(/^api\.staff_.*till_count$/);
      expect(r.correlation_id).toBeTruthy();
      expect(r.occurred_at).toBeTruthy();
    }
  });
});
