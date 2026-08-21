#!/usr/bin/env node
/**
 * Stage 10 Part C · Does migration 22 preserve a real Part B database?
 *
 * Migration 22 carries its own snapshot-and-abort checks. Those protect the hosted apply, and they
 * are also the migration marking its own homework. pgTAP cannot check the claim either: it runs
 * after every migration has already applied, so there is no before-state left to compare against.
 *
 * `supabase migration up` applies EVERYTHING after Part B, not one named file. Today that is
 * migration 22 alone. A 23rd would be measured here too, and would fail loudly rather than quietly:
 * one that changed a product name breaks the before/after comparison, and one that changed the
 * units breaks the fixed counts in 02_assert_after.sql. What that needs is a fresh reading of those
 * expectations, not a bug report.
 *
 * This harness is the independent witness. For each fixture it walks the actual boundary:
 *
 *   1. reset the local database to migration 21 — Part B, before Part C exists;
 *   2. build the fixture: a Director, and in one of the two fixtures a REAL price row written
 *      through `api.admin_set_product_price` against a product the migration will move;
 *   3. run the release gate's own preservation query and keep the answer;
 *   4. apply everything after Part B through the ordinary migration mechanism
 *      (`supabase migration up`), which today is migration 22 and nothing else;
 *   5. run that same query again and require the two answers to be IDENTICAL, character for
 *      character;
 *   6. assert the approved unit-and-content mapping, the active and retired unit counts, and that
 *      no product is left counted in a retired unit;
 *   7. restore the fully migrated local database, pass or fail, so no later suite inherits a
 *      half-migrated one.
 *
 * TWO FIXTURES, because the gate has to work against the database it will actually meet. Production
 * holds zero prices today. A preservation query proved only against a table with rows in it is a
 * query whose empty case nobody has run — and the empty case is exactly where a digest built from
 * an aggregate goes null and then compares equal to nothing, including itself.
 *
 * STEPS 3 AND 5 RUN THE RELEASE FILE ITSELF: `supabase/release-checks/product_preservation.sql`,
 * the same bytes the runbook pastes into the hosted SQL Editor. A harness with its own copy of the
 * query proves its own copy works.
 *
 * STEP 7 IS PART OF THE RESULT, not housekeeping after it. A run that proved the migration and then
 * failed to restore the database leaves a trap for the next suite, so it exits non-zero and prints
 * no PASS. If the proof and the restore both fail, both are reported and neither hides the other.
 *
 * No new dependency: SQL goes through the `psql` already inside the Supabase database container,
 * which exists identically on a developer machine and on a CI runner. The container name is derived
 * from `supabase/config.toml` rather than hard-coded, so it follows the project id.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The last migration BEFORE Part C. Everything up to and including this is Part B's database. */
const PART_B_VERSION = "20260814000300";

// Deliberately NOT under `supabase/tests/`: `supabase test db` globs every .sql in that tree and
// runs it as pgTAP, and these are fixtures and assertions for a different harness with no plan
// to report. Putting them there turned the whole pgTAP job red.
const SQL_DIR = join("supabase", "migration-chain");
const CAPTURE_BEFORE = join(SQL_DIR, "01_capture_before.sql");
const WRITE_PRICE = join(SQL_DIR, "01b_write_price.sql");
const ASSERT_AFTER = join(SQL_DIR, "02_assert_after.sql");
const ASSERT_PRICE_SURVIVED = join(SQL_DIR, "02b_assert_price_survived.sql");

/** The one source of the preservation query. The runbook pastes this same file, unedited. */
const PRESERVATION_QUERY = join("supabase", "release-checks", "product_preservation.sql");

/**
 * The two databases the release gate has to work against.
 *
 * `prices` is the number the query must report for that fixture, so a fixture that quietly acquired
 * a price row fails here rather than passing a comparison it was never meant to make.
 */
const FIXTURES = [
  {
    name: "no prices at all — the shape production is in today",
    setup: [CAPTURE_BEFORE],
    assertions: [ASSERT_AFTER],
    prices: 0,
  },
  {
    name: "one real price row, written through the real command",
    setup: [CAPTURE_BEFORE, WRITE_PRICE],
    assertions: [ASSERT_AFTER, ASSERT_PRICE_SURVIVED],
    prices: 1,
  },
];

function projectId() {
  const config = readFileSync(join("supabase", "config.toml"), "utf8");
  const match = config.match(/^\s*project_id\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error("supabase/config.toml has no project_id, so the database container cannot be named");
  return match[1];
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
  }
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

/** Runs one SQL file inside the database container. `ON_ERROR_STOP` makes any raise a failure. */
function psqlIn(container, path, extraArgs, inheritStdout) {
  const sql = readFileSync(path, "utf8");
  const result = spawnSync(
    "docker",
    [
      "exec", "-i", container,
      "psql", "-U", "postgres", "-d", "postgres", "-X", "-v", "ON_ERROR_STOP=1",
      ...extraArgs,
      "-f", "-",
    ],
    {
      input: sql,
      stdio: ["pipe", inheritStdout ? "inherit" : "pipe", "inherit"],
      shell: false,
      encoding: "utf8",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path} failed`);
  return result.stdout ?? "";
}

/**
 * The preservation query's answer as one line, for an exact comparison.
 *
 * `-t -A` strips the header, the row count and every alignment space, so what comes back is the
 * data and nothing a formatting change could alter. The comparison is on the WHOLE line, digests
 * and full ordered snapshots together: a digest match with a changed snapshot would mean md5 had
 * collided, and a reader can see which row moved without running anything else.
 */
function readPreservation(container, path) {
  const out = psqlIn(container, path, ["-t", "-A"], false).trim();
  if (!out) throw new Error(`${path} returned nothing, so the release gate has nothing to compare`);
  return out;
}

function describePreservation(line) {
  const fields = line.split("|");
  return {
    products: fields[0],
    prices: fields[1],
    productDigest: fields[2],
    priceDigest: fields[3],
  };
}

/**
 * The whole check, with its commands injected.
 *
 * Injected rather than reached for directly, so the orchestration — which failure exits non-zero,
 * which one still prints PASS, whether the restore runs at all — is testable without a database and
 * without breaking a migration to force a red state.
 */
export function runMigrationChainCheck({ supabase, psqlFile, preservation, log, error }) {
  let proofFailure = null;

  try {
    for (const fixture of FIXTURES) {
      log(`\n=== fixture: ${fixture.name} ===`);

      log(`--- resetting to migration ${PART_B_VERSION} (Part B, before Part C) ---`);
      supabase(["db", "reset", "--version", PART_B_VERSION]);

      log("\n--- building the fixture on the Part B database ---");
      for (const file of fixture.setup) psqlFile(file);

      log("\n--- running the release gate's preservation query, before ---");
      const before = preservation(PRESERVATION_QUERY);
      const beforeFields = describePreservation(before);
      log(
        `    ${beforeFields.products} products, ${beforeFields.prices} prices, ` +
          `identity ${beforeFields.productDigest}, prices ${beforeFields.priceDigest}`,
      );

      if (beforeFields.prices !== String(fixture.prices)) {
        throw new Error(
          `the "${fixture.name}" fixture should hold ${fixture.prices} price row(s), and the ` +
            `preservation query reports ${beforeFields.prices}`,
        );
      }

      // A null digest compares equal to nothing, including the value it is meant to match, so a
      // gate reading one would pass every comparison it was ever given. Asserted in the ZERO-price
      // fixture especially: that is where an aggregate over no rows goes null.
      for (const [what, digest] of [
        ["product identity", beforeFields.productDigest],
        ["price reference", beforeFields.priceDigest],
      ]) {
        if (!/^[0-9a-f]{32}$/.test(digest)) {
          throw new Error(
            `the ${what} digest is "${digest}" and not a 32-character md5, so the release gate ` +
              `cannot compare it`,
          );
        }
      }

      log("\n--- applying everything after Part B the ordinary way ---");
      supabase(["migration", "up", "--local"]);

      log("\n--- running the same preservation query, after ---");
      const after = preservation(PRESERVATION_QUERY);

      if (after !== before) {
        const afterFields = describePreservation(after);
        throw new Error(
          "migration 22 did not preserve the catalogue.\n" +
            `  before: ${beforeFields.products} products / ${beforeFields.prices} prices / ` +
            `${beforeFields.productDigest} / ${beforeFields.priceDigest}\n` +
            `  after:  ${afterFields.products} products / ${afterFields.prices} prices / ` +
            `${afterFields.productDigest} / ${afterFields.priceDigest}\n` +
            `  before rows: ${before}\n` +
            `  after rows:  ${after}`,
        );
      }

      log("    identical, character for character");

      log("\n--- asserting the approved mapping, the unit counts and the stranded count ---");
      for (const file of fixture.assertions) psqlFile(file);
    }
  } catch (failure) {
    proofFailure = failure;
  }

  // ALWAYS attempted, and its result is part of the verdict. A half-migrated database is a trap for
  // the next suite that runs, and the cause would look like anything but this.
  let restoreFailure = null;
  log("\n--- restoring the fully migrated local database ---");
  try {
    supabase(["db", "reset"]);
  } catch (failure) {
    restoreFailure = failure;
  }

  if (proofFailure) {
    error(`\n!! migration-chain: FAIL — ${proofFailure.message}`);
  }
  if (restoreFailure) {
    error(
      `\n!! migration-chain: could not restore the local database — ${restoreFailure.message}` +
        "\n   Run `npm run db:reset` before any other suite.",
    );
  }
  if (proofFailure || restoreFailure) return 1;

  log("\nmigration-chain: PASS");
  return 0;
}

const invokedDirectly =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const container = `supabase_db_${projectId()}`;
  process.exit(
    runMigrationChainCheck({
      supabase: (args) => run(process.execPath, [SUPABASE_CLI, ...args]),
      psqlFile: (path) => psqlIn(container, path, [], true),
      preservation: (path) => readPreservation(container, path),
      log: (line) => console.log(line),
      error: (line) => console.error(line),
    }),
  );
}
