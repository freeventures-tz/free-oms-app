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
 */

type Call = { command: string; args: string[] };

/**
 * A stand-in for the real command surface.
 *
 * `failOn` names the step that should blow up: `"proof"` fails the partial reset that starts the
 * proof, `"restore"` fails the full reset at the end, and both may be named at once.
 */
function harness(
  failOn: Array<"proof" | "restore" | "preservation" | "v005-preservation"> = [],
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
      const digest = moved ? "0000000000000000000000000000dead" : empty;
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

    // And the database was put back, on the happy path too.
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
