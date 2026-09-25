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
    // report, a label added to a released enum and a widened grant. An exact count, so a phase that
    // silently stopped running its counterexamples is a failure rather than a quieter pass.
    expect(out).toContain("a disputed imprest handover's amount rewritten in place");
    expect(out).toContain("a delivered report's content rewritten in place");
    expect(out).toContain("a label added to a released enum");
    expect(out).toContain("a released table's grant widened");
    expect(
      calls.filter((call) => call.args[0]?.includes("counterexample")),
      "the gate's counterexamples never ran",
    ).toHaveLength(21);

    // Issue #55: the v0.2.0 phase reset to the last released migration, built a real report on
    // it, and asserted the disbursement upgrade.
    expect(out).toContain("imprest funding AND a delivered report");
    expect(calls.filter((call) => call.args[0]?.includes("22_mark_v020_boundary"))).toHaveLength(1);
    expect(calls.filter((call) => call.args[0]?.includes("23_build_v020_report"))).toHaveLength(1);
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
