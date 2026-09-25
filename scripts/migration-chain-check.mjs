#!/usr/bin/env node
/**
 * Issue #55 adds one more phase, THE v0.2.0 PHASE. It resets to the 41st and last released
 * migration, builds the same sales, money, dispatch, production and imprest funding ground on it,
 * lets the released scheduler write a real report, and applies the imprest disbursement migration.
 * Its preservation query adds the report, the four Cron jobs, and enum labels, column shapes, view
 * bodies and indexes to the released surface. The one released object that migration replaces,
 * the document numbering constraint, is pinned exactly on both sides instead.
 *
 * Issue #51 adds two boundaries to the ones below, and both are about the scheduled report:
 *
 *   THE v0.1.0 PHASE resets to the 39th and last released migration — the database hosted Supabase
 *   holds today — builds sales, money, dispatch, production AND imprest funding on it through the
 *   released commands, and applies the two reporting migrations. Its preservation query compares
 *   every released row, grant, policy, constraint, trigger and function body; its assertions then
 *   run the report against that data.
 *
 *   THE REPORT BOUNDARY resets to the integrated success migration alone, generates a real report
 *   with deliveries, and applies the retry migration. It asks whether that migration can RUN AT ALL
 *   against a database that has already produced a report — issue #19's first backfill was an
 *   UPDATE, and a snapshot refuses every UPDATE — and whether the report is the same afterwards,
 *   down to the tuple.
 *
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
 * AND THE GATE ITSELF IS TESTED, after step 6 and before the restore, which is what the
 * counterexample files are for. "Before and after are identical" is only worth something if the
 * answer can MOVE, and a gate built from counts alone cannot: the PR #28 review renamed one existing
 * customer between two runs of the v0.0.4 query and got a character-for-character identical result.
 * So once the upgrade has been proved, each counterexample makes one change a bad migration could
 * really make — a record rewritten in place, a reversal repointed, a settlement reattributed — and
 * the answer is REQUIRED to change. A counterexample that slips through fails the run, because a
 * gate that cannot say no has never said yes either.
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
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The last migration BEFORE Part C. Everything up to and including this is Part B's database. */
const PART_B_VERSION = "20260814000300";

/** The last RELEASED migration: v0.0.4, and exactly the shape production is in before v0.0.5. */
const V004_VERSION = "20260822001000";

/** Migration 33 alone — the state a hosted apply passes through, and can sit in for a while. */
const MIGRATION_33_VERSION = "20260822001100";

/**
 * The 34th and last RELEASED migration: v0.0.5, and exactly the shape production is in before
 * v0.0.6 applies. The issue #7 pair sits after this and nothing else does.
 */
const V005_VERSION = "20260822001200";

/**
 * The 36th and last migration of v0.0.6. Issue #48's imprest funding pair sits after it, so the
 * v0.0.5 phase stops here: its assertion counts exactly what v0.0.6 brought and nothing later.
 */
const V006_VERSION = "20260823000200";

/** The 39th and last RELEASED migration: v0.1.0, exactly what hosted Supabase holds (issue #51). */
const V010_VERSION = "20260921000300";

/**
 * The integrated success migration alone (issue #51): the state a hosted apply passes through
 * between the two reporting files, and the last database that could hold a report written before
 * the retry machinery existed.
 */
const REPORT_SUCCESS_VERSION = "20260923000100";
/** The 41st and last RELEASED migration: v0.2.0, the scheduled report with its retries. */
const REPORT_RETRY_VERSION = "20260923000200";
/** Issue #55: imprest disbursements, the first migration after v0.2.0. */
const DISBURSEMENT_VERSION = "20260925000100";
// Deliberately NOT under `supabase/tests/`: `supabase test db` globs every .sql in that tree and
// runs it as pgTAP, and these are fixtures and assertions for a different harness with no plan
// to report. Putting them there turned the whole pgTAP job red.
const SQL_DIR = join("supabase", "migration-chain");
const CAPTURE_BEFORE = join(SQL_DIR, "01_capture_before.sql");
const WRITE_PRICE = join(SQL_DIR, "01b_write_price.sql");
const ASSERT_AFTER = join(SQL_DIR, "02_assert_after.sql");
const ASSERT_PRICE_SURVIVED = join(SQL_DIR, "02b_assert_price_survived.sql");
const BUILD_V004 = join(SQL_DIR, "03_build_v004_fixture.sql");
const ASSERT_V005 = join(SQL_DIR, "04_assert_v005.sql");
const ASSERT_MIGRATION_33 = join(SQL_DIR, "05_assert_migration33_boundary.sql");
const BUILD_V005 = join(SQL_DIR, "11_build_v005_fixture.sql");
const ASSERT_V006 = join(SQL_DIR, "12_assert_v006.sql");
const MARK_V010 = join(SQL_DIR, "14_mark_v010_boundary.sql");
const BUILD_V010_FUNDING = join(SQL_DIR, "15_build_v010_funding.sql");
const ASSERT_REPORTING = join(SQL_DIR, "16_assert_reporting_upgrade.sql");
const MARK_V020 = join(SQL_DIR, "22_mark_v020_boundary.sql");
const BUILD_V020_REPORT = join(SQL_DIR, "23_build_v020_report.sql");
const ASSERT_DISBURSEMENTS = join(SQL_DIR, "24_assert_disbursement_upgrade.sql");

/** The success → retry boundary: a database that has already produced a report. */
const REPORT_FIXTURE = join(SQL_DIR, "17_report_fixture.sql");
const REPORT_CAPTURE = join(SQL_DIR, "18_report_capture.sql");
const REPORT_IMMUTABLE = join(SQL_DIR, "19_report_immutable.sql");
const REPORT_AFTER = join(SQL_DIR, "20_report_after.sql");

/**
 * The two databases the retry migration has to be able to arrive at. The empty one is the case a
 * fresh environment meets; the populated one is the case a hosted database that had reported a
 * single night would meet, and it is the one that used to fail.
 */
const REPORT_SCENARIOS = [
  { name: "the success migration with no report yet — a fresh environment", populated: false },
  { name: "the success migration with a real generated report and its deliveries", populated: true },
];
/**
 * The gate's counterexamples: one same-count rewrite, and two broken links.
 *
 * Each one runs LAST, on a database that is reset immediately afterwards, and each asserts for
 * itself that it changed nothing a count could see — so when the harness requires the answer to
 * move, the only thing that could have moved it is the comparison of contents.
 */
const COUNTEREXAMPLE_CUSTOMER = join(SQL_DIR, "06_counterexample_customer_rename.sql");
const COUNTEREXAMPLE_REVERSAL = join(SQL_DIR, "07_counterexample_reversal_linkage.sql");
const COUNTEREXAMPLE_SETTLEMENT = join(SQL_DIR, "08_counterexample_settlement_linkage.sql");
const COUNTEREXAMPLE_PRODUCTION = join(SQL_DIR, "13_counterexample_production_rewrite.sql");
const COUNTEREXAMPLE_FUNDING = join(SQL_DIR, "21_counterexample_funding_history.sql");
const COUNTEREXAMPLE_REPORT = join(SQL_DIR, "25_counterexample_report_content.sql");
const COUNTEREXAMPLE_ENUM = join(SQL_DIR, "26_counterexample_released_enum.sql");
const COUNTEREXAMPLE_GRANT = join(SQL_DIR, "27_counterexample_released_grant.sql");
/**
 * The permitted writes counterexample 4 hides behind, and the rewrite they must not cover for.
 *
 * A migration is allowed to write. It backfills a column, records that it ran, advances a counter,
 * and every one of those moves the preservation answer legitimately. If the gate's baseline were
 * read BEFORE them, any answer that moved afterwards would look like the gate working -- including
 * one that moved only because of the permitted write, while a customer was quietly renamed
 * alongside it.
 */
const COMPATIBILITY_WRITES = join(SQL_DIR, "09_compatibility_writes.sql");
const COUNTEREXAMPLE_MASKED = join(SQL_DIR, "10_counterexample_masked_rename.sql");

/** The one source of each preservation query. The runbook pastes these same files, unedited. */
const PRESERVATION_QUERY = join("supabase", "release-checks", "product_preservation.sql");
const V004_PRESERVATION = join("supabase", "release-checks", "v004_preservation.sql");
const V005_PRESERVATION = join("supabase", "release-checks", "v005_preservation.sql");
const V010_PRESERVATION = join("supabase", "release-checks", "v010_preservation.sql");
const V020_PRESERVATION = join("supabase", "release-checks", "v020_preservation.sql");

/**
 * All 41 released migrations (issue #55). Its first 39 lines are the v0.1.0 manifest unchanged, so
 * this checks everything that one did and the two reporting migrations released since.
 */
const MIGRATION_MANIFEST = join("supabase", "release-checks", "v020_migration_manifest.txt");

/**
 * The two phases of the proof, each with its own starting migration and its own preservation query.
 *
 * PART C answers a question about the catalogue and runs against two databases, because the gate
 * has to work against the one production is actually in — which holds no prices — as well as a full
 * one. Nothing about it changes here.
 *
 * V0.0.5 answers a different question, and it is the one this release adds: production today holds
 * customers, orders, invoices, reservations, money, credit and dispatches, and no check in this
 * repository had ever watched those cross a migration. Its fixture is built by the released
 * commands under real sessions, so what is compared is what the product produces.
 *
 * `prices` is the number the Part C query must report for that fixture, so a fixture that quietly
 * acquired a price row fails here rather than passing a comparison it was never meant to make.
 */
const PHASES = [
  {
    subject: "migration 22",
    what: "the catalogue",
    version: PART_B_VERSION,
    describes: "Part B, before Part C",
    query: PRESERVATION_QUERY,
    fixtures: [
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
    ],
  },
  {
    subject: "migrations 33 and 34",
    what: "the v0.0.4 database",
    version: V004_VERSION,
    // v0.0.5 AND NO FURTHER. This phase asserts that nothing from a later release arrived with
    // it, which only means anything while the later release is held back.
    upTo: V005_VERSION,
    describes: "v0.0.4, before brick production",
    query: V004_PRESERVATION,
    fixtures: [
      {
        name: "customers, orders, invoices, money, credit and a signed dispatch",
        setup: [BUILD_V004],
        assertions: [ASSERT_V005],
        counterexamples: [
          { name: "one existing customer renamed", file: COUNTEREXAMPLE_CUSTOMER },
          { name: "a reversal repointed at another payment", file: COUNTEREXAMPLE_REVERSAL },
          { name: "a settlement attributed to somebody else", file: COUNTEREXAMPLE_SETTLEMENT },
          {
            name: "a customer renamed behind a migration's own permitted writes",
            compatibilityWrites: COMPATIBILITY_WRITES,
            file: COUNTEREXAMPLE_MASKED,
          },
        ],
      },
    ],
  },
  {
    subject: "migrations 35 and 36",
    what: "the v0.0.5 database",
    version: V005_VERSION,
    // v0.0.6 AND NO FURTHER, for the same reason the v0.0.4 phase stops at v0.0.5.
    upTo: V006_VERSION,
    describes: "v0.0.5, before the stock invariant",
    query: V005_PRESERVATION,
    fixtures: [
      {
        // The v0.0.4 fixture's ground PLUS brick production, because that is what v0.0.5 added and
        // what migration 36 re-issues the commands for. Sixteen `api` functions change schema in
        // that migration and eight helpers are created; none of it should move a single row, and
        // this is what says so rather than assuming it.
        name: "sales, money, dispatch AND an approved batch with an inspected lot",
        setup: [BUILD_V005],
        assertions: [ASSERT_V006],
        counterexamples: [
          { name: "one existing customer renamed", file: COUNTEREXAMPLE_CUSTOMER },
          { name: "a reversal repointed at another payment", file: COUNTEREXAMPLE_REVERSAL },
          { name: "a settlement attributed to somebody else", file: COUNTEREXAMPLE_SETTLEMENT },
          {
            name: "what a batch consumed and yielded, rewritten in place",
            file: COUNTEREXAMPLE_PRODUCTION,
          },
        ],
      },
    ],
  },
  {
    subject: "the two reporting migrations",
    what: "the v0.1.0 database",
    version: V010_VERSION,
    // These two are one release unit (v0.2.0), so they are applied together exactly as that
    // release applied them. Anything later is held back: the imprest disbursement migration of
    // issue #55 is a later release and is not what this phase is about.
    upTo: REPORT_RETRY_VERSION,
    describes: "v0.1.0, before the scheduled report",
    query: V010_PRESERVATION,
    fixtures: [
      {
        name: "sales, money, dispatch, production AND imprest funding with every history shape",
        setup: [MARK_V010, BUILD_V005, BUILD_V010_FUNDING],
        assertions: [ASSERT_REPORTING],
        counterexamples: [
          { name: "one existing customer renamed", file: COUNTEREXAMPLE_CUSTOMER },
          { name: "a reversal repointed at another payment", file: COUNTEREXAMPLE_REVERSAL },
          { name: "a settlement attributed to somebody else", file: COUNTEREXAMPLE_SETTLEMENT },
          {
            name: "what a batch consumed and yielded, rewritten in place",
            file: COUNTEREXAMPLE_PRODUCTION,
          },
          {
            name: "a disputed imprest handover's amount rewritten in place",
            file: COUNTEREXAMPLE_FUNDING,
          },
        ],
      },
    ],
  },
  {
    subject: "the imprest disbursement migration",
    what: "the v0.2.0 database",
    version: REPORT_RETRY_VERSION,
    // This release and no further, for the same reason every earlier phase stops at its own.
    upTo: DISBURSEMENT_VERSION,
    describes: "v0.2.0, before imprest spending",
    query: V020_PRESERVATION,
    fixtures: [
      {
        name: "sales, money, dispatch, production, imprest funding AND a delivered report",
        setup: [MARK_V020, BUILD_V005, BUILD_V010_FUNDING, BUILD_V020_REPORT],
        assertions: [ASSERT_DISBURSEMENTS],
        counterexamples: [
          { name: "one existing customer renamed", file: COUNTEREXAMPLE_CUSTOMER },
          { name: "a reversal repointed at another payment", file: COUNTEREXAMPLE_REVERSAL },
          { name: "a settlement attributed to somebody else", file: COUNTEREXAMPLE_SETTLEMENT },
          {
            name: "what a batch consumed and yielded, rewritten in place",
            file: COUNTEREXAMPLE_PRODUCTION,
          },
          {
            name: "a disputed imprest handover's amount rewritten in place",
            file: COUNTEREXAMPLE_FUNDING,
          },
          { name: "a delivered report's content rewritten in place", file: COUNTEREXAMPLE_REPORT },
          { name: "a label added to a released enum", file: COUNTEREXAMPLE_ENUM },
          { name: "a released table's grant widened", file: COUNTEREXAMPLE_GRANT },
        ],
      },
    ],
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
 * Runs one phase's upgrade with the migrations that come AFTER it held back.
 *
 * `supabase migration up` applies everything pending and takes no target version, so once a later
 * release exists in the chain the v0.0.5 phase would apply that too — and its own assertion says
 * "nothing from a later release came with it", which would then be false for an honest reason.
 * Measuring one upgrade means applying one upgrade, so the files past the boundary are moved out
 * of the directory for the duration and put back in a `finally`.
 *
 * A phase with no `upTo` applies everything, which is what the Part C phase has always done and
 * deliberately still does: it is the standing check that a NEW migration has not broken the
 * oldest boundary in the repository.
 */
function withMigrationsUpTo(upTo, run) {
  if (!upTo) return run();

  const dir = join("supabase", "migrations");
  const held = readdirSync(dir)
    .filter((name) => name.endsWith(".sql") && name.slice(0, 14) > upTo)
    .sort();

  const parked = join(dir, "..", ".migration-chain-held");
  if (held.length > 0) mkdirSync(parked, { recursive: true });
  for (const name of held) renameSync(join(dir, name), join(parked, name));

  try {
    return run();
  } finally {
    for (const name of held) renameSync(join(parked, name), join(dir, name));
    if (held.length > 0) rmSync(parked, { recursive: true, force: true });
  }
}

/**
 * The 39 released migrations, byte for byte as v0.1.0 applied them.
 *
 * A released migration is HISTORY. The hosted database has already run those exact bytes, so
 * editing one does not change what production did — it only makes this repository disagree with
 * it, and every future `db reset` would then build a database no deployment has ever been. The
 * correction for a released migration is always a NEW forward migration.
 *
 * Nothing enforced that. This does: the manifest records the sha256 of each released file at
 * `4098067` (v0.1.0), and the run refuses to continue if one has moved.
 *
 * LINE ENDINGS ARE NORMALISED FIRST, and that is not a loophole. `core.autocrlf` is on for Windows
 * checkouts, so the working tree holds CRLF where the repository holds LF, and hashing the file as
 * it sits on disk would fail on one developer machine and pass on another. What the hosted database
 * received is the repository bytes, which is what this compares.
 */
function assertReleasedMigrationsUnchanged({ log }) {
  const manifest = readFileSync(MIGRATION_MANIFEST, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => {
      const [digest, name] = line.trim().split(/\s+/);
      return { digest, name };
    });

  const moved = [];
  for (const { digest, name } of manifest) {
    const path = join("supabase", "migrations", name);
    let actual;
    try {
      actual = createHash("sha256")
        .update(readFileSync(path, "utf8").replace(/\r\n/g, "\n"))
        .digest("hex");
    } catch {
      moved.push(`${name} is missing`);
      continue;
    }
    if (actual !== digest) moved.push(`${name} changed`);
  }

  if (moved.length > 0) {
    throw new Error(
      `released migrations must never be edited: ${moved.join(", ")}. Correct a released ` +
        "migration with a NEW forward migration, never by rewriting history the hosted database " +
        "has already applied.",
    );
  }

  // And nothing may be INSERTED among them either: a new migration sorts after the released ones
  // or it changes the order in which the hosted database would have applied them.
  const onDisk = readdirSync(join("supabase", "migrations")).filter((n) => n.endsWith(".sql")).sort();
  const released = manifest.map((m) => m.name);
  const prefix = onDisk.slice(0, released.length);

  if (prefix.join("|") !== released.join("|")) {
    throw new Error(
      "the released migrations are no longer the first " + released.length + " in the chain: " +
        `found ${prefix.join(", ")}`,
    );
  }

  log(
    `--- ${released.length} released migrations unchanged; ` +
      `${onDisk.length - released.length} new after them ---`,
  );
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
    // Before any database work: the released history this whole harness assumes is intact.
    assertReleasedMigrationsUnchanged({ log });

    for (const phase of PHASES) {
      for (const fixture of phase.fixtures) {
        log(`\n=== ${phase.subject} · fixture: ${fixture.name} ===`);

        log(`--- resetting to migration ${phase.version} (${phase.describes}) ---`);
        supabase(["db", "reset", "--version", phase.version]);

        log("\n--- building the fixture on that database ---");
        for (const file of fixture.setup) psqlFile(file);

        log("\n--- running the release gate's preservation query, before ---");
        const before = preservation(phase.query);
        const beforeFields = describePreservation(before);
        log(
          `    ${beforeFields.products} products, ${beforeFields.prices} prices, ` +
            `identity ${beforeFields.productDigest}, prices ${beforeFields.priceDigest}`,
        );

        if (fixture.prices !== undefined && beforeFields.prices !== String(fixture.prices)) {
          throw new Error(
            `the "${fixture.name}" fixture should hold ${fixture.prices} price row(s), and the ` +
              `preservation query reports ${beforeFields.prices}`,
          );
        }

        // A null digest compares equal to nothing, including the value it is meant to match, so a
        // gate reading one would pass every comparison it was ever given — and in `-t -A` output a
        // null is an EMPTY FIELD, which is why every field is checked rather than two named ones.
        // The zero-price fixture is where an aggregate over no rows goes null.
        const fields = before.split("|");
        const emptyAt = fields.findIndex((field) => field.trim() === "");
        if (emptyAt >= 0) {
          throw new Error(
            `field ${emptyAt + 1} of the preservation query is empty, which is what a null digest ` +
              `looks like — and a null compares equal to nothing, including itself`,
          );
        }
        if (!fields.some((field) => /^[0-9a-f]{32}$/.test(field))) {
          throw new Error(
            "the preservation query returned no md5 digest at all, so the release gate has " +
              "nothing but counts to compare",
          );
        }

        log(
          phase.upTo
            ? "\n--- applying this release only, up to " + phase.upTo + ", the ordinary way ---"
            : "\n--- applying everything after it, the ordinary way ---",
        );
        withMigrationsUpTo(phase.upTo, () => supabase(["migration", "up", "--local"]));

        log("\n--- running the same preservation query, after ---");
        const after = preservation(phase.query);

        if (after !== before) {
          const afterFields = describePreservation(after);
          throw new Error(
            `${phase.subject} did not preserve ${phase.what}.\n` +
              `  before: ${beforeFields.products} products / ${beforeFields.prices} prices / ` +
              `${beforeFields.productDigest} / ${beforeFields.priceDigest}\n` +
              `  after:  ${afterFields.products} products / ${afterFields.prices} prices / ` +
              `${afterFields.productDigest} / ${afterFields.priceDigest}\n` +
              `  before rows: ${before}\n` +
              `  after rows:  ${after}`,
          );
        }

        log("    identical, character for character");

        log("\n--- asserting what the upgrade added, and what it left alone ---");
        for (const file of fixture.assertions) psqlFile(file);

        // THE GATE, TESTED AGAINST ITSELF. Last, because each of these deliberately damages the
        // fixture, and the database is reset immediately after this loop.
        //
        // EVERY COUNTEREXAMPLE IS JUDGED AGAINST A READING TAKEN IMMEDIATELY BEFORE IT, never
        // against one carried from an earlier step. A carried baseline can be moved by something
        // other than the damage: the counterexample before it, or a legitimate write made in
        // between. The harness would then report "the gate saw it" while the change it was actually
        // testing went unnoticed. Read one statement before the damage, and the only thing that can
        // move the answer is the damage.
        //
        // `compatibilityWrites` is the case that makes this concrete: the sort of ordinary,
        // permitted write a migration really does make. It runs FIRST and the baseline is read
        // AFTER it, so its legitimate effect is already in the baseline and cannot stand in for
        // having seen the invisible change that follows it.
        for (const counterexample of fixture.counterexamples ?? []) {
          log(`\n--- counterexample: ${counterexample.name} ---`);
          if (counterexample.compatibilityWrites) {
            log("    first, the permitted writes this counterexample hides behind");
            psqlFile(counterexample.compatibilityWrites);
          }

          const standing = preservation(phase.query);

          psqlFile(counterexample.file);

          const mutated = preservation(phase.query);

          if (mutated === standing) {
            throw new Error(
              `the preservation gate did not notice ${counterexample.name}. The file asserts it ` +
                "changed no count, so the gate is comparing identities without comparing " +
                "contents — which is the finding this check exists to prevent.\n" +
                `  answer: ${mutated}`,
            );
          }

          log("    the gate saw it");
        }
      }
    }

    // THE STATE BETWEEN THE TWO NEW MIGRATIONS, which no other tier can look at: pgTAP runs after
    // every migration has applied, and the phases above measure the two ends of the upgrade rather
    // than the middle of it. A hosted apply sits here for as long as it takes, so this is where a
    // public table without row-level security would actually be exposed.
    log(`\n=== the boundary · migration ${MIGRATION_33_VERSION} alone ===`);
    supabase(["db", "reset", "--version", MIGRATION_33_VERSION]);
    psqlFile(ASSERT_MIGRATION_33);

    // THE SUCCESS → RETRY BOUNDARY (issue #51, from issue #19's harness). A different question from
    // every phase above: not "did the migration preserve the business", but "can the retry
    // migration even RUN against a database that has already produced a report, and is that report
    // the same afterwards?" — and the answer to the first half used to be no.
    for (const scenario of REPORT_SCENARIOS) {
      log(`\n=== report boundary: ${scenario.name} ===`);

      log(`--- resetting to migration ${REPORT_SUCCESS_VERSION} (the success path, before the retries) ---`);
      supabase(["db", "reset", "--version", REPORT_SUCCESS_VERSION]);

      let before = null;

      if (scenario.populated) {
        log("\n--- generating a real report with the success path's own entry point ---");
        psqlFile(REPORT_FIXTURE);

        log("\n--- capturing the report, its digest, its tuple, its integrity and its deliveries ---");
        before = preservation(REPORT_CAPTURE);
        log(`    ${before}`);

        log("\n--- and confirming a snapshot already refuses UPDATE and DELETE ---");
        psqlFile(REPORT_IMMUTABLE);
      }

      log("\n--- applying the retry migration the ordinary way ---");
      supabase(["migration", "up", "--local"]);

      if (scenario.populated) {
        log("\n--- the same capture, after ---");
        const after = preservation(REPORT_CAPTURE);

        if (after !== before) {
          throw new Error(
            "the retry migration did not preserve the existing report.\n" +
              `  before: ${before}\n` +
              `  after:  ${after}\n` +
              "  (fields: content_sha256 | md5(content) | schema_version | integrity_ok | xmin | " +
              "ctid | deliveries | recipients | reports served | runs)",
          );
        }

        log("    identical, character for character");

        log("\n--- and a snapshot still refuses UPDATE and DELETE ---");
        psqlFile(REPORT_IMMUTABLE);
      }

      log("\n--- asserting the backfill, the dropped default and the new key ---");
      psqlFile(REPORT_AFTER);
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
