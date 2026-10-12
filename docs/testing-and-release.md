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
| Current policy in `AGENTS.md` (*Checks*, *Releasing*) | In force | Run lint, types, unit, integration, E2E and build before every PR and after every rebase. Every merge to `main` is a release with a SemVer tag and a changelog entry |
| One CI run per PR update, pushes tested on `main` only | Implemented | Takes effect when the PR that adds it merges. The same four broad suites run as before |
| Development Gate (aggregate check) | Implemented | Reported on every PR and every push to `main`. Not a required check until the Owner configures it (section 9) |
| Release Gate (full candidate run, manual) | Implemented | Can be started by hand on an exact commit. It runs the benchmarks and binds its evidence to the build it tested. It deploys nothing |
| Test selection (`test:select`) | Implemented, **shadow only** | Every plan says what the change would need, and every gate still requires everything |
| Selective enforcement | Proposed | `scripts/testing/manifest.json` `activation.selectiveEnforcement` is `false`. Turning it on is phase 4 (section 9) |
| `develop` branch, development environment | Proposed | Neither exists. Nothing here creates them |
| Controlled production promotion (deploy and migration hold) | Proposed | Vercel and the Supabase integration still follow `main`. See section 7 |
| Restoration exercise | Proposed | Procedure drafted in section 8. Never run |

Until the Owner approves the change in writing, the current local checks remain required. That
includes this repository's own pull requests.

## 2. The commands

All four commands live in `scripts/testing/`, need only Node, and never touch a hosted service.

```text
npm run test:select -- --base <full-sha> --head <full-sha> [--mode shadow|full] [--worktree] [--inventory-rev <sha>] --output <plan.json>
npm run test:select -- --baseline --base <full-sha> --head <full-sha> --output <base-plan.json>
npm run test:plan   -- --plan <plan.json> --tier local|development [--results <dir>] [--benchmarks] [--keep-going] [--dry-run]
npm run test:gate   -- --plan <plan.json> --base-plan <base-plan.json> --results <dir> [--jobs <needs.json>] [--head <sha>]
npm run test:release -- --prepare --output <candidate.json> [--production-base <sha>]
npm run test:release -- --manifest <candidate.json> [--check-only] [--keep-going]
npm run test:release -- --describe-artifact --output <artifact.json>
npm run test:release -- --manifest <candidate.json> --bind --gate-report <file> --artifact <file> --output <final.json>
```

- **`test:select`** writes a plan: the exact base, head, merge base and trees; the changed paths;
  the risk; every selected and excluded test with the reason for each; and the full inventory. It
  performs no database work. `--worktree` adds staged, unstaged and untracked changes and binds the
  plan to their contents. `--inventory-rev` plans in full over another commit's tree without
  checking it out; CI uses it for the approved base's minimum (section 4).
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
   translations, test setup and fixtures, CI, the selector itself, and policy documents.
   `README.md` and `CHANGELOG.md` are the only documentation-only paths.
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

`tests/unit/testing-manifest.test.ts` fails when a committed file has no rule or a test has no
reviewed group, so the map cannot quietly fall behind the code.

## 4. CI and the two gates

`.github/workflows/ci.yml` runs on:

| Event | What runs | Cancelled by |
| --- | --- | --- |
| Pull request opened, updated, reopened or marked ready (drafts included) | All suites on the merge commit, then **Development Gate** | A newer update to the same pull request only |
| Push to `main` (after a merge) | All suites on what landed, then **Development Gate** | Nothing |
| Called by `release-gate.yml` (needs `candidate` and `production_base`, both full commits) | All suites on the exact candidate, then **Release Gate** | Nothing |

Feature-branch pushes no longer start a second run. The four suite jobs and their names are
unchanged: `Lint · Types · Unit · Build`, `Migrations · pgTAP · Advisors`,
`Auth & Data API integration` and `Responsive authentication E2E`.

The gate job runs after every other job, whatever their outcome. It passes only when all of these
hold:

- the plan exists, is unaltered, was made by this checkout's selector and is for this head;
- the planner and all four suite jobs finished with success (failed, cancelled, skipped, timed out
  and absent all refuse, the planner included);
- every required file ran, every E2E spec ran on mobile, tablet and desktop, each suite passed at
  least one test, no test failed, and the runner reported no error outside a test;
- every test the runner **listed** before the run (`vitest list`, `playwright test --list`) in a
  required file appears in the results, so a missing test inside a file is caught, not just a
  missing file;
- every skipped test matches `scripts/testing/known-skips.json` for this gate;
- shards, if any, all arrived and do not overlap;
- the migration chain ran at least 155 counterexamples, and pgTAP ran at least 28 files and 1,926
  assertions (five pgTAP files declare no plan count, so the total is the floor);
- for a Release Gate, the E2E job recorded a clean build of this exact commit.

The minimum coverage comes from the **base** the change merges into, not from the change:
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
request cannot shrink its own gate.

A test that passed only on retry is accepted but listed. A green retry is still a reliability
finding until someone records why the first attempt failed.

No workflow holds a secret, deploys, links a hosted project, applies a hosted migration or tags.
Fork pull requests run with a read-only token and generated local keys.

## 5. Isolation before parallel runs

The suites stay serial (`workers: 1`, `fileParallelism: false`) and each CI job has its own runner
and local stack. Before any bootstrap, reset or fixture, `scripts/testing/target-guard.mjs` parses
each target and refuses anything except this checkout's own stack: a loopback host with no
credentials or path, on the API and database ports that `supabase/config.toml` declares, and the
container its project id names. That replaces the old checks that only looked for "localhost"
somewhere in the URL.

Sharding is not enabled. Before it is, each shard needs its own checkout, build, stack, ports,
Auth accounts, storage and fixture files. Each group must also be shown to pass alone, reordered,
beside other stacks and after a failed retry. See the specification's section 7.

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
values. When the Release Gate passes on it, the run writes `candidate-final.json`: the manifest
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
| 3 Shadow selection | Plans reported beside full runs | At least 20 representative comparisons, no unexplained omission |
| 4 Development gating | `develop`, a development environment, selective enforcement | Owner approves the concrete settings after independent review |
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

- If selection picks the wrong tests while it is in shadow, you need do nothing, because every gate
  already requires everything. After activation, set `activation.selectiveEnforcement` to `false`
  in the manifest. That change forces full coverage by itself.
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
