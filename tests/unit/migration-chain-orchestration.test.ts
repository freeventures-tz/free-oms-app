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
function harness(failOn: Array<"proof" | "restore"> = []) {
  const calls: Call[] = [];
  const out: string[] = [];
  const errors: string[] = [];

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
      const priced = calls.some((call) => call.args[0]?.includes("01b_write_price"));
      const empty = "d751713988987e9331980363e24189ce";
      return priced ? `21|1|${empty}|${empty}|[]|[]` : `21|0|${empty}|${empty}|[]|[]`;
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

    // Both fixtures ran: the zero-price database production is in today, and one with a real price.
    expect(out).toContain("no prices at all");
    expect(out).toContain("one real price row");

    // And the database was put back, on the happy path too.
    expect(fullResets(calls)).toHaveLength(1);
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
