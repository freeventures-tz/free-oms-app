#!/usr/bin/env node
/**
 * Stage 10 Part C · Does migration 22 preserve a real Part B database?
 *
 * Migration 22 carries its own snapshot-and-abort checks. Those protect the hosted apply, and they
 * are also the migration marking its own homework. pgTAP cannot check the claim either: it runs
 * after every migration has already applied, so there is no before-state left to compare against.
 *
 * This harness is the independent witness. It walks the actual boundary:
 *
 *   1. reset the local database to migration 21 — Part B, before Part C exists;
 *   2. capture every product id, name, specification and unit, and write one REAL price row
 *      through `api.admin_set_product_price` against a product the migration will move;
 *   3. apply migration 22 through the ordinary migration mechanism (`supabase migration up`);
 *   4. assert the ids, names, specifications, unit/content mapping and price reference survived;
 *   5. restore the fully migrated local database, pass or fail, so no later suite inherits a
 *      half-migrated one.
 *
 * Step 5 runs in a `finally`. A harness that leaves the database at migration 21 after a failure
 * would turn one red test into a whole red suite, and the cause would look like anything but this.
 *
 * No new dependency: SQL goes through the `psql` already inside the Supabase database container,
 * which exists identically on a developer machine and on a CI runner. The container name is derived
 * from `supabase/config.toml` rather than hard-coded, so it follows the project id.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The last migration BEFORE Part C. Everything up to and including this is Part B's database. */
const PART_B_VERSION = "20260814000300";

// Deliberately NOT under `supabase/tests/`: `supabase test db` globs every .sql in that tree and
// runs it as pgTAP, and these are fixtures and assertions for a different harness with no plan
// to report. Putting them there turned the whole pgTAP job red.
const SQL_DIR = join("supabase", "migration-chain");
const CAPTURE_BEFORE = join(SQL_DIR, "01_capture_before.sql");
const ASSERT_AFTER = join(SQL_DIR, "02_assert_after.sql");

function projectId() {
  const config = readFileSync(join("supabase", "config.toml"), "utf8");
  const match = config.match(/^\s*project_id\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error("supabase/config.toml has no project_id, so the database container cannot be named");
  return match[1];
}

const DB_CONTAINER = `supabase_db_${projectId()}`;

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
  }
  return result.status;
}

/** Runs one SQL file inside the database container. `ON_ERROR_STOP` makes any raise a failure. */
function psqlFile(path) {
  const sql = readFileSync(path, "utf8");
  const result = spawnSync(
    "docker",
    ["exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-f", "-"],
    { input: sql, stdio: ["pipe", "inherit", "inherit"], shell: false },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path} failed`);
}

/**
 * The Supabase CLI, run as the pinned dependency rather than whatever is on the PATH — the same
 * reason CI pins the version.
 *
 * Invoked as `node <the package's own entry script>`, not through `npx`: Node refuses to spawn a
 * Windows `.cmd` shim without a shell, and reaching for `shell: true` to work around that would
 * put every argument back through a command-line parser for no benefit. The package's bin is an
 * ordinary Node script on every platform.
 */
const SUPABASE_CLI = join("node_modules", "supabase", "dist", "supabase.js");

function supabase(args, options) {
  return run(process.execPath, [SUPABASE_CLI, ...args], options);
}

let restored = false;

function restoreFullDatabase() {
  if (restored) return;
  restored = true;
  console.log("\n--- restoring the fully migrated local database ---");
  // Deliberately tolerant: a failure here must not mask the real result above, but it MUST be
  // loud, because a half-migrated database is a trap for the next suite that runs.
  const status = supabase(["db", "reset"], { allowFailure: true });
  if (status !== 0) {
    console.error(
      "\n!! could not restore the local database. Run `npm run db:reset` before any other suite.",
    );
  }
}

try {
  console.log(`--- resetting to migration ${PART_B_VERSION} (Part B, before Part C) ---`);
  supabase(["db", "reset", "--version", PART_B_VERSION]);

  console.log("\n--- capturing the Part B database, and writing one real price row ---");
  psqlFile(CAPTURE_BEFORE);

  console.log("\n--- applying migration 22 the ordinary way ---");
  supabase(["migration", "up", "--local"]);

  console.log("\n--- asserting what survived ---");
  psqlFile(ASSERT_AFTER);

  console.log("\nmigration-chain: PASS");
} finally {
  restoreFullDatabase();
}
