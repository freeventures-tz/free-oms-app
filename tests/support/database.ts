import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Running SQL against the LOCAL database from a test, as the database's own superuser.
 *
 * This is not a back door into the application. Nothing here is reachable from the application, the
 * Data API or the browser: it is a test standing where an operator with a psql prompt stands, and
 * it exists because two things this slice must prove cannot be proved from any other position.
 *
 *   1. FIRING THE 00:01 JOB. `private.run_scheduled_report()` takes only its slot ordinal, lives in a
 *      schema the Data API does not expose, and is granted to one database role. A test cannot
 *      reach it over HTTP — which is the feature working. What a test can do is what Supabase Cron
 *      does.
 *
 *   2. BREAKING A READ FOR REAL. The failed-read half of the feedback contract (design.md §12.7
 *      rule 7) is a failure BETWEEN THE NEXT SERVER AND POSTGRES. Aborting the browser's own
 *      request proves something else entirely — the router's transport fallback — and a fault
 *      injected through application code would be a production back door kept alive by a test.
 *      Taking the grant away for a moment is the real failure, in the real place, and it is
 *      deterministic: the read is refused every time until the grant comes back.
 *
 * The SQL goes through the `psql` already inside the Supabase database container, which is the same
 * route `scripts/migration-chain-check.mjs` takes and adds no dependency to the project. The
 * container name is derived from `supabase/config.toml` rather than hard-coded, so it follows the
 * project id.
 */
export function databaseContainerName(): string {
  const config = readFileSync(join(process.cwd(), "supabase", "config.toml"), "utf8");
  const match = config.match(/^\s*project_id\s*=\s*"([^"]+)"/m);
  if (!match) {
    throw new Error("supabase/config.toml has no project_id, so the database container cannot be named");
  }
  return `supabase_db_${match[1]}`;
}

/** One statement, run to completion, with its trimmed output. Throws on any SQL error. */
export function runSql(sql: string): string {
  const result = spawnSync(
    "docker",
    [
      "exec", "-i", databaseContainerName(),
      "psql", "-U", "postgres", "-d", "postgres", "-X", "-t", "-A",
      "-v", "ON_ERROR_STOP=1",
      "-c", sql,
    ],
    { stdio: ["ignore", "pipe", "pipe"], shell: false, encoding: "utf8" },
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`SQL failed: ${sql}\n${result.stderr ?? ""}`);
  }

  return (result.stdout ?? "").trim();
}
