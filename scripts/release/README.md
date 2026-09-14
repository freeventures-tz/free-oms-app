# Release controller

This is the release automation from
[issue #36](https://github.com/freeventures-tz/free-oms-app/issues/36). So far it has two parts:

- **Preview** ([#37](https://github.com/freeventures-tz/free-oms-app/issues/37)). It classifies
  pull-request titles and, for one exact accepted merge, previews the next version and the complete
  release notes. It is read-only.
- **Build tags** ([#38](https://github.com/freeventures-tz/free-oms-app/issues/38)). When CI finishes
  on an exact merge to main, it decides whether that commit earns an immutable annotated build tag,
  `vX.Y.Z-dev.N`, and creates the tag once the Owner has activated publication.

**Build-tag publication is off.** Nothing is written unless the repository variable
`RELEASE_BUILD_PUBLICATION` is exactly `enabled`, and this change does not set it. Recovery of missed
build tags, release preparation and normal-release publication belong to later slices of #36. None of
them exists yet.

Issue #36 owns the policy: the compatibility contract, the version table, the accepted-merge rules and
the publication contract. This file covers running the commands and what their tests prove.

## Commands

### `check-pr-title`

```bash
node scripts/release/controller.mjs check-pr-title --title-env PR_TITLE --body-env PR_BODY
```

Classifies a title, plus the PR description that goes with it. `--title` and `--body` take the text
directly for local use. `.github/workflows/release-classification.yml` runs this command when a pull
request is opened, edited, reopened or updated.

### `preview`

```bash
git fetch origin --tags
```

```bash
GITHUB_TOKEN="<read token>" node scripts/release/controller.mjs preview --repo freeventures-tz/free-oms-app --sha <full merge sha>
```

| Option | Meaning |
| --- | --- |
| `--sha` | The exact merge, as a full 40-character sha. It must be on the first-parent line of `--main-ref` |
| `--main-ref` | Default `origin/main`. The preview reads the local clone and never fetches, so fetch first |
| `--proposed-title` | Repeatable. Adds a title that is not in history yet. It is reported apart from the accepted merges, in both formats and even when nothing has merged since the release, and changes only `versionIncludingProposed` |
| `--accept-stable-contract` | A reference to the Owner's stable-contract acceptance. During 0.x it makes the target `1.0.0`. The preview records the reference but does not validate it |
| `--path` | The clone to read. Default: the current directory |
| `--format` | `markdown` (default) or `json` |

Environment variables: `GITHUB_TOKEN` or `GH_TOKEN` supplies the read token.
`GITHUB_API_URL` defaults to `https://api.github.com`; it must use https, except that plain http is
allowed on a loopback address. `GITHUB_SERVER_URL` is used for links. Every command's GitHub client
follows no redirects and refuses a pagination link to any other origin.

### `evaluate-build`

Read-only. Anyone with a read token can run it to see what the build-tag workflow would decide.

```bash
git fetch origin --tags
```

```bash
GITHUB_TOKEN="<read token>" node scripts/release/controller.mjs evaluate-build --repo freeventures-tz/free-oms-app --sha <full merge sha> --run-id <CI run id>
```

| Option | Meaning |
| --- | --- |
| `--sha` | The exact merge, as a full 40-character sha |
| `--run-id` | The CI run whose completion started the evaluation. It must be final-merge CI for `--sha`, or nothing else is read. Without it, every CI run for the sha is read |
| `--repo-id` | When given, every run's repository id must match it |
| `--main-ref`, `--path`, `--format` | As for `preview` |
| `--outputs` | A GitHub Actions outputs file. Appends `decision`, `sha`, `tag`, `state` and `description` |
| `--summary` | A job summary file. Appends the Markdown report |

The JSON it prints is the **plan** the writing jobs receive. The checks run in this order:

1. The checkout's tags are exactly GitHub's. If they differ, it stops with `tag_state_out_of_date`
   (exit 1). Fetch every tag and run it again.
2. The commit is on main's first-parent line.
3. The triggering run is final-merge CI: this repository's `.github/workflows/ci.yml`, a `push` to
   `main`, from this repository, with the commit as its head. A pull-request run, a run of a synthetic
   merge commit, a run on another branch or from a fork, and a run of another workflow are refused
   with `not_final_merge_ci`.
4. The commit's own target is calculated from its own ancestral normal release, as `preview` does. A
   normal release later published at the commit itself does not change it.
5. Final-merge CI is read in full: every run for the commit, every job of every attempt, every page.
6. The build tags that already exist are inspected.

| Decision | Exit | Commit status | Meaning |
| --- | --- | --- | --- |
| `eligible` | 0 | pending | Every gate is satisfied. `tag` is a provisional name; the writer allocates the ordinal again under its lock |
| `already_tagged` | 0 | success | The commit's build tag exists and its provenance matches |
| `not_applicable` | 0 | none | The commit is itself a normal release and has no build tag |
| `pending` | 3 | pending | CI has not finished (`ci_incomplete`, `ci_run_missing`), or a merge awaits an Owner decision |
| `refused` | 4 | failure | The identity, the history or an existing tag cannot be trusted |
| `failed` | 5 | failure | Final-merge CI finished without satisfying a required gate |

### `publish-build`

```bash
node scripts/release/controller.mjs publish-build --repo freeventures-tz/free-oms-app --repo-id <id> --plan build-plan.json
```

This is the only command that can create a tag, and only the tag writer workflow runs it. Do not run
it against this repository with a token that can write. Publication is the Owner's decision.

It reads nothing from a plan it can refuse outright. A plan that is not `evaluate-build` JSON for this
repository is `plan_invalid`, and a plan whose decision is not `eligible` is `plan_not_eligible`. For
any other plan it:

1. Evaluates the commit again, exactly as `evaluate-build` does, from the plan's sha and run id. It
   refuses `plan_drift` if the target, classification, base or notes digest no longer match the plan.
   If the commit is already tagged, it reads the tag back and exits 0 without writing.
2. Stops with exit 6 and writes nothing unless `RELEASE_BUILD_PUBLICATION` is exactly `enabled`. No
   writer client exists before this point.
3. Allocates `vX.Y.Z-dev.N` from the tags as they stand.
4. Creates the annotated tag object, then the reference `refs/tags/<name>`. A reference is only ever
   created, never updated or forced.
5. Reads the reference and the tag object back from GitHub. It reports `tagged` only when the tag
   peels to the commit and carries the expected provenance, run and attempt.

What happens when something goes wrong:

| Situation | Result |
| --- | --- |
| The tag object is created but the reference is not | Exit 1, `tag_reference_unconfirmed`. The unreferenced object is not a publication, and a later evaluation still offers the same name |
| The reference is created but the response or the read-back fails | Exit 1. A retry finds the tag, confirms its provenance and writes nothing (`already_tagged`) |
| GitHub refuses the name because it already exists | The reference is read back. This commit's matching build tag is `already_tagged`. Anything else is `build_tag_name_collision` (exit 4). No other name is tried |

### `write-build-status`

```bash
node scripts/release/controller.mjs write-build-status --repo freeventures-tz/free-oms-app --plan build-plan.json --writer-result success --writer-decision tagged --writer-tag v0.0.7-dev.1
```

Writes one commit status in the `release/build-tag` context, and only when `RELEASE_BUILD_PUBLICATION`
is `enabled` (otherwise exit 6). An eligible plan is reported as success only when the writer job
succeeded, reported `tagged` or `already_tagged`, and named a build tag. Any other writer outcome is a
failure. Other plans are reported as their decision calls for. `--target-url` must be a workflow run of
this repository.

### `runtime-dependencies`

```bash
node scripts/release/controller.mjs runtime-dependencies
```

Prints the `node_modules/` paths the controller needs, resolved from `package-lock.json`. The
evaluation job bundles exactly these, so the writing jobs never install anything.

## Exit status

| Status | Meaning |
| --- | --- |
| 0 | Valid, calculated, eligible, tagged, already tagged, or nothing to do |
| 1 | Git or GitHub failed, or a write was not confirmed. Nothing was guessed |
| 2 | Usage error |
| 3 | Pending: an Owner decision, or final-merge CI that has not finished |
| 4 | Refused: malformed, conflicting, ambiguous or untrustworthy input |
| 5 | A required final-merge CI gate is unsatisfied |
| 6 | Publication is not activated, so nothing was written |

Each refusal, pending decision and failed gate carries a named `code`, plus the commit and pull request
it concerns.

## Titles and footers

- **Types.** `feat` is minor. `fix`, `perf`, `test`, `docs`, `chore`, `ci`, `build`, `refactor` and
  `style` are patch. Any other type is refused, and so is a capitalised one.
- **Breaking.** A breaking change needs both `!` in the title and a line
  `BREAKING CHANGE: <explanation>`. Either one alone is refused.
- **Footer extent.** A `BREAKING CHANGE:` or `DEPRECATED:` explanation may run over several
  paragraphs. It ends at the next footer (`Token: value` or `Token #value`), not at a blank line, and
  every paragraph appears in the explanation, the lines to retain and the notes.
- **Deprecation.** Write a line `DEPRECATED: <what and why>` and use `feat`. The same footer under a
  patch type is refused.
- **Revert.** Choose the type for the contract that results, and name the reverted commit with a line
  `Reverts: <full sha>`. That commit must already be on main before the merge. A `revert:` type,
  GitHub's `Revert "…"` title and a revert with no footer are all refused. The reverted change still
  counts toward its own range's bump, so a version is never under-classified.
- **Refused near-misses.** A lowercase or bulleted `breaking change:`, a `Deprecation:` footer, and
  version overrides such as `Release-As:`, `[minor]` or `+semver:`.

## Merging so the classification survives

Merge bodies in this repository keep only the PR title (`merge_commit_message: PR_TITLE`). So a
`BREAKING CHANGE:`, `DEPRECATED:` or `Reverts:` line written in the PR description is **not** kept,
and the preview refuses the merge. Put those lines in the merge body when merging:

```bash
gh pr merge <number> --repo freeventures-tz/free-oms-app --merge --match-head-commit <head sha> --body "<title>

BREAKING CHANGE: <explanation>"
```

`check-pr-title` prints the lines to carry over. Once a pull request is merged, editing its title,
description or labels changes nothing: classification comes from the merge commit.

## What the preview accepts

An accepted merge meets all of these conditions:

- It is a two-parent commit on main's first-parent line, and its subject is
  `Merge pull request #N from …`.
- GitHub reports pull request N as merged into `main` of this repository at exactly that commit,
  with its head equal to the merge's second parent.
- The body keeps the checked title on its first line.

The following are named as pending decisions and never guessed at: a squash or rebase merge, a
direct push, a local merge, an octopus merge, and a merge GitHub does not associate with its pull
request.

The normal-release base is the nearest annotated `vX.Y.Z` tag on the sha's own first-parent line, so
a later release never changes an earlier merge's calculation. Prerelease tags are ignored. The
preview refuses to choose a base in any of these cases: a lightweight normal tag, a normal tag off
the first-parent line, two normal tags on one commit, or versions that run backwards in history.

## Build tags

### Final-merge CI

The required gates are the four jobs of `ci.yml`, by name: `Lint · Types · Unit · Build`,
`Migrations · pgTAP · Advisors`, `Auth & Data API integration` and `Responsive authentication E2E`. A
run satisfies them when its latest attempt concluded `success` and each job ran in that attempt exactly
once, for this commit and this run, and concluded `success`. The codes for an unsatisfied gate are
`required_gate_failed`, `required_gate_cancelled`, `required_gate_skipped`, `required_gate_missing`,
`required_gate_ambiguous` and `ci_run_not_successful`.

A failed job that passes when the same run is retried satisfies the gate. The failed attempt and the
accepted flaky retry stay on record, in the plan, the job summary and the tag annotation. A passing job
of another commit or run never counts, and there is no option to waive a failure. A failure that looks
like a known fixture defect, such as [issue #34](https://github.com/freeventures-tz/free-oms-app/issues/34),
still fails the gate until a retry of the same run passes.

### Names and ordinals

`X.Y.Z` is the version the commit's own range calculates from its own ancestral normal release. `N` is
one more than the highest ordinal among the build tags for that target when the writer allocates. So
`N` records allocation order, and a late retry can hold a higher `N` than a later merge. Git records
merge order. If a feature raises the target, earlier build tags keep their names and a new ordinal
sequence starts. The target commit is always the evaluated sha, however far main has moved. A build
tag never writes a version into `package.json`, `package-lock.json` or the changelog.

### Provenance

The annotation begins `Build <tag> of <repository>` and carries these fields:

| Field | Value |
| --- | --- |
| `Release-Controller-Schema` | `1` |
| `Repository` | `owner/name` |
| `Commit` | The exact merge |
| `Target-Version` | `X.Y.Z` |
| `Classification` | The highest change: `patch`, `minor` or `breaking` |
| `Release-Base` | The base tag name, its tag object and its commit |
| `Notes-Digest` | `sha256:` over the accepted merges the notes are built from, the base and the target |
| `CI-Workflow` | `.github/workflows/ci.yml` |
| `CI-Run`, `CI-Attempt` | The run and attempt that satisfied the gates |

The annotation then lists the CI evidence and the accepted merges by number and sha. It deliberately
leaves out pull-request titles.

An existing build tag on the commit is `already_tagged` only when every field before `CI-Run` matches
the fresh calculation, and `CI-Run` is a final-merge CI run of the commit. Otherwise it is refused, and
the evaluation stops for any of these codes:

| Code | Tag found |
| --- | --- |
| `conflicting_build_provenance` | A build tag on the commit with other provenance, including one naming another commit's run |
| `duplicate_build_tags` | More than one build tag on the commit |
| `untrusted_build_tag` | Another commit's tag for the same target whose annotation does not name that tag, repository, commit and target. The target's ordinals cannot be trusted, so none is allocated past it |
| `malformed_build_tag` | A name like a build tag but not `vX.Y.Z-dev.N` with a positive ordinal |
| `lightweight_build_tag` | A build tag that is not an annotated tag of a commit |

## Workflows and permissions

`.github/workflows/release-build-tag.yml` runs on `workflow_run` when CI completes on `main`. GitHub
runs this kind of workflow from the default branch only, so a pull request cannot change it.

| Job | Permissions | Runs when | What it does |
| --- | --- | --- | --- |
| `evaluate` | `contents`, `actions`, `pull-requests`: read | The completed run was a push to main by this repository's CI | Installs the pinned dependencies with lifecycle scripts disabled, then runs `evaluate-build`. While publication is activated, it also bundles the plan and `runtime-dependencies` into an artifact and outputs its SHA-256 |
| `publish` | Grants `contents: write` to the writer | The decision is `eligible` and publication is activated | Calls `release-tag-writer.yml` with operation `build` |
| `status` | `statuses: write`, and `contents: read` so the checkout can read this private repository | Publication is activated | Checks the bundle digest, then runs `write-build-status` |

`.github/workflows/release-tag-writer.yml` is callable only. Its one job is the only job in the
repository that can create tags. Later publishers call it instead of holding their own write permission.

- **One lock.** The job's concurrency group is `release-tag-writer`, with `cancel-in-progress: false`
  and `queue: max`. As GitHub documented on 14 September 2026, `queue: max` keeps up to 100 callers
  pending instead of replacing the one already queued, and cancels callers beyond that. The group
  serialises writers; it is not a record of merges. A caller that is cancelled, or an event that never
  arrives, leaves its commit without a build tag until the next slice of #36 adds recovery.
- **No untrusted code beside the token.** Neither writing job checks out the evaluated commit, runs
  `npm`, restores a cache or runs application code. Both check the bundle's digest before running
  anything, and both run only `scripts/release/controller.mjs` from main. Event values reach scripts as
  environment variables, never as `${{ }}` expressions.
- **What `contents: write` allows.** It is GitHub's narrowest permission that can create a tag, and it
  is broader than that: the same token could push a branch or change a file. The boundary is what the
  job runs. The controller's tag writer can create a build-tag object and a new `refs/tags/` reference
  that matches `vX.Y.Z-dev.N`, and nothing else.
- **Nothing else is added.** There is no secret, no deployment hook, no Vercel or Supabase credential,
  and nothing triggered by a tag or a release. CI's branch filters are unchanged.

While publication is off, the `evaluate` job still runs after every CI completion on main. It writes a
job summary and nothing else, which gives non-publishing evidence before any activation.

## Activation is a separate Owner decision

This change does not activate anything. Issue #36 sets these conditions before activation:
independent review of the whole implementation, an authorised merge, an inspection of the live Git
integrations and hooks, and a check of tag routing in an explicitly authorised disposable
non-production repository. Any unresolved coupling between a tag and a deployment holds activation.
Never test that coupling by creating an OMS tag.

Activation is the Owner setting the repository variable `RELEASE_BUILD_PUBLICATION` to `enabled`.
Any other value, or no variable, keeps publication off, and the controller checks the value again
before writing. A variable change is not recorded in Git history.

## What the tests prove, and what they do not

The tests are `tests/unit/release/*.test.ts`, and `npm run test:unit` runs them. Each test runs the
controller as a separate process against a disposable Git repository and a GitHub simulator on a
loopback port. The simulator records every request. Build tags are real Git objects written into a
disposable repository that stands in for GitHub's copy, with a separate clone as the workflow's
checkout.

**Proved by fixtures, for the preview:**

- Every declared type, the highest bump in a mixed range, and the 0.x and stable mappings
- Explicit `1.0.0` acceptance, deprecation and component resets
- Supported and ambiguous reverts, plus every named refusal and pending decision
- Retained metadata winning over post-merge PR edits
- Pagination, and the stop on an API failure
- Hostile title and body text staying data
- The 0.0.6 → 0.0.7 dry-run shape, a feature raising the target to 0.1.0, and a patch after an
  intervening release
- The classification workflow's events, permissions, pinned actions, and environment-only handling of
  PR text, checked as YAML

**Proved by fixtures, for build tags:**

- Refusal of a pull-request run, another branch, a fork, another workflow, another repository, a
  synthetic merge run and another commit's run, before any job is read. A commit off main is refused
  before any CI is read
- Every unsatisfied gate named, pending CI, and every page of runs, jobs and tag references read
- A same-run retry satisfying the gate, with the failed attempt and the accepted flaky retry recorded.
  Passing jobs of another commit or run do not count, and a waiver option is a usage error
- Zero writes for every value of `RELEASE_BUILD_PUBLICATION` except `enabled`
- Creation: exactly two writes, a read-back, a real annotated object that peels to the commit with
  its provenance and no titles, and every other tag, branch and package version unchanged
- A duplicate invocation, a later CI event and a normal release at the same commit, each leaving
  one verified tag and making no second write
- Interruption between object and reference, a lost response and a failed read-back: no success is
  reported, and a retry creates or confirms exactly one tag
- A name collision refused without renaming; an identical writer's tag confirmed
- Duplicate, untrusted, malformed, lightweight and forged tags refused
- Ordinals in allocation order, the exact commit tagged however far main has moved, a feature raising
  the target, earlier tags never moving, and an older commit calculated from its own ancestral release
- Tampered, foreign, ineligible and drifted plans refused before any write
- Hostile history kept out of the annotation and any shell; the token never printed
- The status writer's decision table, its zero writes while off, and its input checks
- The bundle list complete, and the controller evaluating and publishing from the bundle alone
- The workflows' triggers, permissions, lock, activation conditions, digest check, pinned actions and
  the absence of installs, caches, secrets and deployment, checked as YAML

**Not proved here:**

- GitHub's real responses. The simulator reproduces the documented fields the controller reads,
  cross-checked against read-only responses for this repository's CI run `34738126692`.
- The workflows running on GitHub. `workflow_run` workflows run only from the default branch, so neither
  build-tag workflow runs before a merge. GitHub's evaluation of the conditions, `queue: max`, the
  reusable workflow's permissions and outputs, and the artifact transfer are not exercised.
- Serialisation itself, which is GitHub's. The fixtures prove what happens when it is bypassed: the
  collision is refused.
- Recovery of commits whose evaluation was lost. That is the next slice of #36.
- Whether a tag push reaches a deployment integration. That is an activation hold, not a test.
