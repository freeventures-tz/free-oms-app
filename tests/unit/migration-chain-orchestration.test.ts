import { describe, expect, it } from "vitest";

import { runMigrationChainCheck } from "@/scripts/migration-chain-check.mjs";

/**
 * What the migration-chain command REPORTS, as opposed to what it proves.
 *
 * The proof itself needs a database and takes minutes; this is about the three answers the command
 * can give and the one thing that must never happen — a final `PASS` and an exit code of zero after
 * the database was left half-migrated. A run that proves the migration and then fails to restore
 * the database hands the next suite a trap, and the cause looks like anything but this harness.
 *
 * Every failure here is injected through the command runner the script takes as a parameter. No
 * migration is damaged and no product code is broken to make a red state: the seam is the point.
 *
 * The counterexample step is here for the same reason. Whether the SQL really renames a customer
 * needs a database; whether the harness FAILS when the gate's answer does not move is orchestration,
 * and it is the branch that would otherwise be exercised only by a gate that was already broken.
 */

type Call = { command: string; args: string[] };

/**
 * A stand-in for the real command surface.
 *
 * `failOn` names the step that should blow up: `"proof"` fails the partial reset that starts the
 * proof, `"restore"` fails the full reset at the end, and both may be named at once.
 */
function harness(
  failOn: Array<
    | "proof"
    | "restore"
    | "preservation"
    | "v005-preservation"
    | "counterexample-unseen"
    | "masked-rename"
  > = [],
) {
  const calls: Call[] = [];
  const out: string[] = [];
  const errors: string[] = [];
  let reads = 0;

  const supabase = (args: string[]) => {
    calls.push({ command: "supabase", args });
    // The partial reset — `db reset --version <migration 21>` — is the first thing the proof does.
    if (failOn.includes("proof") && args.includes("--version")) {
      throw new Error("supabase db reset --version exited 1");
    }
    // The full reset with no version is the restore at the end.
    if (failOn.includes("restore") && args[0] === "db" && args[1] === "reset" && args.length === 2) {
      throw new Error("supabase db reset exited 1");
    }
  };

  const code = runMigrationChainCheck({
    supabase,
    psqlFile: (path: string) => calls.push({ command: "psql", args: [path] }),
    // Stands in for the psql line the real query returns. Its price count follows whether this
    // fixture ran the price-writing file, because the command checks that each fixture is the
    // database it asked for. Before and after are the same string, which is what a preserved
    // catalogue looks like.
    preservation: () => {
      reads += 1;
      // Recorded IN ORDER with the psql calls, so a test can assert that the baseline for a
      // counterexample was read after its permitted writes and before its damage.
      calls.push({ command: "preservation", args: [] });
      const priced = calls.some((call) => call.args[0]?.includes("01b_write_price"));
      const empty = "d751713988987e9331980363e24189ce";
      // The second read of a fixture is the "after" one. Changing it here stands in for a migration
      // that moved a product or a price, which is the thing the whole harness exists to catch.
      //
      // Reads 1–4 belong to the two Part C fixtures; reads 5 and 6 are the populated v0.0.4
      // fixture this release adds, so read 6 is that phase's "after".
      const moved =
        (failOn.includes("preservation") && reads === 2) ||
        (failOn.includes("v005-preservation") && reads === 6);
      const products = moved ? "20" : "21";

      // From read 7 the answer follows WHICH FILES HAVE RUN rather than how many times it has
      // been read. The harness reads a fresh baseline immediately before every counterexample, so a
      // read-counting stub would move the digest between those two reads by itself and every
      // counterexample would look "seen" no matter what the gate did.
      const applied = (fragment: string) =>
        calls.filter((call) => call.args[0]?.includes(fragment)).length;

      // "counterexample-unseen" stands in for the gate this release exists to replace: a query that
      // compares counts, sees a record rewritten in place, and answers exactly what it answered
      // before. "masked-rename" is narrower and nastier -- a gate that sees the first three and is
      // blind to the fourth, whose damage arrives alongside a permitted write that DOES move the
      // answer. A harness carrying its baseline from before that write passes it.
      const blind = failOn.includes("counterexample-unseen");
      const masked = failOn.includes("masked-rename");

      const seen = blind
        ? 0
        : masked
          ? applied("counterexample") - applied("10_counterexample")
          : applied("counterexample");

      const movements = seen + applied("09_compatibility");

      const digest = moved
        ? "0000000000000000000000000000dead"
        : reads > 6
          ? `000000000000000000000000000000${String(movements).padStart(2, "0")}`
          : empty;

      return priced
        ? `${products}|1|${digest}|${empty}|[]|[]`
        : `${products}|0|${digest}|${empty}|[]|[]`;
    },
    log: (line: string) => out.push(line),
    error: (line: string) => errors.push(line),
  });

  return { code, calls, out: out.join("\n"), errors: errors.join("\n") };
}

const fullResets = (calls: Call[]) =>
  calls.filter(
    (call) =>
      call.command === "supabase" &&
      call.args[0] === "db" &&
      call.args[1] === "reset" &&
      call.args.length === 2,
  );

describe("the migration-chain command's verdict", () => {
  it("passes only when the proof and the restore both succeed", () => {
    const { code, out, errors, calls } = harness();

    expect(code).toBe(0);
    expect(out).toContain("migration-chain: PASS");
    expect(errors).toBe("");

    // Both Part C fixtures ran: the zero-price database production is in today, and one with a
    // real price.
    expect(out).toContain("no prices at all");
    expect(out).toContain("one real price row");

    // …and so did the populated v0.0.4 upgrade this release adds. Two phases, not one.
    expect(out).toContain("customers, orders, invoices, money, credit and a signed dispatch");
    expect(out).toContain("migrations 33 and 34");

    // The state BETWEEN the two new migrations is measured too, by resetting to migration 33
    // exactly. Nothing else in the repository can look at it.
    expect(
      calls.filter(
        (call) => call.command === "supabase" && call.args.includes("20260822001100"),
      ),
      "the migration-33 boundary was never visited",
    ).toHaveLength(1);
    expect(
      calls.filter((call) => call.args[0]?.includes("05_assert_migration33_boundary")),
    ).toHaveLength(1);

    // The gate was tested against itself: changes a bad migration could really make, each one a
    // rewrite no count can see, and the answer moved for every one of them.
    expect(out).toContain("one existing customer renamed");
    expect(out).toContain("a reversal repointed at another payment");
    expect(out).toContain("a settlement attributed to somebody else");
    expect(out).toContain("what a batch consumed and yielded, rewritten in place");
    // TWENTY-ONE: four in the v0.0.4 phase, four in the v0.0.6 phase, five in the v0.1.0 phase
    // issue #51 adds — the v0.0.6 four again, on a v0.1.0 database, plus a rewritten imprest
    // handover — and eight in the v0.2.0 phase issue #55 adds: those five again, a rewritten
    // report, a label added to a released enum and a widened grant. Issue #62's v0.3.3 phase adds
    // nine: those eight again and a rejected disbursement's reason rewritten. Issue #64's v0.4.0
    // phase adds ten: those nine again and a settlement line's purpose rewritten. Issue #65's v0.5.0
    // phase adds eleven: those ten again and a verification reattributed. Issue #68's v0.6.0 phase
    // adds twelve: those eleven again and a send-back's reason rewritten. Issue #69's v0.7.0 phase
    // adds thirteen: those twelve again and a count confirmation's reason rewritten. Issue #70's
    // v0.8.0 phase adds fourteen: those thirteen again and a late count's reason rewritten. Issue
    // #71's v0.9.0 phase adds fifteen: those fourteen again and a raise's reason rewritten. Issue
    // #72's v0.10.0 phase adds sixteen: those fifteen again and a reversal request's reason
    // rewritten. Issue #73's v0.11.0 phase adds seventeen: those sixteen again and a stock receipt's
    // delivery note rewritten. Issue #83's till phase adds nine: eight of those again and a
    // delivery's imprest payment repointed. An exact count, so a phase that silently stopped running its
    // counterexamples is a failure rather than a quieter pass.
    expect(out).toContain("a disputed imprest handover's amount rewritten in place");
    expect(out).toContain("a delivered report's content rewritten in place");
    expect(out).toContain("a label added to a released enum");
    expect(out).toContain("a released table's grant widened");
    expect(out).toContain("a rejected disbursement's reason rewritten in place");
    expect(out).toContain("a settlement line's purpose rewritten in place");
    expect(out).toContain("a verification reattributed to another person");
    expect(out).toContain("a send-back's reason rewritten in place");
    expect(out).toContain("a count confirmation's reason rewritten in place");
    expect(out).toContain("a late count's reason rewritten in place");
    expect(out).toContain("a raise's reason rewritten in place");
    expect(out).toContain("a reversal request's reason rewritten in place");
    expect(out).toContain("a stock receipt's delivery note rewritten in place");
    expect(
      calls.filter((call) => call.args[0]?.includes("counterexample")),
      "the gate's counterexamples never ran",
    ).toHaveLength(147);

    // Issue #83: the till phase reset to the last released migration, built the v0.11.0 ground and
    // a delivery paid from imprest, asserted the till upgrade by counting a released day, and ran
    // nine counterexamples, a repointed receipt link among them.
    expect(out).toContain("AND a delivery paid from imprest");
    expect(out).toContain("a delivery's imprest payment repointed in place");
    expect(calls.filter((call) => call.args[0]?.includes("83a_mark_till_boundary"))).toHaveLength(1);
    expect(calls.filter((call) => call.args[0]?.includes("83b_build_till_ground"))).toHaveLength(1);
    expect(calls.filter((call) => call.args[0]?.includes("83c_assert_till_upgrade"))).toHaveLength(1);

    // Issue #73: the v0.11.0 phase reset to the last released migration, entered deliveries and had
    // a retirement refused, and asserted the link upgrade, linking a delivery to a released payment.
    expect(out).toContain("AND deliveries with a retirement refused");
    expect(calls.filter((call) => call.args[0]?.includes("60_mark_v0110_boundary"))).toHaveLength(1);
    expect(calls.filter((call) => call.args[0]?.includes("61_build_v0110_receipts"))).toHaveLength(2);
    expect(calls.filter((call) => call.args[0]?.includes("62_assert_link_upgrade"))).toHaveLength(1);

    // Issue #72: the v0.10.0 phase reset to the last released migration, approved one reversal and
    // rejected another, and asserted the retirement upgrade, refusing to retire the released fund.
    expect(out).toContain("AND reversals");
    expect(calls.filter((call) => call.args[0]?.includes("56_mark_v0100_boundary"))).toHaveLength(1);
    // Twice: the v0.11.0 phase issue #73 adds reverses the same postings on its own database.
    expect(calls.filter((call) => call.args[0]?.includes("57_build_v0100_reversals"))).toHaveLength(3);
    expect(
      calls.filter((call) => call.args[0]?.includes("58_assert_retirement_upgrade")),
    ).toHaveLength(1);

    // Issue #71: the v0.9.0 phase reset to the last released migration, raised one approval and
    // refused another, and asserted the reversal upgrade, reversing postings verified before it.
    expect(out).toContain("AND raised approvals");
    expect(calls.filter((call) => call.args[0]?.includes("52_mark_v090_boundary"))).toHaveLength(1);
    // Three times: the v0.10.0 and v0.11.0 phases of issues #72 and #73 raise the same approvals on
    // their own databases.
    expect(calls.filter((call) => call.args[0]?.includes("53_build_v090_raises"))).toHaveLength(4);
    expect(
      calls.filter((call) => call.args[0]?.includes("54_assert_reversal_upgrade")),
    ).toHaveLength(1);

    // Issue #70: the v0.8.0 phase reset to the last released migration, counted a missed day late,
    // and asserted the raised approval upgrade, running the new commands on the old payments.
    expect(out).toContain("AND a missed day counted late");
    expect(calls.filter((call) => call.args[0]?.includes("48_mark_v080_boundary"))).toHaveLength(1);
    // Four times: the v0.9.0, v0.10.0 and v0.11.0 phases of issues #71, #72 and #73 count the same
    // missed day late on their own databases.
    expect(calls.filter((call) => call.args[0]?.includes("49_build_v080_late_count"))).toHaveLength(5);
    expect(
      calls.filter((call) => call.args[0]?.includes("50_assert_raised_approval_upgrade")),
    ).toHaveLength(1);

    // Issue #69: the v0.7.0 phase reset to the last released migration, counted a day two days ago,
    // and asserted the Not counted upgrade.
    expect(out).toContain("a settlement sent back AND a day counted");
    expect(calls.filter((call) => call.args[0]?.includes("44_mark_v070_boundary"))).toHaveLength(1);
    // Three times: the v0.8.0 and v0.9.0 phases of issues #70 and #71 count the same day on their
    // own databases.
    expect(calls.filter((call) => call.args[0]?.includes("45_build_v070_counts"))).toHaveLength(6);
    expect(
      calls.filter((call) => call.args[0]?.includes("46_assert_not_counted_upgrade")),
    ).toHaveLength(1);

    // Issue #68: the v0.6.0 phase reset to the last released migration, sent a settlement back, and
    // asserted the daily count upgrade.
    expect(out).toContain("a verification AND a settlement sent back");
    expect(calls.filter((call) => call.args[0]?.includes("40_mark_v060_boundary"))).toHaveLength(1);
    // Four times: the v0.7.0, v0.8.0 and v0.9.0 phases of issues #69, #70 and #71 send the same
    // settlement back on their own databases.
    expect(calls.filter((call) => call.args[0]?.includes("41_build_v060_send_back"))).toHaveLength(7);
    expect(
      calls.filter((call) => call.args[0]?.includes("42_assert_daily_count_upgrade")),
    ).toHaveLength(1);

    // Issue #65: the v0.5.0 phase reset to the last released migration, verified a disbursement
    // with an unexplained loss, and asserted the send-back upgrade.
    expect(out).toContain("one verified with an unexplained loss");
    expect(calls.filter((call) => call.args[0]?.includes("36_mark_v050_boundary"))).toHaveLength(1);
    // Five times: the v0.6.0, v0.7.0, v0.8.0 and v0.9.0 phases of issues #68, #69, #70 and #71 build
    // the same verification.
    expect(calls.filter((call) => call.args[0]?.includes("37_build_v050_verifications"))).toHaveLength(8);
    expect(
      calls.filter((call) => call.args[0]?.includes("38_assert_send_back_upgrade")),
    ).toHaveLength(1);

    // Issue #64: the v0.4.0 phase reset to the last released migration, settled disbursements with
    // and without a remainder, and asserted the verification upgrade.
    expect(out).toContain("settled with and without a remainder");
    expect(calls.filter((call) => call.args[0]?.includes("32_mark_v040_boundary"))).toHaveLength(1);
    // Six times: the v0.5.0, v0.6.0, v0.7.0, v0.8.0 and v0.9.0 phases of issues #65, #68, #69, #70
    // and #71 build the same settlements.
    expect(calls.filter((call) => call.args[0]?.includes("33_build_v040_settlements"))).toHaveLength(9);
    expect(
      calls.filter((call) => call.args[0]?.includes("34_assert_verification_upgrade")),
    ).toHaveLength(1);

    // Issue #62: the v0.3.3 phase reset to the last released migration, built disbursements in
    // every status, and asserted the settlement upgrade.
    expect(out).toContain("AND disbursements in every status");
    expect(calls.filter((call) => call.args[0]?.includes("28_mark_v030_boundary"))).toHaveLength(1);
    // Seven times: the v0.4.0, v0.5.0, v0.6.0, v0.7.0, v0.8.0 and v0.9.0 phases of issues #64, #65,
    // #68, #69, #70 and #71 build the same disbursements.
    expect(calls.filter((call) => call.args[0]?.includes("29_build_v030_disbursements"))).toHaveLength(10);
    expect(
      calls.filter((call) => call.args[0]?.includes("30_assert_settlement_upgrade")),
    ).toHaveLength(1);

    // Issue #55: the v0.2.0 phase reset to the last released migration, built a real report on
    // it, and asserted the disbursement upgrade.
    expect(out).toContain("imprest funding AND a delivered report");
    expect(calls.filter((call) => call.args[0]?.includes("22_mark_v020_boundary"))).toHaveLength(1);
    // Eight times: the v0.3.3, v0.4.0, v0.5.0, v0.6.0, v0.7.0, v0.8.0 and v0.9.0 phases of issues
    // #62, #64, #65, #68, #69, #70 and #71 each build the same real report on their own database.
    expect(calls.filter((call) => call.args[0]?.includes("23_build_v020_report"))).toHaveLength(11);
    expect(
      calls.filter((call) => call.args[0]?.includes("24_assert_disbursement_upgrade")),
    ).toHaveLength(1);

    // Issue #51: the v0.1.0 phase ran on a populated database, and the success → retry boundary
    // ran twice — empty, and with a real report whose capture had to survive the retry migration.
    expect(out).toContain("imprest funding with every history shape");
    expect(
      calls.filter(
        (call) => call.command === "supabase" && call.args.includes("20260923000100"),
      ),
      "the success → retry boundary was not visited in both scenarios",
    ).toHaveLength(2);
    expect(calls.filter((call) => call.args[0]?.includes("17_report_fixture"))).toHaveLength(1);
    expect(calls.filter((call) => call.args[0]?.includes("20_report_after"))).toHaveLength(2);

    // …and they ran AFTER the assertions, on a fixture that is about to be thrown away. Running
    // them earlier would hand the released-command checks a database somebody had corrupted.
    const lastAssertion = calls.findIndex((call) => call.args[0]?.includes("04_assert_v005"));
    const firstCounterexample = calls.findIndex((call) =>
      call.args[0]?.includes("counterexample"),
    );
    expect(lastAssertion).toBeGreaterThan(-1);
    expect(firstCounterexample).toBeGreaterThan(lastAssertion);

    // And the database was put back, on the happy path too.
    expect(fullResets(calls)).toHaveLength(1);
  });

  it("fails when the gate cannot see a change no count would show", () => {
    const { code, out, errors, calls } = harness(["counterexample-unseen"]);

    // The finding this release corrects, as a failing run: the preservation query answered the
    // same thing after a record was rewritten in place. A harness that shrugged at that would be
    // reporting PASS for a gate that has never been able to say no.
    expect(code).toBe(1);
    expect(out).not.toContain("migration-chain: PASS");
    expect(errors).toContain("the preservation gate did not notice");
    expect(errors).toContain("one existing customer renamed");
    expect(errors).toContain("comparing identities without comparing contents");

    // It stops at the first one rather than running the rest against a database it already
    // mistrusts — and the restore still happens.
    expect(calls.filter((call) => call.args[0]?.includes("counterexample"))).toHaveLength(1);
    expect(fullResets(calls)).toHaveLength(1);
  });

  it("reads the gate's answer immediately before each counterexample, not once beforehand", () => {
    const { code, calls } = harness();
    expect(code).toBe(0);

    // The order the harness actually ran things in, reduced to the two kinds of step that matter.
    // Paths are kept whole, because the separator differs by platform and the fragment is enough.
    const sequence = calls
      .filter(
        (call) => call.command === "preservation" || call.args[0]?.includes("migration-chain"),
      )
      .map((call) => (call.command === "preservation" ? "read" : call.args[0]!));

    const at = (fragment: string) => sequence.findIndex((step) => step.includes(fragment));

    const damage = at("10_counterexample_masked_rename");
    const permitted = at("09_compatibility_writes");

    // The permitted writes, THEN the baseline, THEN the damage. A baseline read before the
    // permitted writes would be moved by them, and the harness would credit the gate with seeing
    // damage it had not seen.
    expect(permitted).toBeGreaterThan(-1);
    expect(damage).toBe(permitted + 2);
    expect(sequence[permitted + 1]).toBe("read");
    expect(sequence[damage + 1]).toBe("read");

    // And the same for a counterexample with no permitted writes: a fresh reading sits immediately
    // before it rather than a value carried down from the phase's own "after".
    const first = at("06_counterexample_customer_rename");
    expect(sequence[first - 1]).toBe("read");
    expect(sequence[first + 1]).toBe("read");
  });

  it("fails when a permitted write would otherwise cover for an invisible rename", () => {
    // THE REGRESSION. This gate sees counterexamples 1 to 3 perfectly well and is blind to the
    // fourth -- whose rename arrives alongside a write the migration is entitled to make. The
    // permitted write moves the answer on its own, so a harness that carried its baseline from
    // before it would see the answer move, report "the gate saw it", and pass a gate that cannot
    // see a customer being renamed.
    const { code, out, errors, calls } = harness(["masked-rename"]);

    expect(code).toBe(1);
    expect(out).not.toContain("migration-chain: PASS");
    expect(errors).toContain("the preservation gate did not notice");
    expect(errors).toContain("renamed behind a migration's own permitted writes");

    // It got as far as the fourth, which is the point: the first three were genuinely seen and only
    // the masked one failed. A run that stopped earlier would be testing something else.
    // Four, not eight: the failure is in the FIRST phase's fourth counterexample, so the run
    // stops there and the v0.0.6 phase never starts.
    expect(
      calls.filter((call) => call.args[0]?.includes("counterexample")),
    ).toHaveLength(4);
    expect(calls.some((call) => call.args[0]?.includes("09_compatibility_writes"))).toBe(true);

    // The database is still put back, because a half-damaged fixture left behind is a trap for
    // whatever runs next.
    expect(fullResets(calls)).toHaveLength(1);
  });

  it("fails when the v0.0.4 upgrade loses data, naming that phase rather than Part C", () => {
    const { code, out, errors } = harness(["v005-preservation"]);

    expect(code).toBe(1);
    expect(out).not.toContain("migration-chain: PASS");
    expect(errors).toContain("migrations 33 and 34 did not preserve the v0.0.4 database");
    expect(errors).toContain("after:  20 products");
  });

  it("fails, and prints no PASS, when the restore fails after a good proof", () => {
    const { code, out, errors } = harness(["restore"]);

    // The whole point of the finding: the migration was proved, and the command must still refuse
    // to call the run a success, because the database it left behind is not the one it found.
    expect(code).toBe(1);
    expect(out).not.toContain("migration-chain: PASS");
    expect(errors).toContain("could not restore the local database");
    expect(errors).toContain("npm run db:reset");
  });

  it("fails when the proof fails, and still restores the database", () => {
    const { code, out, errors, calls } = harness(["proof"]);

    expect(code).toBe(1);
    expect(out).not.toContain("migration-chain: PASS");
    expect(errors).toContain("migration-chain: FAIL");

    // A failed proof leaves the database at migration 21. Skipping the restore would turn one red
    // command into a whole red suite afterwards.
    expect(fullResets(calls), "the database was left half-migrated").toHaveLength(1);
  });

  it("fails when the catalogue is not preserved, naming both answers", () => {
    const { code, out, errors } = harness(["preservation"]);

    // The branch the whole harness exists for. A test that only ever feeds it matching answers
    // proves the comparison runs, not that it can say no.
    expect(code).toBe(1);
    expect(out).not.toContain("migration-chain: PASS");
    expect(errors).toContain("did not preserve the catalogue");

    // Both sides quoted, so a reader can see what moved without re-running anything.
    expect(errors).toContain("before: 21 products");
    expect(errors).toContain("after:  20 products");
  });

  it("reports both failures when the proof and the restore both fail", () => {
    const { code, out, errors } = harness(["proof", "restore"]);

    expect(code).toBe(1);
    expect(out).not.toContain("migration-chain: PASS");

    // The original failure is the one worth reading. A restore failure printed on its own would
    // send the reader looking at Docker while the migration is what broke.
    expect(errors).toContain("migration-chain: FAIL");
    expect(errors).toContain("supabase db reset --version exited 1");
    expect(errors).toContain("could not restore the local database");
  });
});
