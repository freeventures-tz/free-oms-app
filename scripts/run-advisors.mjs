/**
 * Runs `supabase/advisors.sql` against the local database and fails the run on any blocking finding.
 *
 * There is no `supabase advisors` command — the CLI offers `db lint` (a plpgsql checker) and
 * `inspect db` (performance statistics), and the hosted Advisors page cannot see a local database.
 * So the rules live in this repository, run on every clean reset, and block CI.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? "supabase_db_free-oms-app";
const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const sql = readFileSync(new URL("../supabase/advisors.sql", import.meta.url), "utf8");

/**
 * Prefer a direct connection; fall back to the container. CI has psql on the runner, and a
 * developer machine may only have it inside Docker.
 */
function run() {
  try {
    return execFileSync("psql", [DB_URL, "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input: sql,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    // ENOENT means psql is not on PATH; anything else means psql ran and the advisors failed.
    if (error.code !== "ENOENT") throw error;
    return execFileSync(
      "docker",
      ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
      { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
  }
}

try {
  process.stdout.write(run());
} catch (error) {
  process.stdout.write(error.stdout ?? "");
  process.stderr.write(error.stderr ?? String(error));
  process.exit(1);
}
