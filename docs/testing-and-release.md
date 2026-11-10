# Testing and release process

This is the one authoritative reference for how Free Ventures OMS is tested and released.
`AGENTS.md` and the workspace documents point here. Issue
[#99](https://github.com/freeventures-tz/free-oms-app/issues/99) introduced it.

## 1. What is in force today

The process changes in stages, and each part below is in one of four states. A proposed part is
described here and not built. An implemented part is built and tested in this repository, but
nothing relies on it yet. An activated part is one the Owner has switched on, and nothing in this
document is activated yet. A released part is in a tagged release.

| Part | State | What it means today |
| --- | --- | --- |
| Policy in `AGENTS.md` (*Checks*, *Releasing*) | In force | Run `npm run check` before every PR and after every rebase. CI runs what the change's lane needs. Every merge to `main` is a release with a SemVer tag and a changelog entry |
| One CI run per PR update, pushes tested on `main` only | Implemented | Takes effect when the PR that adds it merges |
| Lanes: a pull request runs what its change can affect | Implemented | Takes effect when the PR that adds it merges (section 4). `scripts/testing/manifest.json` `activation.selectiveEnforcement` is `true`; setting it to `false` returns every gate to full execution |
| Full run on every push to `main` | Implemented | Every suite runs on what landed, whatever lane the pull request was in, and reports what the lane would have missed |
| Development Gate (aggregate check) | Implemented | Reported on every PR and every push to `main`. Not a required check until the Owner configures it (section 9) |
| Release Gate (full candidate run, manual) | Implemented | Can be started by hand on an exact commit. It runs every suite and the benchmarks and binds its evidence to the build it tested. It deploys nothing, and no merge waits for it |
| `develop` branch, development environment | Proposed | Neither exists. Nothing here creates them |
| Controlled production promotion (deploy and migration hold) | Proposed | Vercel and the Supabase integration still follow `main`. See section 7 |
| Restoration exercise | Proposed | Procedure drafted in section 8. Never run |

The Owner asked for lanes on 10 November 2026: a small change should merge in minutes, and a change
to a critical function should still get every check. The pull request that adds them changes test
infrastructure, so it is itself in the critical lane and runs everything.

## 2. The commands

All of them live in `scripts/testing/`, need only Node, and never touch a hosted service.

```text
npm run check [-- --all] [--base <ref>]
npm run test:select -- --base <full-sha> --head <full-sha> [--mode shadow|full|enforce] [--worktree] [--max-shards <n>] [--inventory-rev <sha>] --output <plan.json>
npm run test:select -- --baseline --base <full-sha> --head <full-sha> --output <base-plan.json>
npm run test:plan   -- --plan <plan.json> --tier local|development [--results <dir>] [--benchmarks] [--keep-going] [--dry-run]
npm run test:gate   -- --plan <plan.json> --base-plan <base-plan.json> --results <dir> [--jobs <needs.json>] [--head <sha>]
npm run test:release -- --prepare --output <candidate.json> [--production-base <sha>]
npm run test:release -- --manifest <candidate.json> [--check-only] [--keep-going]
npm run test:release -- --describe-artifact --output <artifact.json>
npm run test:release -- --manifest <candidate.json> --bind --gate-report <file> --artifact <file> --output <final.json>
```

- **`check`** is what to run before a pull request. It plans the working tree against where the
  branch left `main`, the way CI will plan the pull request, and says which lane the change is in
  and which suites CI will hold it to. Then it runs lint, types, the unit suite and the build, which
  need no database and take a few minutes. `--all` also runs the database-backed suites the plan
  requires, against this checkout's own local stack.
- **`test:select`** writes a plan: the exact base, head, merge base and trees; the changed paths;
  the risk and the lane; every selected and excluded test with the reason for each; what a gate
  will require (`execution`), with a reason for every suite it leaves out; and the full inventory.
  It performs no database work. `--worktree` adds staged, unstaged and untracked changes and binds
  the plan to their contents. `--mode enforce` makes `execution` follow the lane; `shadow` and
  `full` require everything. `--max-shards` says how many parallel E2E jobs the caller can run.
  `--inventory-rev` plans in full over another commit's tree without checking it out; CI uses it
  for the approved base's minimum (section 4).
- **`test:plan`** refuses a plan that is stale, altered, made on another commit, made before the
  working tree changed, or made without `--worktree` while the tree has uncommitted changes (such
  a plan names a commit, so it must run on exactly that commit's files). It then runs the plan's
  commands with explicit paths, listing each suite's tests before running them. `local` runs the
  selection, plus the full pgTAP suite (which holds the mandatory database smoke), database lint
  and advisors every time, and the migration chain when the plan selects it (every high-risk
  change). `development` runs what the gate requires, in CI job order, and finishes with the same
  gate decision CI makes. Each step's time goes to `timing.json`. The first failure stops the run
  unless you pass `--keep-going`, which ends only the failing job and runs the others, as CI's
  independent jobs do. A refused target check always stops everything.
- **`test:gate`** is the decision behind both required checks (section 4).
- **`test:release`** records and checks a release candidate's identity and runs every broad suite
  against it (section 6).

Result files go to `oms-test/` (ignored by git). Setting `OMS_TEST_RESULTS_DIR` makes Vitest and
Playwright write JSON reports there; unset, the runners behave as before.

## 3. How selection decides

The rules are in `scripts/testing/select.mjs`, applied with the reviewed map in
`scripts/testing/manifest.json`. Over-selecting is acceptable. Under-selecting is the failure this
design exists to prevent.

1. Base and head must be full commit names that exist in a non-shallow clone. On a pull request the
   head is GitHub's merge of the branch into its base, so the combination that would land is what
   gets tested.
2. Every changed path, old and new name both, is classified. Paths that force full coverage
   include authentication and permissions, financial and stock commands, money and date helpers,
   migrations and everything under `supabase/`, dependencies, configuration, shared layout and UI,
   test setup and fixtures, CI and the selector itself. Shared interface components, the shared
   shell, layout, styles and translations are *app-wide*: they force every E2E spec, and no other
   suite, because they reach every screen and cannot reach the database. Documentation
   (`README.md`, `CHANGELOG.md`, `AGENTS.md`, `CLAUDE.md`, `docs/**`) forces nothing.
3. Changed test files run. Test files that import a changed file, directly or through other
   files, run. A reviewed domain adds the E2E specs that cover its screens.
4. Mandatory smoke tests always run. pgTAP: authorization, first login and bypass, grants and RLS,
   audit attribution, API bridge and stock invariant. HTTP: authority, API boundaries, recovery,
   stock invariant, lost response and Director concurrency. E2E: authentication, role routing, the
   shell and interaction feedback.
5. Shared-state groups are indivisible. Selecting any file in the imprest fund group selects all
   of it, which keeps funding first and not-counted and retirement last (`vitest.config.mts`). The
   seeded-stock group works the same way. A test in no reviewed group forces its suite to full.
6. pgTAP, database lint and advisors always run in full. The migration chain always runs in CI and
   for release candidates; locally the plan selects it for every high-risk change.
7. Anything uncertain forces full coverage and says why: an unknown or missing base, a shallow
   clone, an unmapped path, a rename or deletion, a stale manifest, an import in non-test source
   that the graph cannot resolve, or an error in the selector. The graph resolves the `@/` alias,
   relative paths, and TypeScript's `.js` to `.ts`/`.tsx` substitution.
8. Risk can only go up. There is no flag to select less than the rules choose, and no cached
   result replaces a run.

### Lanes

In enforce mode the plan's `execution` follows one of five lanes. The lane is read off the rules
above; nobody picks it.

| Lane | The change | What runs |
| --- | --- | --- |
| docs | Documentation only | Static: lint, types, the whole unit suite, the build |
| tests | Test files only | Static, plus the changed E2E specs, plus the whole HTTP suite if one of its files changed |
| screen | One area's screens (a reviewed domain) | Static, that area's E2E specs and the four E2E smoke specs, on all three projects |
| app-wide | Shared interface, shell, layout, styles or wording | Static and every E2E spec |
| critical | Authentication, permissions, server actions, money and stock commands, the database, dependencies, configuration, CI, the tests' own infrastructure, a rename or deletion, and every doubt | Every suite, as before |

Two rules make the smaller lanes safe.

- **The database suites run against the database alone.** pgTAP, the migration chain, database lint
  and advisors read only `supabase/**` and their own scripts, and every one of those paths forces
  the critical lane. So in any other lane those inputs are byte-identical to the base, whose own
  full run on `main` already stands. Running them again would test nothing the change touched.
- **The HTTP suite calls the database's API, never the application.** It runs whole when the
  change reaches one of its files (a changed test, or a test that imports a changed file), and not
  otherwise. Its files share one database and one order, so it is never run in part.

The unit suite always runs whole. It takes under a minute and needs no database.

`tests/unit/testing-manifest.test.ts` fails when a committed file has no rule or a test has no
reviewed group, so the map cannot quietly fall behind the code.

## 4. CI and the two gates

`.github/workflows/ci.yml` runs on:

| Event | What runs | Cancelled by |
| --- | --- | --- |
| Pull request opened, updated, reopened or marked ready (drafts included) | The change's lane, on the merge commit, then **Development Gate** | A newer update to the same pull request only |
| Push to `main` (after a merge) | Every suite on what landed, then **Development Gate** | Nothing |
| Called by `release-gate.yml` (needs `candidate` and `production_base`, both full commits) | Every suite on the exact candidate, then **Release Gate** | Nothing |

Feature-branch pushes no longer start a second run. The four suite jobs and their names are
unchanged: `Lint · Types · Unit · Build`, `Migrations · pgTAP · Advisors`,
`Auth & Data API integration` and `Responsive authentication E2E`.

The planner says which jobs the plan needs, and a job it does not need is skipped. The E2E job runs
as up to four parallel shards, each with its own runner, build, local stack and database. The plan
splits the specs between them by measured minutes (`e2eMinutes` in the manifest), and every spec
runs on all three projects inside its shard, mobile first, as it does in the whole suite. A small
selection stays in one shard, because every shard pays about four minutes for its own setup. A
release candidate always runs in one shard, so one build is the evidence it is bound to.

What that costs, from the last full run on `main` (14 October 2026: E2E 33 minutes in one job, the
database job 16, HTTP 7, static 2):

| Lane | Jobs | Expected wall time |
| --- | --- | --- |
| docs, or unit tests only | static | about 3 minutes |
| screen | static, one E2E shard of a few specs | about 8 to 10 minutes |
| app-wide | static, four E2E shards | about 12 to 15 minutes |
| critical, and every push to `main` | all four, E2E in four shards | about 17 minutes, set by the database job |

Those are estimates until the first runs are measured; before this change every update took about
33 minutes, and ran twice.

A push to `main` runs everything whatever the pull request ran. If a lane missed a regression, that
run finds it, and its gate report names the failing test the lane would have left out. Fix it
forward, and add the missing rule to the manifest. Production deploys from `main` without waiting
for that run (section 7), so the lanes accept this much: a regression in a screen-lane change, in a
spec outside that area and outside the smoke specs, can be live for the length of one run.

The gate job runs after every other job, whatever their outcome. It passes only when all of these
hold:

- the plan exists, is unaltered, was made by this checkout's selector and is for this head;
- the planner and every job the plan requires finished with success (failed, cancelled, skipped,
  timed out and absent all refuse, the planner included). On a lane the gate works the required
  jobs out from the plan's own execution, and a job the plan left out still refuses if it ran and
  did not succeed;
- a plan that leaves a suite out touches none of the database, the dependencies, CI or the tests'
  own infrastructure. The manifest says the same; the gate checks it again itself, so a selector
  or manifest that stopped saying it cannot shrink the run;
- every required file ran, every E2E spec ran on mobile, tablet and desktop, each suite passed at
  least one test, no test failed, and the runner reported no error outside a test;
- every test the runner **listed** before the run (`vitest list`, `playwright test --list`) in a
  required file appears in the results, so a missing test inside a file is caught, not just a
  missing file;
- every skipped test matches `scripts/testing/known-skips.json` for this gate;
- shards, if any, all arrived, do not overlap, and are the shards the plan split the specs into;
- the migration chain ran at least 155 counterexamples, and pgTAP ran at least 28 files and 1,926
  assertions (five pgTAP files declare no plan count, so the total is the floor);
- for a Release Gate, the E2E job recorded a clean build of this exact commit.

For a full run (a push to `main`, a release candidate, and any pull request in the critical lane)
the minimum coverage comes from the **base** the change merges into, not from the change:
`test:select --baseline` runs the base's own selector and manifest over the base's own file tree
(`--inventory-rev`). CI, the release run and the development tier all plan the base this way. Every test
the base has stays required, even one the change deletes, unless the change's manifest retires it
by name in `retiredTests` with a reason. That is a manifest change, so it forces full coverage and
shows up in review. Numeric floors are the higher of the base's and the change's. A base with no
selector, as for this transition, has no manifest, and the change's manifest cannot speak for it.
Its minimum comes from an approved record in `BOOTSTRAP_BASELINES` (`scripts/testing/select.mjs`),
keyed by the base's full commit: the base's tree, which files count as tests (the base's own runner
configuration, not the manifest's globs), how many of each it holds, and its floors. Before the
record is used it is checked against the base's tree: the tree, the test counts, the migration
count and the pgTAP file count must all match, or there is no baseline. A base with neither a
selector nor a record has no baseline either. The base plan is required evidence: a run whose base plan is
missing, altered, made over another tree or short of a suite is refused, and so is a plan or
candidate that names no base. Nothing falls back to the change's own inventory and floors. A pull
request cannot shrink its own gate. A pull request in a smaller lane needs no base plan: it deletes
and renames nothing and changes no test rule, because each of those forces the critical lane.

A test that passed only on retry is accepted but listed. A green retry is still a reliability
finding until someone records why the first attempt failed.

No workflow holds a secret, deploys, links a hosted project, applies a hosted migration or tags.
Fork pull requests run with a read-only token and generated local keys.

## 5. Isolation before parallel runs

Inside a job the suites stay serial (`workers: 1`, `fileParallelism: false`), and each CI job,
E2E shards included, has its own runner and local stack. Before any bootstrap, reset or fixture, `scripts/testing/target-guard.mjs` parses
each target and refuses anything except this checkout's own stack: a loopback host with no
credentials or path, on the API and database ports that `supabase/config.toml` declares, and the
container its project id names. That replaces the old checks that only looked for "localhost"
somewhere in the URL.

E2E shards split by spec file, and each shard has its own checkout, build, stack, ports, Auth
accounts, storage and fixture files, because each is its own runner. Whether a spec can run
without the specs that used to run before it was measured on 10 November 2026: every spec was run
alone, after its own reset, on all three projects (`D:\fv99val\evidence-indep`, kept outside the
repository). The manifest's E2E groups record what that run found. Sharding inside one runner, or
splitting one spec's projects between jobs, is still not enabled and would need its own proof.

## 6. Release candidates

A candidate is an identity. `npm run test:release -- --prepare` records:

- the commit and tree;
- package, both lockfile and changelog versions, which must agree;
- every migration file with its SHA-256 digest, and every released-history manifest;
- digests of the build, Supabase and test configuration and of every workflow;
- Node, Next.js, Supabase CLI, Playwright and Vitest versions, and every pinned action;
- digests of the public `NEXT_PUBLIC_*` build values, never their text, and no secret at all.

`--manifest` refuses a dirty tree or any difference from the recorded identity. It then runs every
broad suite, then every opt-in benchmark, and the Release Gate decision, and checks the identity
again at the end.

The benchmarks count as applicable to every candidate. They never run inside the main suites:
each one takes many samples and leaves the records behind, and the suites share one database. A
local release run that switched them on in the main E2E suite failed 16 ordinary specs that ran
after them. Instead, `scripts/testing/benchmarks.mjs` runs each benchmark file listed in the
manifest's `benchmarks` alone, after its own reset, the way each spec documents
(`FV_BENCHMARK=1`, mobile project only, filtered to the benchmark block). The Release Gate accepts
a benchmark skipped in the main run only when the same test passed in its own pass; a failed or
missing pass refuses it. The runner sets `FV_BENCHMARK=0` on every main step, over any value from
the shell or the `.env` files. Removing the variable would not be enough, because the test setups
load `.env.test.local` and `.env.local` again and dotenv fills in anything unset. Only a benchmark
pass sets `1`, and any gate refuses a main run in which a benchmark test ran rather than skipped. A Development Gate accepts the reviewed opt-in skips, and `test:plan
--benchmarks` adds the same passes to a local run.

Evidence is bound to the build it tested. The E2E step records that build: commit, tree, whether
the tree was clean, a digest of `.next/server` and `.next/static`, and digests of the public build
values. The digest also covers the build id and `.next/prerender-manifest.json`, and leaves out only
the incremental-cache entries of the routes that manifest lists (`.html`, `.rsc`, `.meta`, `.body`,
`.segments/`). `next start` rewrites those after a revalidation, so with them in, the build was a
different artifact once E2E had served it. `test:release` describes the build again after every
step has run and refuses the run if it no longer matches the recorded one. When the Release Gate passes on it, the run writes `candidate-final.json`: the manifest
plus that build and the decision. Run `--check-only` against the final manifest and it refuses any
other build, including a fresh build of the same commit, because Next.js builds differ. An
approval recorded in a manifest stands only while nothing has drifted and only with passing
Release Gate evidence for exactly that commit and build.

To run it on GitHub: **Actions → Release Gate → Run workflow**, with the full candidate commit and
the full commit production runs today. Both are required: the gate holds the candidate to the
production commit's tests and floors, and refuses a run without it. Its last job, *Release candidate evidence*, binds the decision and
the E2E job's build into `candidate-final.json`, and refuses unless the Release Gate passed.

## 7. Production promotion (proposed, not activated)

Today, Vercel deploys `main` to production and the Supabase GitHub integration applies migrations
on merge. A passing Release Gate cannot stop either one, so this process cannot yet promise that
production waits for a verified candidate. Activation needs, in this order and each with the
Owner's separate approval:

1. Read-only confirmation of the real settings: the Vercel production branch, preview deployment
   rules, environment variable scopes and deploy hooks; the Supabase integration's production
   branch, automatic branching and "deploy to production" setting.
2. A hold on automatic production deploys and migrations, tested before anything relies on it.
3. A promotion step that applies the approved migrations in order, verifies preservation and the
   hosted migration list, and only then activates the compatible app build.

Promotion steps, once activated:

1. Freeze a small batch. Set the version, lockfile and changelog **before** testing.
2. Prepare the candidate manifest and run the Release Gate on the exact final commit. If merging
   creates a new commit, test that commit while production stays held.
3. Independent review. The Owner approves the named manifest and named operations.
4. Apply migrations, verify, activate the app, confirm version, routes, logs and business checks.
5. Tag only the promoted commit. Development merges are never tagged.

An app rollback returns to a known compatible build. It does not undo cash, stock, migrations or
Auth and storage changes. Business corrections use forward migrations and Director-approved
reversals, never edits to posted history.

## 8. Restoration (proposed, never run)

Restoring a backup is a disaster-recovery operation: freeze writes, get incident approval, choose
the recovery point, restore, reconcile everything after that point, then reopen. Before it can be
relied on:

- the Owner sets the acceptable data loss (RPO) and outage (RTO) after a measured baseline;
- backup availability, retention and access are confirmed on the real plan (the workspace notes
  say production has no point-in-time recovery; confirm, do not assume);
- Storage objects are backed up separately, because database backups do not contain them, and the
  receipt encryption keys are recoverable;
- a synthetic restore into an isolated project proves balances, posted entries, stock, history,
  roles, first login, receipt decryption and scheduled jobs, and is timed.

Until that exercise passes, every release review records restoration as **unverified**.

## 9. Activation

| Phase | Deliverable | Exit condition |
| --- | --- | --- |
| 0 Baseline | Timings and the skip and flake inventory | Comparable measured runs; production boundaries understood |
| 1 Duplicate runs | This routing, same broad coverage | Routing and refusal tests pass (done in #99); the first PR shows one run per update |
| 2 Isolation | Run and shard target contract; hosted settings proposal | Independent review; authorised isolated dry runs with zero production effect |
| 3 Lanes | Pull requests run their lane; `main` runs everything and reports what the lane would have missed | In force on merge (Owner's direction, 10 November 2026). Every push to `main` is a comparison |
| 4 Development environment | `develop` and a development environment | Owner approves the concrete settings |
| 5 Candidate release | Release Gate, promotion hold, restoration | Exact-candidate evidence and a tested hold and restore |

Settings proposed for the Owner's decision. None of them are applied.

- Branch protection or a ruleset on `main`: require **Development Gate**; require branches to be up
  to date; no bypass for administrators. The four suite checks can stay required alongside it
  during the switch, so there is no gap.
- On activation of `develop`: add `develop` to the push trigger, require **Development Gate** there,
  and require **Release Gate** for `release/*` promotion.
- Vercel: production branch moved off automatic `main` deploys, or an ignored-build step that
  allows production only for an approved candidate; previews scoped to non-production credentials.
- Supabase GitHub integration: "deploy to production" off for `main` until the promotion step
  exists.

## 10. Turning it off

- If a lane picks the wrong tests, the next push to `main` says so. Add the rule the manifest was
  missing. To stop using lanes altogether, set `activation.selectiveEnforcement` to `false` in the
  manifest. Every plan then requires every suite again, and that edit forces full coverage by
  itself.
- If the selector throws, the planner already writes a full plan with the error as its reason.
- If the gate itself misbehaves, remove it from the required checks. The four suite checks remain.
- If isolation fails, stop development deployments and releases. Never fall back to a shared or
  production database.
- If you revert `ci.yml`, the old triggers come back. The revert must not re-enable any automatic
  production deploy or migration that a later phase holds.

## 11. Measuring

Each run records, per exact commit: step and suite durations, retries and their tests, skips, the
selected and excluded counts and the full-fallback reasons. The gate writes this to the job summary
and `gate-report.json`; `test:plan` and `test:release` write `timing.json` and
`release-evidence.json`. Queue time and runner minutes come from the Actions run itself.

Keep the existing performance thresholds as they are. The general CI interaction tolerance is
500 ms, the design intent is about 100 ms, and the opt-in benchmarks hold their own limits. Any
change needs a measured baseline and the Owner's decision. Local HTTP timings say nothing about a
phone on 4G.

The benchmarks run only in a Release Gate, which is started by hand and which no merge waits for.
They take the worst of twenty samples against a 100 ms limit, so one slow frame on a busy machine
fails a pass. Between 16 October and 3 November 2026 the same commit passed and failed the same
benchmark on the same laptop. Read a benchmark failure as a question to look into, and compare
base against head on the same machine before blaming a change.
