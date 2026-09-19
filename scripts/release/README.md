# Release controller

This is the release automation from
[issue #36](https://github.com/freeventures-tz/free-oms-app/issues/36). It has five parts:

- **Preview** ([#37](https://github.com/freeventures-tz/free-oms-app/issues/37)). It classifies
  pull-request titles and, for one exact accepted merge, previews the next version and the complete
  release notes. It is read-only.
- **Build tags** ([#38](https://github.com/freeventures-tz/free-oms-app/issues/38)). It decides whether
  an exact merge to main earns an immutable annotated build tag, `vX.Y.Z-dev.N`, and creates the tag once
  the Owner has activated publication.
- **Recovery** ([#39](https://github.com/freeventures-tz/free-oms-app/issues/39)). Every run of the
  build-tag workflow, whether a CI completion or a recovery dispatch started it, reconciles every accepted
  merge after `v0.0.6` with its build tag from durable history. A dropped, duplicated, late or replaced
  event cannot strand an eligible build.
- **Preparation** ([#40](https://github.com/freeventures-tz/free-oms-app/issues/40)). It writes the next
  normal version into `package.json`, the lockfile and `CHANGELOG.md` on a preparation branch, for a
  reviewed pull request, and checks that preparation once it has merged. It commits, pushes and
  publishes nothing.
- **Normal release** ([#41](https://github.com/freeventures-tz/free-oms-app/issues/41)). It checks the
  review, migration, production and authorisation evidence for one exact preparation merge against GitHub,
  then publishes one immutable annotated tag `vX.Y.Z` through the same writer as build tags. Below
  `1.0.0` the Owner's production-acceptance record is the authorisation and starts it; at or above
  `1.0.0` the Owner's own approval record and dispatch are both required.

**Both publishers are off.** Build tags are written only when the repository variable
`RELEASE_BUILD_PUBLICATION` is exactly `enabled`, and normal tags only when `RELEASE_NORMAL_PUBLICATION`
is. Neither variable exists.

**The evidence is Owner-authorized ChatGPT evidence, not cryptographically proven agent identity.** Read
[What an agent attestation is, and is not](#what-an-agent-attestation-is-and-is-not) before relying on it.

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

The notes show the package version the merge carries beside the release they are calculated from. A
package version ahead of the last normal tag is a merged preparation that has not been released. The
preview labels it and never calculates from it.

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

It shares the only path that can create a tag with `publish-reconciled-builds`, which is what the tag
writer workflow runs. Do not run either against this repository with a token that can write.
Publication is the Owner's decision.

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
node scripts/release/controller.mjs write-build-status --repo freeventures-tz/free-oms-app --repo-id <id> --plan build-plan.json --writer-result success --writer-decision tagged
```

Writes one commit status in the `release/build-tag` context, and only when `RELEASE_BUILD_PUBLICATION`
is `enabled` (otherwise exit 6). It does not report the plan as it stood. It evaluates the plan's commit
again, exactly as `evaluate-build` does, and reports what exists now:

| Evaluated now | Status |
| --- | --- |
| `already_tagged` | Success, naming the verified build tag, whatever the plan or the writer reported |
| `eligible`, and the plan was eligible | Failure: the tag writer ran and did not confirm a tag. `--writer-result` and `--writer-decision` explain why |
| `eligible`, and the plan was not | Pending |
| `pending`, `failed` or `refused` | As `evaluate-build` reports it |
| `not_applicable` | None |

The workflow runs it under the tag writer's lock, so no tag can be created between that evaluation and
the status it writes. So when the status job of a failed or pending evaluation runs late, it cannot
report "no build tag" over a tag published since. It takes `--repo-id`, `--main-ref` and `--path` for
the evaluation. `--target-url` must be a workflow run of this repository. The status job runs
`write-reconciled-statuses`, which decides each status this way.

### `reconcile-builds`

Read-only. It shows what the build-tag workflow would publish, and it is the non-publishing backlog
evidence that activation needs.

```bash
git fetch origin --tags
```

```bash
GITHUB_TOKEN="<read token>" node scripts/release/controller.mjs reconcile-builds --repo freeventures-tz/free-oms-app
```

| Option | Meaning |
| --- | --- |
| `--sha`, `--run-id` | The CI completion that started the run, given together or not at all. The run must be final-merge CI for a commit on main's first-parent line, or nothing is scanned. Neither narrows the scan |
| `--since` | Default `v0.0.6`, where the window starts. Any other value is a dry run only: the writing commands refuse a plan whose window starts anywhere else |
| `--repo-id`, `--main-ref`, `--path`, `--format`, `--summary` | As for `evaluate-build` |
| `--outputs` | Appends `decision`, `eligible`, `blocked`, `recorded` and `main` |

The checkout's tags must be GitHub's, or it stops with `tag_state_out_of_date` (exit 1). The window is
main's first-parent line after the commit `v0.0.6` tags, oldest first. Each commit in it gets one
decision:

| Decision | Meaning |
| --- | --- |
| `recorded` | The commit's build tag exists and is verified: in full until a normal release contains the merge, then its target from Git and its cited CI attempt from GitHub. [Reconciliation and recovery](#reconciliation-and-recovery) says what each checks |
| `eligible` | The commit's own evaluation, made exactly as `evaluate-build` makes it without a run id, is eligible. The tag name is provisional, and counts the names already offered to older eligible commits of the same target |
| `pending`, `failed`, `refused` | Blocked. The evaluation's reasons are listed, with the gates of its newest final-merge CI run |
| `not_applicable` | The commit is itself a normal release and has no build tag |

The overall decision is `eligible` when any commit is (exit 0) and `nothing_to_publish` otherwise
(exit 0). It is `refused` (exit 4), and nothing is scanned, when the window cannot be trusted:
`unknown_main_ref`, `since_release_missing`, `since_release_not_annotated` or
`since_release_off_first_parent`. The same happens when the trigger is `unknown_commit`,
`not_on_main_first_parent` or `not_final_merge_ci`.

### `publish-reconciled-builds`

```bash
node scripts/release/controller.mjs publish-reconciled-builds --repo freeventures-tz/free-oms-app --repo-id <id> --plan build-plan.json
```

The tag writer workflow runs this command. Given a plan, it:

1. Refuses a plan that is not a `reconcile-builds` plan for this repository, main ref and the `v0.0.6`
   window (`plan_invalid`), and a refused reconciliation (`plan_not_reconciled`), before reading anything.
2. Reconciles again. The plan is not the ledger. A commit the plan found eligible is refused with
   `plan_drift` if its target has changed. A commit that is eligible now is published, whatever the plan
   said about it.
3. Exits 0 with `nothing_to_publish` when nothing is eligible. Otherwise it writes nothing, and exits 6
   with `publication_disabled`, unless `RELEASE_BUILD_PUBLICATION` is exactly `enabled`.
4. Publishes each eligible commit, oldest first, through `publish-build`'s writer: evaluate again,
   allocate, create the object and then the reference, and read both back. Each confirmed tag is read
   from GitHub and counted by the next commit's evaluation, so ordinals are allocated one at a time.

| Outcome | Decision | Exit |
| --- | --- | --- |
| Every eligible commit tagged, or found already tagged | `published` | 0 |
| A commit refused, for example with `plan_drift` or a conflict its evaluation found. The others still publish | `refused` | 4 |
| GitHub has given a name to something else (`build_tag_name_collision`). Later commits are `not_attempted` | `refused` | 4 |
| A write or read failed. That commit is `interrupted` with the error's code, later commits are `not_attempted`, and the report is still printed | `interrupted` | 1 |

The next run resumes from the tags GitHub holds. It ignores an unreferenced tag object and offers its
name again, and finds a reference whose response was lost. It never renames or moves a tag.

### `write-reconciled-statuses`

```bash
node scripts/release/controller.mjs write-reconciled-statuses --repo freeventures-tz/free-oms-app --repo-id <id> --plan build-plan.json --writer-result success --writer-decision published
```

The status job runs this under the tag writer's lock. It writes nothing unless publication is activated
(exit 6). It evaluates each of these commits again, and decides its status as `write-build-status` does:

- The trigger, with its run. A trigger outside the window gets no status (`outside_window`).
- Every commit the plan found neither `recorded` nor `not_applicable`.
- Every commit the plan found `recorded` whose latest `release/build-tag` status is missing or does not
  name its tag. That happens when the status job of the run that published the tag was skipped or lost.
- Every commit merged after the plan's `main`.

A status is written only when its state or description differs from the latest `release/build-tag`
status GitHub shows. A merge that stays unresolved stays visible, without a new status on every run.
`--writer-decision` takes a `publish-reconciled-builds` decision, and `--target-url` must be a workflow
run of this repository.

### `prepare-release`

It writes three files in the working tree it is given, and nothing else anywhere. It never commits,
stages, pushes, tags or writes to GitHub, and its GitHub client sends only GET requests.
[Preparing a normal release](#preparing-a-normal-release) gives the procedure around it.

```bash
git fetch origin --tags --prune
```

```bash
GITHUB_TOKEN="<read token>" node scripts/release/controller.mjs prepare-release --repo freeventures-tz/free-oms-app --sha <main's full sha> --pr <preparation pull request> --date <YYYY-MM-DD>
```

| Option | Meaning |
| --- | --- |
| `--sha` | The release candidate, as a full sha. For a new preparation it must be the tip of `--main-ref`, and GitHub's `main` must agree |
| `--pr` | The preparation's pull request. Required unless `--dry-run` is given |
| `--date` | The planned release date, `YYYY-MM-DD`. It goes into the changelog heading and is part of what the Owner reviews |
| `--dry-run` | Shows everything, writes nothing, and may run on `main` without `--pr` |
| `--stable-contract` | Prepares `1.0.0` instead of the calculated version, during 0.x only. The Owner's decision that the interface is stable |
| `--main-ref`, `--path`, `--format` | As for `preview`. `--path` must be the top of the working tree |

The command calculates the version exactly as `preview` does, from the last normal tag and the accepted
merges after it. `--stable-contract` is the one exception: no change calculates `1.0.0`, so during 0.x
that flag asks for it directly. Preparing it writes three files on a branch and settles nothing — the
release still needs the Owner's own approval record saying `stable-contract: authorized`, and the Owner's
own dispatch. It then writes that version to three places:

- `version` in `package.json`.
- `version` and `packages[""].version` in `package-lock.json`.
- A section headed `## [X.Y.Z] — <date>` in `CHANGELOG.md`.

The command finds each field in the file's text and replaces only the version string. Formatting, key
order, line endings and every other value stay as they were, and it parses each result again to check.
A dependency that happens to carry the same version string is not touched.

The changelog section holds a generated block between two markers:

```markdown
<!-- release-controller:begin version=0.0.7 base=v0.0.6 preparation=43 -->
…
<!-- release-controller:end -->
```

The block lists every accepted merge after the last normal release once, with its pull request, merge
and change, then breaking changes and deprecations, then the preparation's own pull request last. Write
the plain-language summary above or below the markers. A later preparation replaces the heading and the
block, and keeps everything else in the file byte for byte.

The preparation cannot list its own merge commit, because that commit does not exist until it merges.
The block names its pull request instead. Once merged, the preparation is an accepted merge like any
other. The final notes read its sha from history, and a run at the merge checks the metadata. No second
commit records the merge.

| Status | Exit | Meaning |
| --- | --- | --- |
| `prepared` | 0 | The files hold this preparation. Each file reports `changed` and `written`. A repeated run that has nothing to change writes nothing |
| `would_prepare` | 0 | A dry run. The report shows the same files, section and notes, and nothing was written |
| `already_prepared` | 0 | The candidate is the merge of the preparation its changelog names, and everything agrees. `final` holds the release notes with that merge included |
| `nothing_to_prepare` | 0 | Nothing merged after the last normal release. That includes a candidate that is itself released |
| `pending_decision` | 3 | A merge in the range needs an Owner decision, as in `preview` |
| `refused` | 4 | See below. Nothing was written |

A run that cannot finish exits 1, prints nothing on standard output, and leaves the three files as they
were. The one exception is a failed write whose restore also fails, and its error names the files:

| Code | Why |
| --- | --- |
| `tag_state_out_of_date` | The checkout's tags are not GitHub's. Fetch every tag and run it again |
| `main_out_of_date` | GitHub's `main` is not `--main-ref`. Fetch and run it again |
| `working_file_unreadable` | One of the three is not a regular file, or not UTF-8 text |
| `working_tree_changed` | One of the three changed while the command ran |
| `preparation_unverified`, `metadata_edit_unverified` | The prepared files would not read back as one version, or an edit would change more than a version |
| `preparation_not_written` | A write failed |

The command writes each new file beside its target first, as `<file>.release-preparation.tmp`, and
replaces the targets only when every changed file is written. A file already at one of those paths stops
the write, and the command leaves that file alone. If replacing a target fails, the command writes back
the files it has already replaced, and the error says whether that worked.

Refusals name what to fix:

| Code | Refused because |
| --- | --- |
| `target_already_released` | A `vX.Y.Z` tag for the calculated version exists anywhere |
| `candidate_metadata_unreadable`, `candidate_metadata_inconsistent` | At the candidate, a file is missing or not JSON, the three versions disagree, or the version is neither the last normal release nor an unreleased preparation from it no higher than the calculated version. The changelog's newest release must match the package version, and a pending one must be a generated section from the same base. Releases must run newest first |
| `candidate_version_not_normal` | The candidate's package version has a prerelease or build part. Build-tag ordinals never enter package metadata |
| `candidate_not_main_tip` | The candidate is behind main |
| `working_tree_required` | `--path` is not the top of a working tree |
| `preparation_on_main`, `preparation_branch_required` | Without `--dry-run`, the checkout is on `main` or has a detached HEAD |
| `branch_not_based_on_candidate` | The branch does not contain the candidate. Merge `origin/main` into it first |
| `branch_has_other_changes` | The branch changes a file other than the three |
| `preparation_pr_missing`, `preparation_pr_merged`, `preparation_pr_mismatch` | The pull request does not exist, has already merged in the range, is not open, does not target this repository's `main`, or comes from a fork or another branch |
| `preparation_title_mismatch` | The pull request's title, or at the merge its retained title, is not `chore(release): prepare X.Y.Z`. Retitle it before preparing again |
| `working_metadata_unreadable`, `working_metadata_inconsistent` | The working tree's files are not the candidate's, or a preparation this branch already made, as one version |
| `preparation_without_changes` | At a merged preparation, the preparation is the only merge since the last normal release |
| `prepared_version_stale`, `prepared_changelog_stale`, `prepared_changelog_mismatch` | At a merged preparation, the package version, the generated block or the heading is not what the history now gives. Something merged while it was in review. Prepare again in a new pull request |

The command does not take `--accept-stable-contract`. Preparing `1.0.0` needs its own Owner decision on
how that acceptance is recorded and checked.

### `evaluate-release`

Read-only. It checks every gate of a normal-release request and reports each one. Its JSON is the plan the
tag writer receives. [Normal-release evidence contract](#normal-release-evidence-contract) defines the
gates and the records.

```bash
git fetch origin --tags --prune
```

```bash
GITHUB_TOKEN="<read token>" node scripts/release/controller.mjs evaluate-release --repo freeventures-tz/free-oms-app --sha <preparation merge> --version <X.Y.Z> --ticket '#36' --preparation-pr <number> --deployment <deployment id> --review <record> --production-acceptance <record> --owner-approval <record> --hosted-migration none
```

| Option | Meaning |
| --- | --- |
| `--sha`, `--version`, `--preparation-pr`, `--deployment` | The request. A malformed value is a usage error |
| `--ticket` | The release-control work item every record of this release names, `#<number>`. Required |
| `--review`, `--production-acceptance` | Record references, `comment:<id>@sha256:<hex>` |
| `--owner-approval` | The Owner's release approval record, or `none`. Required at or above the policy's stable version, and refused below it |
| `--hosted-migration` | A record reference, or `none` (the default) when the migration tree is unchanged |
| `--dispatch-run-id`, `--dispatch-run-attempt` | The Owner's dispatch, given together. Without them the `dispatch` gate is `not_checked`, which only a local evaluation may leave |
| `--repo-id`, `--main-ref`, `--path`, `--format`, `--outputs`, `--summary` | As for `evaluate-build`. `--outputs` appends `decision`, `sha` and `tag` |

The command never chooses which route a release takes. The mode follows from the version and the policy at
the commit, and the `dispatch` gate requires the run to be of that mode's workflow, so a manual dispatch of
a release below the stable version refuses whatever is passed here.

The report lists each gate as `satisfied`, `not_required`, `not_checked`, `pending`, `failed` or
`refused`, with the reasons, the records it read with their authors and digests, the deployment, CI and
the final release notes. When every gate but the approval is satisfied, it also prints the approval block
the evidence calls for.

| Decision | Exit | Meaning |
| --- | --- | --- |
| `eligible` | 0 | Every gate is satisfied. The tag name is provisional until the writer confirms it |
| `already_published` | 0 | `vX.Y.Z` exists at the commit with this release's provenance, its cited dispatch is the Owner's dispatch of the commit, and its evidence still verifies. Main may have moved on since |
| `pending` | 3 | CI or the deployment has not finished, or history awaits an Owner decision |
| `refused` | 4 | A gate is refused. Each reason names its gate and code |
| `failed` | 5 | A required final-merge CI gate is unsatisfied |

### `evaluate-standing-release`

Read-only. The same plan as `evaluate-release`, for a release below the policy's stable version, derived
from the Owner's production-acceptance comment rather than from typed arguments. The standing-release
workflow runs it.

```bash
GITHUB_TOKEN="<read token>" node scripts/release/controller.mjs evaluate-standing-release --repo freeventures-tz/free-oms-app --acceptance-comment <comment id> --event-pull-request <pull request>
```

| Option | Meaning |
| --- | --- |
| `--acceptance-comment` | The id of the production-acceptance comment. Required |
| `--event-pull-request` | Where the event said that comment is. Compared with what the API answers, and never used in its place. Optional |
| `--dispatch-run-id`, `--dispatch-run-attempt`, `--repo-id`, `--main-ref`, `--path`, `--format`, `--outputs`, `--summary` | As for `evaluate-release` |

Everything else is read from the API: the comment's body, its author and the pull request it sits on. The
command derives a candidate release from the block and proves nothing by doing so — the record is then
checked like any other, by the `production-acceptance` gate, against the policy at the commit it names.

Before any gate is reached, the derivation itself refuses a comment it cannot read a release out of:

| Code | Refused because |
| --- | --- |
| `evidence_record_missing` | No such comment exists in this repository |
| `evidence_wrong_location` | The comment is on no pull request of this repository, or its block names a preparation it is not sitting on |
| `evidence_block_invalid` | The body has no single well-formed block, or the block is not a `production-acceptance` record |
| `standing_request_underived` | A field the release is built from is malformed: the commit, version, pull request, deployment, ticket, or a record reference |
| `standing_event_mismatch` | The event claimed a different pull request from the one GitHub says the comment is on. The API is authoritative and the release stops |

### `publish-release`

```bash
node scripts/release/controller.mjs publish-release --repo freeventures-tz/free-oms-app --repo-id <id> --plan release-plan.json --dispatch-run-id <run> --dispatch-run-attempt <attempt>
```

The tag writer runs this for operation `normal`, with the run and attempt from the runner. Do not run it
against this repository with a token that can write. It:

1. Refuses a plan that is not an `evaluate-release` plan for this repository or for this run
   (`plan_invalid`), and a plan that is not eligible (`plan_not_eligible`), before reading anything.
2. Evaluates the request again, with the current attempt as the dispatch. A tag that already is this
   release is read back from GitHub and reported `already_published`, with no write. Any other decision
   than `eligible` is reported as it stands.
3. Refuses `plan_drift` if the version, classification, base, notes digest, reviewed head, release date,
   schema boundary or any record digest differs from the plan.
4. Stops with exit 6, `publication_disabled`, unless `RELEASE_NORMAL_PUBLICATION` is exactly `enabled`.
   No writer client exists before this point, and `RELEASE_BUILD_PUBLICATION` does not count.
5. Reads GitHub's `main` again. It creates the annotated tag object, reads `main` again, and only then
   creates `refs/tags/vX.Y.Z` without force. If `main` moved at either point, it refuses `main_moved`.
   An object without a reference is not a publication, and a newer `main` is never tagged.
6. Reads the reference and the object back. It reports `published` only when the tag peels to the
   commit and carries this release's provenance, CI attempt and dispatch run.

| Situation | Result |
| --- | --- |
| The object is created but the reference is not confirmed | Exit 1, `tag_reference_unconfirmed`. A retry offers the name again |
| The reference is created but the response or the read-back is lost | Exit 1. A retry finds the tag and reports `already_published` |
| GitHub already holds `vX.Y.Z` | Read back. This release is `already_published`. Anything else is `normal_tag_name_collision` (exit 4), and nothing moves |
| `main` moved | `main_moved` (exit 4). Nothing is referenced |

The annotation begins `Release vX.Y.Z of <repository>`. Its fields are `Release-Controller-Schema`,
`Release-Kind`, `Release-Authorization`, `Release-Ticket`, `Repository`, `Commit`, `Version`,
`Classification`, `Release-Base`, `Notes-Digest`, `Preparation-PR`, `Reviewed-Head`, `Release-Date`,
`Schema-Boundary`, `Deployment`, the four record references, `Authorized-Actions`, `Owner`, `CI-Workflow`
and `Dispatch-Workflow`, which a retry must reproduce exactly, then `CI-Run`, `CI-Attempt` and
`Dispatch-Run`.

`Release-Authorization` is `standing` or `explicit`, and `Dispatch-Workflow` is the workflow that mode
publishes through. Both follow from the version, so a second attempt at the same release writes the same
values, and a tag that names the other mode's workflow is not this release. `Owner-Approval-Record` is
`none` for a standing release, which is what having no approval record looks like on the tag itself.

The cited CI attempt must itself have passed. The cited dispatch is read from GitHub, for an existing tag
and for one read back after a write: it must be a run of the mode's workflow in this repository, on `main`
for the tag's commit, started by the Owner, and its cited attempt must exist and have been started by the
Owner. Unlike the current dispatch, it may have finished, failed after writing, or been re-run since, so a
legitimate retry still finds its release. A tag whose cited dispatch is missing or is anyone else's is
`normal_tag_conflict`, or `normal_tag_name_collision` when it took the name during a write. The annotation
lists the CI evidence and every accepted merge by number, sha, type and change, the preparation's own merge
included. It leaves out pull-request titles, which the notes digest binds.

### `runtime-dependencies`

```bash
node scripts/release/controller.mjs runtime-dependencies
```

Prints the `node_modules/` paths the controller needs, resolved from `package-lock.json`. The
evaluation job bundles exactly these, so the writing jobs never install anything.

## Exit status

| Status | Meaning |
| --- | --- |
| 0 | Valid, calculated, eligible, tagged, already tagged, published, already published, prepared, already prepared, or nothing to do |
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

Every attempt is judged on its own jobs. The latest attempt decides whether a commit is eligible now. An
existing build tag must cite an attempt that itself concluded `success` with every required gate
passing. A later failing re-run does not unmake such a tag. A later passing attempt does not make good a
tag that cites an attempt that failed, has not finished or cannot be read.

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

An existing build tag on the commit is `already_tagged` only when three things hold. It is the commit's
only build reference. Every field before `CI-Run` matches the fresh calculation. And the `CI-Run` and
`CI-Attempt` it cites passed final-merge CI. Otherwise it is refused, and the evaluation stops for any
of these codes:

| Code | Tag found |
| --- | --- |
| `conflicting_build_provenance` | A build tag on the commit with other provenance, including one citing another commit's run or an attempt that did not pass |
| `duplicate_build_tags` | More than one build reference on the commit, counting a lightweight or malformed one beside a valid tag |
| `untrusted_build_tag` | Another commit's tag for the same target whose annotation does not name that tag, repository, commit and target. The target's ordinals cannot be trusted, so none is allocated past it |
| `malformed_build_tag` | A name like a build tag but not `vX.Y.Z-dev.N` with a positive ordinal |
| `lightweight_build_tag` | A build tag that is not an annotated tag of a commit |

### Reconciliation and recovery

The ledger is durable: main's first-parent history, the tags GitHub holds, and each commit's own
final-merge CI. Workflow events, their order, the runs a concurrency group keeps, caches and artifacts
are not part of it. So every run reconciles the whole window.

- **A dropped or replaced run** leaves its commit uncovered until the next run publishes it. That can be
  any later CI completion on main, or a recovery dispatch.
- **A duplicate or late run** finds the commit recorded and writes nothing.
- **Completions that arrive out of order** are published oldest first within each run. Ordinals record
  allocation order, so a merge that passes late holds a higher `N` than a later merge. Git records merge
  order.
- **A failed merge** stays blocked, with its reasons and gates, until its own gates pass, even after
  later merges pass and later normal releases ship. Its target is still calculated from its own
  ancestral release.
- **A feature** raises the target for itself and for later merges. Earlier patch-target tags keep their
  names, and the new target starts its own ordinals.

**The window** starts after `v0.0.6` (`BUILD_TAGS_OWED_AFTER` in `lib/reconcile.mjs`). The merges before
it are released, and none gets a build tag. The window never shrinks on its own. A merge that can never
pass stays blocked, and is read from GitHub on every run, until an Owner decision resolves it. Moving
the start is a reviewed code change.

**What `recorded` checks.** Until a normal release contains a merge, its build tag is verified in full on
every run, exactly as `evaluate-build` verifies it: provenance, target, notes digest, and a cited CI
attempt that itself passed (`verification: "full"`). A tag that fails is refused with the codes above,
whichever field is wrong. Once an annotated normal release on main's first-parent line contains the
merge, the release has settled its classification and notes digest, and only those two are left unread
(`verification: "git-and-ci"`). Git checks the rest of the target: the tag must be the commit's only build
reference, an annotated tag whose object names the commit, and whose provenance names this repository,
the commit, the version in the tag's own name, the commit's own ancestral release and the CI workflow.
GitHub is still asked whether the cited run is final-merge CI for the commit and whether the cited
attempt itself passed. A released merge that fails either check is evaluated in full, and refused exactly
as `evaluate-build` refuses it.

**Cost.** Each run reads the tag references, the trigger's run, and every merge's final-merge CI: its
runs, their jobs and any earlier attempts, usually two requests. For each merge that no normal release
contains yet, and each blocked merge, it also reads the pull requests in its range, each once per run. The
status job reads the combined status of each recorded merge once. So the cost of a run grows with the
window. Moving the window's start forward, after a normal release and when nothing before it is blocked,
is a reviewed code change.

**Retained evidence.** Build tags and their annotations are the durable record, and the
`release/build-tag` commit statuses sit beside them. Each run's job summaries, and the plan artifact kept
for one day, show what that run found and did. None of them is the ledger: the next run derives
everything again.

## Preparing a normal release

This is the procedure for a future release. Nobody has run it on this repository yet. Each merge,
release and production step keeps its own Owner approval, as issue #36 sets out, and a Reviewer's READY
or green CI grants none of them.

A preparation changes only `package.json`, `package-lock.json` and `CHANGELOG.md`. Build tags never
write a version into them. The version in them is the next normal release, and it stays ahead of the
last normal tag from the preparation's merge until the normal release is published. `preview` and
`prepare-release` label that gap and always calculate from the tag.

1. Fetch, then run a dry run from main. Read the calculated version, the pull-request title it gives,
   and the changelog section.

   ```bash
   git fetch origin --tags --prune
   ```

   ```bash
   GITHUB_TOKEN="<read token>" node scripts/release/controller.mjs prepare-release --repo freeventures-tz/free-oms-app --sha "$(git rev-parse origin/main)" --date <YYYY-MM-DD> --dry-run
   ```

2. Create the preparation branch from main.

   ```bash
   git switch -c release/vX.Y.Z origin/main
   ```

3. Open the pull request first, as a draft, because the changelog names it. GitHub needs a commit to
   open it, so start with an empty one, titled as the dry run said.

   ```bash
   git commit --allow-empty -m "chore(release): prepare X.Y.Z"
   ```

   ```bash
   git push -u origin release/vX.Y.Z
   ```

   ```bash
   gh pr create --repo freeventures-tz/free-oms-app --base main --draft --title "chore(release): prepare X.Y.Z" --body "Release preparation for X.Y.Z. Generated by prepare-release; see scripts/release/README.md."
   ```

4. Prepare with that pull request's number, on the branch.

   ```bash
   GITHUB_TOKEN="<read token>" node scripts/release/controller.mjs prepare-release --repo freeventures-tz/free-oms-app --sha "$(git rev-parse origin/main)" --pr <number> --date <YYYY-MM-DD>
   ```

5. Check that `git status` shows only the three files. Write the plain-language summary above the
   generated block if the release needs one. Stage the three files by name, commit, push, and mark the
   pull request ready for review.

   ```bash
   git add package.json package-lock.json CHANGELOG.md
   ```

   ```bash
   git commit -m "chore(release): prepare X.Y.Z"
   ```

6. If main moves before the merge, merge it into the branch and prepare again with the new main sha. A
   feature or a breaking change can raise the version. In that case the command refuses with
   `preparation_title_mismatch` until you retitle the pull request, and then replaces the section. Commit
   and push the result. The Reviewer reviews the new exact head.

   ```bash
   git fetch origin --tags --prune
   ```

   ```bash
   git merge origin/main
   ```

7. Merge only on the Owner's instruction, for the exact reviewed head, keeping the title in the merge
   body as every merge here does.

   ```bash
   gh pr merge <number> --repo freeventures-tz/free-oms-app --merge --match-head-commit <reviewed head> --body "chore(release): prepare X.Y.Z"
   ```

8. Check the merge. The report says `already_prepared` and gives the final release notes. They list
   every accepted merge since the last normal release once, the preparation's own merge included, with
   its sha. No further commit is needed.

   ```bash
   GITHUB_TOKEN="<read token>" node scripts/release/controller.mjs prepare-release --repo freeventures-tz/free-oms-app --sha <merge sha> --pr <number> --date <YYYY-MM-DD> --dry-run
   ```

   If it reports `prepared_changelog_stale`, `prepared_version_stale` or `prepared_changelog_mismatch`,
   something merged while the preparation was in review, or the date changed. Do not publish. Prepare
   again from step 2 with a new pull request. That pull request lists the first preparation as an
   accepted merge.

The preparation's merge is an accepted merge like any other, so it gets its own build tag once build
publication is activated. Publish that build tag before the normal tag: a commit that already is a normal
release is `not_applicable` and never gets one afterwards.

## Publishing a normal release

A normal release is authorised in one of two ways, and its version decides which. Below the policy's
`standing-normal-below` version — `1.0.0` — the Owner has authorised releases in advance, and the
acceptance record the Owner posts is the whole authorisation. At or above it, the Owner's own approval
record and the Owner's own dispatch are both required.

| | Standing, below `1.0.0` | Explicit, at or above `1.0.0` |
| --- | --- | --- |
| What starts it | The Owner posts the `production-acceptance` record on the merged preparation | A dispatch of `release-normal-tag.yml` from `main`, from the Owner's account |
| Workflow | `release-normal-tag-automatic.yml`, on `issue_comment` | `release-normal-tag.yml`, on `workflow_dispatch` |
| Approval record | None. One supplied anyway is refused | `owner-release-approval`, saying `stable-contract: authorized` |
| Gates | All thirteen | All thirteen |

Neither route can carry the other's releases: the `dispatch` gate requires the run to be of the workflow
the version publishes through. Each step keeps its own approval: a READY, green CI or an eligible
evaluation grants none.

Nobody has run either procedure on this repository, and both publishers are off.

### A release below `1.0.0`

1. **Before the merge.** ChatGPT reviews the preparation, and the Owner posts the `independent-review`
   record on it for its exact head, attesting `agent: ChatGPT`. If the release changes
   `supabase/migrations`, the reviewed migrations reach hosted Supabase first, ChatGPT verifies that, and
   the Owner posts the `hosted-migration` record before the first migration merges.
2. **The merge.** The Owner authorises the exact merge. Final-merge CI runs on it, and Vercel deploys it to
   production.
3. **Production verification, and the authorisation.** ChatGPT verifies Vercel's production deployment of
   the merge, and the Owner posts the `production-acceptance` record on the preparation pull request. It
   names the deployment's GitHub id and the `independent-review` and `hosted-migration` records this
   release rests on. The deployment id is on the merge commit's deployments:

   ```bash
   gh api "repos/freeventures-tz/free-oms-app/deployments?sha=<merge sha>&environment=Production" --jq '.[] | {id, sha, created_at, creator: .creator.login}'
   ```

4. **Nothing else.** Posting that record started `release-normal-tag-automatic.yml`. Its job summary names
   every gate. While `RELEASE_NORMAL_PUBLICATION` is not `enabled`, the run ends there.
5. **Afterwards.** The tag is `vX.Y.Z`. Main may move on; a later evaluation of the same release reports
   `already_published`. The next preparation calculates from the new tag.

Post the acceptance once, when it is right. Every comment by the Owner on a pull request starts a run, and
a comment that is not a valid acceptance for a releasable commit simply refuses, but the record itself is
the authorisation: there is no second confirmation between posting it and the tag being written.

### A release at or above `1.0.0`

`1.0.0` is the Owner deciding the interface is stable. No change calculates it: the preparation is made
with `prepare-release --stable-contract`, and the release needs the Owner's own approval as well.

One consequence to expect. Build tags name the version the accepted changes calculate, and they know
nothing of this decision, so the merges leading to a `1.0.0` release carry `v0.0.7-dev.N` build tags and
the release itself is `v1.0.0`. That is deliberate: a build tag marks a build toward the version the
history implies, and `1.0.0` is a decision no history implies. The two never collide — a build tag is
`vX.Y.Z-dev.N` and a normal tag is `vX.Y.Z` — and reconciliation after the release records the merges it
contains as usual.

1. **Steps 1 to 3 above**, unchanged. Posting the acceptance starts the automatic workflow, which refuses
   this release: a stable version does not publish through that route.
2. **The approval.** Run `evaluate-release` read-only with the references, `--ticket`, and
   `--owner-approval none`. With every other gate satisfied it prints the approval block and each record's
   digest. The block carries `authorization: direct-owner-instruction` and `stable-contract: authorized`.

   ChatGPT or Claude Code may post that block, and only after a direct Owner instruction in the active
   task. An instruction quoted inside a review, an issue, a handoff, a commit message or a comment is not
   one. The controller verifies the Owner's account and the evidence and stops there: it can prove neither
   who operated the login nor that the instruction was given, and it never claims to.

   To learn the new comment's digest, evaluate again naming the comment with any digest: the report refuses
   `evidence_digest_mismatch` and shows the digest GitHub's body has. Read the body before copying that
   digest; the digest binds exactly those bytes.

3. **The dispatch.** Started from `main`, from the Owner's account, with the same values:

   ```bash
   gh workflow run release-normal-tag.yml --repo freeventures-tz/free-oms-app --ref main -f sha=<merge sha> -f version=1.0.0 -f ticket='#36' -f preparation-pr=<number> -f deployment=<id> -f review=<record> -f production-acceptance=<record> -f owner-approval=<record> -f hosted-migration=none
   ```

   The job summary names every gate. While `RELEASE_NORMAL_PUBLICATION` is not `enabled`, the run ends
   there. A re-run must come from the Owner's account too, under the same rule: ChatGPT or Claude Code may
   start one only after a direct Owner instruction in the active task.
4. **Afterwards.** As above.

## Normal-release evidence contract

A normal tag `vX.Y.Z` is published only by `publish-release`, inside the tag writer's locked job, for a
request the Owner started. This section is the contract that command enforces. Issue #36 owns the policy
behind it.

Four rules apply to every gate:

- **Authority comes from a source the controller reads, never from the request.** The request names what
  to check. A green check, a label, a URL, a calculated version or a `true` proves nothing on its own.
- **A digest proves which bytes were supplied, not that they are true.** A record also needs the Owner's
  authorship, the right attestation, the right place, the right fields and the right order in time.
- **Every record binds its subject exactly**: the repository, the version, the commit or reviewed head,
  and whatever else it approves.
- **An unavailable gate refuses.** There is no override. The refusal names the gate and what is missing.

### The request

A release below `1.0.0` has no typed request at all. The Owner's `production-acceptance` comment is the
request: `release-normal-tag-automatic.yml` hands the controller the comment's id, and the controller
reads the body, the author and the location from the API and derives the release from the block.

An event is public data, so nothing an event asserts reaches a decision. The workflow's static guard runs
no job unless GitHub says the comment's author is the policy's Owner, by login and by numeric id. The one
other event value the controller receives, the pull request the event claimed, exists to be compared with
what the API answers; a disagreement refuses with `standing_event_mismatch` rather than following the
event. The comment's body never reaches the controller as an argument.

At or above `1.0.0` the dispatch comes from the Owner's account, from `main`, with these inputs. Each
reaches the controller as an environment variable.

| Input | Value |
| --- | --- |
| `sha` | The exact merge to tag: the merge of the preparation pull request |
| `version` | The normal version, `X.Y.Z`, never below the policy's `standing-normal-below` |
| `ticket` | The release-control work item every record of this release names, `#<number>` |
| `preparation-pr` | The preparation pull request's number |
| `deployment` | The GitHub deployment id of the Vercel production deployment of `sha` |
| `review` | The independent READY record |
| `production-acceptance` | The production-verification acceptance record |
| `owner-approval` | The Owner's release approval record |
| `hosted-migration` | The hosted migration record, or `none` when the migration tree is unchanged |

A record reference is `comment:<id>@sha256:<hex>`: an issue or pull-request comment in this repository,
and the SHA-256 of its body exactly as GitHub's REST API returns it, line endings included.
`evaluate-release` prints the digest of every record it reads. On the automatic route the acceptance's own
reference is computed from the bytes GitHub is serving, so its digest cannot mismatch; what catches an edit
there is GitHub's record that the comment changed after it was written.

### Evidence records

A record is a comment whose body holds exactly one fenced block with the info string `release-evidence`.
Prose outside the block is ignored — and so is every footer, byline and signature around it. **The
controller validates the structured fields inside the block and nothing else.** A footer at the end of a
review, a handoff, a directive or a commit message is for people to read; it carries no authority and the
controller never reads it.

````markdown
```release-evidence
schema: 2
kind: independent-review
repository: freeventures-tz/free-oms-app
agent: ChatGPT
role: independent-review
ticket: #36
pull-request: 43
reviewed-head: <40-character sha>
version: 0.0.7
verdict: READY
```
````

Inside the block each line is `key: value`. Every key the kind requires appears once, and no other key
appears. Schema `2` is this shape; a schema `1` record, which carried no attestation, is refused rather
than read as one.

Every record carries the same three attestation fields:

| Field | Value |
| --- | --- |
| `agent` | `ChatGPT` or `Claude Code`: whose work the Owner is vouching for |
| `role` | What that agent did, which the policy fixes per kind |
| `ticket` | The release-control work item, `#<number>`. Every record of one release names the same one |

| Kind | Required `agent` and `role` | Keys besides `schema`, `kind`, `repository` and the three above | Where |
| --- | --- | --- | --- |
| `independent-review` | `ChatGPT`, `independent-review` | `pull-request`, `reviewed-head`, `version`, `verdict: READY` | The preparation pull request |
| `production-acceptance` | `ChatGPT`, `production-acceptance` | `pull-request`, `version`, `commit`, `deployment`, `review`, `hosted-migration`, `verdict: ACCEPTED` | The preparation pull request |
| `hosted-migration` | `ChatGPT`, `hosted-migration` | `schema-boundary: changed <before> <after>`, `migration-first: applied-before-merge`, `hosted-preservation: verified` | Any issue or pull request of this repository |
| `owner-release-approval` | `ChatGPT` or `Claude Code`, `owner-authorization-relay` | `authorization: direct-owner-instruction`, `stable-contract: authorized`, `version`, `tag`, `commit`, `pull-request`, `reviewed-head`, `release-date`, `schema-boundary`, `deployment`, `review`, `production-acceptance`, `hosted-migration`, `authorized-actions: publish-normal-tag` | The preparation pull request |

A schema boundary is `unchanged <tree>` or `changed <before> <after>`. Each tree is the Git tree id of
`supabase/migrations`, or `absent`. The acceptance's `review` and `hosted-migration`, and the approval's
`review`, `production-acceptance` and `hosted-migration`, are record references, or `none` for an unchanged
boundary. When every other gate passes, `evaluate-release` prints the approval block a stable release calls
for. The Owner reads it, and the agent the Owner instructs posts it.

The `production-acceptance` record does more work than the others, because on the automatic route it is
both the last gate and the authorisation. It names the preparation, the version, the commit, the deployment
and the two records the release rests on, so the run it starts is bound to exactly one release.

### The release-evidence policy

`scripts/release/release-evidence-policy.json` names who may issue each record. The controller reads it
from Git at the requested `sha`, so the policy that governs a release is the one that release carries.
The writer also requires `main` to be `sha`, so that policy is the running controller's own.
Changing the policy is a reviewed merge.

| Key | Meaning |
| --- | --- |
| `schema` | `2`. A schema `1` policy, which named per-kind issuer accounts, is refused rather than read as this one |
| `owner` | The Owner's GitHub login and numeric id. Every record is a comment by this account, and only it may dispatch or re-run |
| `evidence.author` | `owner`. Any other value names an identity this repository cannot authenticate, and the policy is refused |
| `evidence.attestations.<kind>` | The `agent` and `role` a record of that kind must attest, or `null` |
| `authorization.standing-normal-below` | The normal version standing authorization stops below. Under it a release publishes on the acceptance record alone; at or above it the Owner's own approval and dispatch are required |
| `vercel` | The Vercel GitHub App's bot login and id, the production environment name, and the Vercel project and team that production deployment URLs name |

A `null` attestation refuses its gate with `evidence_attestation_unconfigured`. `main`'s policy attests
`ChatGPT` for all three kinds and sets `standing-normal-below` to `1.0.0`.

### Gate by gate

`evaluate-release` checks every gate and reports each as `satisfied`, `refused`, `pending` or
`not_checked`. `publish-release` evaluates everything again under the writer lock, and checks `main`
again immediately before it creates the tag object and again before the reference.

| Gate | Authoritative source | Trusted identity | Subject and reference | Validation | Freshness and replay | Refusals |
| --- | --- | --- | --- | --- | --- | --- |
| `dispatch` | GitHub's record of the running workflow run and its current attempt | The policy's `owner`, by login and id | Run id and attempt, from the runner | The workflow this release's version publishes through, in this repository, on branch `main` with head `sha`: `release-normal-tag-automatic.yml` on `issue_comment` below the stable version, `release-normal-tag.yml` on `workflow_dispatch` at or above it. The run's `actor` and the attempt's `triggering_actor` are the Owner | The attempt is the run's latest, and the run is still running. A re-run by anyone else is refused. A run of the other mode's workflow is not this release's dispatch | `dispatch_run_invalid`, `dispatch_actor_not_owner`, `dispatch_triggering_actor_not_owner` |
| `policy` | Git at `sha` | A reviewed merge | `scripts/release/release-evidence-policy.json` | Schema 2, this repository, a complete owner, evidence, authorization and Vercel entry | Read again on every run | `release_policy_missing`, `release_policy_invalid` |
| `history` | Git, and GitHub's pull-request associations | GitHub | `sha` on main's first-parent line | As `preview`, from `sha`'s own ancestral release. A normal tag at `sha` itself is not a base | The checkout's tags must be GitHub's | `tag_state_out_of_date` (exit 1), and the `preview` codes |
| `main` | GitHub's `refs/heads/main`, and `--main-ref` | GitHub | `refs/heads/main` | Both equal `sha`. A newer main never stands in for the approved `sha` | Checked again under the lock, before the object and before the reference | `main_moved` |
| `version` | The calculation from history, and the tags GitHub holds | — | `version` and the tag `vX.Y.Z` | `version` is the calculated version. `1.0.0` during 0.x is calculated only for a preparation made with `--stable-contract`, and still needs the approval record. No other normal tag names `sha`, and no normal tag is at or above `version` | An existing `vX.Y.Z` that matches in full, the mode's dispatch it cites included, is `already_published` | `version_mismatch`, `target_already_released`, `normal_version_not_newest`, `normal_tag_conflict` |
| `preparation` | Git objects at `sha`, and the preparation's pull-request association | A reviewed merge | `preparation-pr`, its merge `sha` and its reviewed head | The preparation is the last accepted merge and is `sha`. Its merge's second parent is the head GitHub records. The package version, both lockfile fields, the changelog heading and generated block, and the retained title all agree, exactly as `prepare-release` checks a merged preparation. The final notes list every accepted merge once, the preparation included | A preparation made stale by a later merge is refused | `preparation_not_at_target`, `preparation_pr_mismatch`, and the `prepare-release` codes |
| `schema-boundary` | Git trees | — | The `supabase/migrations` tree at the base release's commit and at `sha` | Equal trees are `unchanged`, proved from Git. Different trees need a `hosted-migration` record | — | `hosted_migration_record_required`, `hosted_migration_record_unexpected` |
| `hosted-migration` | The comment GitHub holds | The policy's `owner`, attesting `ChatGPT` as `hosted-migration` | Comment id and body digest | The kind's keys. Its boundary is the computed one | Created before every accepted merge in the range that changed the tree was merged. So all of a release's migrations reach hosted Supabase before the first of them merges | The `evidence_` codes below |
| `ci` | The Actions API | This repository's `ci.yml` | Every final-merge CI run of `sha` | The four required gates, under the rules in [Final-merge CI](#final-merge-ci) | The latest attempt decides | The final-merge CI codes. `ci_incomplete` is pending, a failed gate exits 5 |
| `deployment` | The Deployments API | The policy's Vercel bot, by login and id | `deployment` | The policy's environment, `sha`, and a URL of the policy's Vercel project and team. It is the newest deployment that bot made in that environment, and its latest status is `success` | A newer production deployment supersedes it | `deployment_missing`, `deployment_wrong_creator`, `deployment_wrong_environment`, `deployment_wrong_commit`, `deployment_wrong_project`, `deployment_superseded`, `deployment_not_successful`; `deployment_in_progress` is pending |
| `review` | The comment GitHub holds | The policy's `owner`, attesting `ChatGPT` as `independent-review` | Comment id and body digest | The kind's keys. The pull request is `preparation-pr`, the head is its reviewed head, and the version is `version` | Created no later than the preparation merged. It names a head that did not exist earlier. A READY for any other head or pull request, #40's included, is refused | The `evidence_` codes |
| `production-acceptance` | The comment GitHub holds | The policy's `owner`, attesting `ChatGPT` as `production-acceptance` | Comment id and body digest | The kind's keys. The preparation is `preparation-pr`, the commit is `sha`, the deployment is `deployment`, and `review` and `hosted-migration` are this release's records | Created after the deployment's `success` status. Below the stable version this record is also the authorisation, and starts the run | The `evidence_` codes |
| `owner-approval` | Below the stable version, the policy itself. At or above it, the comment GitHub holds | The policy's `owner`, attesting either agent as `owner-authorization-relay` | Comment id and body digest | Below the stable version: no record, and one supplied anyway is refused. At or above it: the kind's keys, each equal to the request and to the computed release, with `authorization: direct-owner-instruction` and `stable-contract: authorized`. It names the other records by the same references as the request | Created after the production acceptance. It names records and a merge that did not exist earlier, so it cannot approve an earlier or later release | `owner_approval_record_unexpected`, `owner_approval_record_required`, and the `evidence_` codes |

The record codes:

| Code | Refused because |
| --- | --- |
| `evidence_record_missing` | No such comment exists in this repository |
| `evidence_digest_mismatch` | The body's digest is not the reference's. The comment was edited, or the reference is wrong |
| `evidence_record_edited` | The comment was edited after it was created. GitHub keeps the author when anyone with write access edits a comment, so an edited record is refused. Post a new one |
| `evidence_attestation_unconfigured` | The policy attests no agent for this kind |
| `evidence_wrong_issuer` | The comment's author is not the Owner, by login or id |
| `evidence_agent_mismatch` | The block attests an agent the policy does not name for this kind |
| `evidence_role_mismatch` | The block names a role the policy does not name for this kind |
| `evidence_ticket_invalid` | The block's `ticket` is not `#<number>` |
| `evidence_ticket_mismatch` | The block names another release's work item |
| `evidence_wrong_location` | The comment is not on the preparation pull request |
| `evidence_block_invalid` | The body has no single well-formed block of this kind, or it holds an HTML comment, which GitHub does not show |
| `evidence_field_mismatch` | A value differs from the authoritative one. The detail names the key, the value and the expected value |
| `evidence_verdict_not_accepted` | The verdict is not `READY` or `ACCEPTED` |
| `evidence_out_of_order` | The record was created before what it depends on, or after what depends on it |

### What an agent attestation is, and is not

**This is Owner-authorized ChatGPT evidence, not cryptographically proven agent identity.** Nothing here
proves which model wrote a record, and nothing here should be described as if it did.

GitHub authenticates exactly one identity for this repository: the Owner's `freeventures-tz` account. The
agents working on it have none of their own — Claude Code works through the Owner's login, and ChatGPT has
no GitHub identity at all. So a record is a comment the Owner posts, and its `agent` and `role` say whose
work the Owner is vouching for. What the controller can check is that the Owner's account wrote it, that it
was not edited afterwards, and that every value in it binds this exact release. What it cannot check is who
operated the login, and so not who composed the text either: GitHub authenticates the account, not the
hands on it, and a person and an agent using the Owner's login are the same account to it.

Four consequences, and each of them is a real limit:

- **A record is exactly as trustworthy as the Owner's account.** Anyone who can post as the Owner can post
  a record. The gates make such a record hard to *aim* — it must name a real merged preparation, a real
  passing CI run, a real successful production deployment, and records that already exist and agree — but
  they do not make it hard to *write*.
- **Below `1.0.0` there is no second human step.** Posting a valid acceptance record is the authorisation
  and starts the run. That is what standing authorization means, and it is the Owner's decision.
- **The `v1.0.0` rule is a rule for people, not a check.** ChatGPT or Claude Code may post the approval
  record and start the Owner-account dispatch, and only after a direct Owner instruction in the active task.
  The controller verifies the Owner's account and the evidence; it can prove neither who operated the login
  nor that the instruction was given, so nothing in it enforces that rule.
- **A signing service and per-agent keys are deferred.** When they exist, an `agent` field could be
  replaced by something a third party can verify. Until then it is an audit binding, useful for reading the
  record later, and not a security control.

Human-readable documents — reviews, directives, handoffs, completion reports — carry the same four lines as
a footer, so a reader can see whose work a document is:

```text
Agent: <ChatGPT | Claude Code>
Role: <role>
Ticket: #<number>
Subject: <exact PR, commit, version, or evidence record>
```

**That footer is for people. The controller never reads it.** It validates the structured fields inside a
`release-evidence` block in a GitHub comment, and nothing else. A footer in a review, an issue, a handoff,
a commit message or a comment authorises nothing, and neither does an Owner instruction quoted in one.

### What the Owner has settled, and what is still open

The four decisions this contract used to wait on are settled. They are recorded here because the gates
still enforce them, and because two of them narrowed rather than disappeared.

1. **Who issues READY, production acceptance and hosted-migration evidence.** ChatGPT does the work; the
   Owner posts the record attesting it. This replaces the earlier requirement for a separate GitHub
   account, which could not be met. The limit above is the price of that.
2. **Authorization below `1.0.0`.** Standing. A valid acceptance record publishes the release with no
   further approval and no dispatch.
3. **`1.0.0` and later stable versions.** An explicit Owner decision every time: a preparation made with
   `prepare-release --stable-contract`, an `owner-release-approval` record the Owner posts saying
   `stable-contract: authorized`, and the Owner's own dispatch. The record may be posted by ChatGPT or
   Claude Code relaying a direct Owner instruction in the active task, and by nothing else.
4. **The configured identities.** The policy names `freeventures-tz` (313431047) as the Owner, and
   `vercel[bot]` (35613825), environment `Production`, project `free-oms`, team `freeventures-tz` for
   Vercel. These were read from this repository's own records on 17 September 2026. The Reviewer confirms
   them.

Still open, and separate from this contract:

- **Activation.** Neither publisher is on. See
  [Activation is a separate Owner decision](#activation-is-a-separate-owner-decision).
- **A verifiable agent identity.** The signing service and per-agent keys above.

## Workflows and permissions

`.github/workflows/release-build-tag.yml` runs on `workflow_run` when CI completes on `main`, and on
`workflow_dispatch`. GitHub runs a `workflow_run` workflow from the default branch only, so a pull
request cannot change it.

| Job | Permissions | Runs when | What it does |
| --- | --- | --- | --- |
| `evaluate` | `contents`, `actions`, `pull-requests`: read | The completed run was a push to main by this repository's CI, or a dispatch was started from `main` | Installs the pinned dependencies with lifecycle scripts disabled, then runs `reconcile-builds`, passing a CI completion's run and commit as the trigger. While publication is activated, it also bundles the plan and `runtime-dependencies` into an artifact and outputs its SHA-256 |
| `publish` | Grants `contents: write` to the writer | The decision is `eligible` and publication is activated | Calls `release-tag-writer.yml` with operation `build`, which runs `publish-reconciled-builds` |
| `status` | `statuses: write`; `contents`, `actions` and `pull-requests`: read, for the evaluation | Publication is activated | Waits on the tag writer's lock, checks the bundle digest, then runs `write-reconciled-statuses` |

`.github/workflows/release-tag-writer.yml` is callable only. Its one job is the only job in the
repository that can create tags. Operation `build` runs `publish-reconciled-builds`, and operation
`normal` runs `publish-release`. Its job reads deployments for the normal operation, so both callers grant
`deployments: read`.

`.github/workflows/release-normal-tag.yml` runs only on `workflow_dispatch`, and only from `main`. It is
the stable route: a release below `1.0.0` dispatched here fails the `dispatch` gate.

| Job | Permissions | Runs when | What it does |
| --- | --- | --- | --- |
| `evaluate` | `contents`, `actions`, `pull-requests`, `deployments`: read | Dispatched from `main` | Installs the pinned dependencies with lifecycle scripts disabled, then runs `evaluate-release` with the inputs as environment variables and the runner's run id and attempt as the dispatch. A decision other than `eligible` or `already_published` fails the job. While publication is activated and the plan is eligible, it bundles the plan and `runtime-dependencies` and outputs the digest |
| `publish` | Grants `contents: write` to the writer | The plan is `eligible` and `RELEASE_NORMAL_PUBLICATION` is `enabled` | Calls `release-tag-writer.yml` with operation `normal` |

`.github/workflows/release-normal-tag-automatic.yml` runs on `issue_comment` when a comment is created.
It is the standing route, and the only workflow here a public event can reach.

| Job | Permissions | Runs when | What it does |
| --- | --- | --- | --- |
| `evaluate` | `contents`, `actions`, `pull-requests`, `deployments`: read | The comment is on a pull request **and** GitHub says its author is the policy's Owner, by login and by numeric id | Checks out `main` — never the pull request — installs the pinned dependencies with lifecycle scripts disabled, then runs `evaluate-standing-release` with the comment's id and the event's pull-request number as environment variables, and the runner's run and attempt as the dispatch. While publication is activated and the plan is eligible, it bundles the plan and outputs the digest |
| `publish` | Grants `contents: write` to the writer | The plan is `eligible`, `RELEASE_NORMAL_PUBLICATION` is `enabled`, **and** the Owner guard holds again | Calls `release-tag-writer.yml` with operation `normal` |

- **The Owner guard is a literal in YAML**, because a job condition runs before any controller does. It is
  the policy's login and id, and a test compares the two in both directions so they cannot drift apart. A
  comment from any other account starts no job, so no token with `contents: write` is ever issued for it.
  The guard is repeated on the publishing job, which therefore states its own condition rather than
  inheriting safety from `needs`.
- **The comment is data, twice over.** Its body never reaches the controller as an argument; only its id
  does. The controller reads the body, the author and the location from the API and checks all of them
  again, so the guard and the gates are independent of each other.
- **No pull-request code is fetched or run.** The checkout is pinned to `main`, and `pull_request_target`
  appears nowhere.

- **One lock.** The job's concurrency group is `release-tag-writer`, with `cancel-in-progress: false`
  and `queue: max`. As GitHub documented on 14 September 2026, `queue: max` keeps up to 100 callers
  pending instead of replacing the one already queued, and cancels callers beyond that. The group
  serialises writers; it is not a record of merges. A caller that is cancelled, or an event that never
  arrives, leaves its commit without a build tag until the next run reconciles it. The `status` job
  waits on the same group, so a status is never decided while a tag is being created.
- **Recovery dispatch.** `workflow_dispatch` takes no input and runs the jobs only when started from
  `main`. It runs exactly what a CI completion runs, without a trigger:

  ```bash
  gh workflow run release-build-tag.yml --repo freeventures-tz/free-oms-app --ref main
  ```

  While publication is off, it writes a job summary and nothing else. Started from another branch, no
  job runs. That branch's own copy of the workflow could differ, but anyone allowed to dispatch can
  already push a workflow, so the dispatch grants nothing new.
- **No untrusted code beside the token.** Neither writing job checks out the evaluated commit, runs
  `npm`, restores a cache or runs application code. Both check the bundle's digest before running
  anything, and both run only `scripts/release/controller.mjs` from main. Event values reach scripts as
  environment variables, never as `${{ }}` expressions.
- **What `contents: write` allows.** It is GitHub's narrowest permission that can create a tag, and it
  is broader than that: the same token could push a branch or change a file. The boundary is what the
  job runs. The controller's tag writer is made for one kind of tag. For `build` it can create a tag object
  and a new `refs/tags/` reference that matches `vX.Y.Z-dev.N`, and for `normal` one that matches
  `vX.Y.Z`. It can do nothing else.
- **What `deployments: read` allows.** Reading deployments and their statuses. The normal gate reads
  Vercel's production deployment; nothing here creates one.
- **Nothing else is added.** There is no secret, no deployment hook, no Vercel or Supabase credential,
  and nothing triggered by a tag or a release. CI's branch filters are unchanged.

While publication is off, the `evaluate` job still runs after every CI completion on main and every
recovery dispatch. It writes a job summary and nothing else, which gives non-publishing evidence before
any activation.

No workflow runs `prepare-release`. An Implementer runs it in their own checkout with a read token, and
the reviewed pull request carries its result.

## Activation is a separate Owner decision

This change does not activate anything. Issue #36 sets these conditions before activation:
independent review of the whole implementation, an authorised merge, an inspection of the live Git
integrations and hooks, and a check of tag routing in an explicitly authorised disposable
non-production repository. Any unresolved coupling between a tag and a deployment holds activation.
Never test that coupling by creating an OMS tag.

Activation is the Owner setting a repository variable to `enabled`: `RELEASE_BUILD_PUBLICATION` for
build tags, and `RELEASE_NORMAL_PUBLICATION` for normal tags. Each is separate. Any other value, or no
variable, keeps that publisher off, and the controller checks the value again before writing. A variable
change is not recorded in Git history.

Normal publication also depends on the evidence policy at the released commit, which is a reviewed merge.
An activated normal publisher still refuses every request whose evidence does not hold, and the two
authorisation routes are decided there rather than by a setting: see
[What the Owner has settled, and what is still open](#what-the-owner-has-settled-and-what-is-still-open).

Before activation, run `reconcile-builds` read-only against main and keep its report. The first
activated run publishes the commits it lists as `eligible`, oldest first. It lists blocked commits with
their reasons and publishes none of them. The window starts after `v0.0.6`. If a normal release ships
before activation, moving that start is a reviewed decision, not a setting.

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
- Duplicate, untrusted, malformed, lightweight and forged tags refused. That includes a lightweight or
  malformed duplicate beside a valid tag, and a tag citing an attempt that failed, has not finished or
  never existed. A tag stays proven while a later re-run fails or is still running
- Ordinals in allocation order, the exact commit tagged however far main has moved, a feature raising
  the target, earlier tags never moving, and an older commit calculated from its own ancestral release
- Tampered, foreign, ineligible and drifted plans refused before any write
- Hostile history kept out of the annotation and any shell; the token never printed
- The status writer deciding from the commit as it stands. When an older failed or pending evaluation
  reports late, a confirmed tag's success stays in place, in both completion orders. The writer makes
  zero writes while off, and checks its inputs
- The bundle list complete, and the controller evaluating and publishing from the bundle alone
- The workflows' triggers, permissions, lock, activation conditions, digest check, pinned actions and
  the absence of installs, caches, secrets and deployment, checked as YAML

**Proved by fixtures, for recovery:**

- The backlog after `v0.0.6`, #32 and #33 included, listed as eligible, blocked and recorded. The blocked
  commit shows its gate, nothing is written, and every ref is unchanged. A CI completion and a dispatch
  reconcile the same window. A bad trigger or window start is refused before any scan
- Three merges whose CI completes out of order, one completion delivered twice, and a workflow replaced
  before its writer ran. Each merge ends with exactly one annotated tag, each ordinal is allocated once,
  and six writes are made in all. A writer publishes a commit its own event did not name, and stale plans
  write nothing
- A failed merge blocked through later passing merges and a normal release, with one failure status and
  no repeat. After its own retry, a dispatch tags it once from `v0.0.6`, and a second dispatch writes
  nothing
- A feature raising the target while patch-target tags keep their objects, with ordinals rising within
  each target
- An interrupted reference, a lost response and a failed read mid-scan. No false success is reported,
  the report says what was confirmed, and the next run converges on one tag per merge
- An untrusted tag refused while the other commits publish. A collision mid-run stops the run, and
  `untrusted_build_tag` follows. A drifted planned target is refused for that commit only
- A recorded tag verified in full while no normal release contains its merge, with a tag citing an
  attempt that did not pass refused. After a release, a released tag's target is checked from Git with no
  pull-request read while its CI evidence is still read, and a hand-made tag on a released merge is still
  refused
- A tag citing a failed, unfinished, nonexistent or foreign CI attempt stays refused after a later normal
  release contains its merge, with the same reasons `evaluate-build` gives
- A tag published while its run's status job was lost. The next recovery run finds the stale failure,
  evaluates the commit again, writes the tag's success, and leaves it alone after that
- Zero writes for every value of `RELEASE_BUILD_PUBLICATION` except `enabled`. Tampered, foreign,
  single-commit and refused plans refused before any write
- Statuses written only when they change. A late plan cannot replace confirmed success. A refused trigger
  is reported on its commit, and a trigger outside the window gets no status
- The dispatch trigger, its `main` condition, the trigger arguments and the absence of a window option,
  checked as YAML. Reconciliation, publication and statuses running from the bundle alone

**Proved by fixtures, for preparation.** A checkout of the disposable repository stands in for the
Implementer's. Each test reads the files it writes and every ref on both sides, and asserts zero GitHub
writes.

- 0.0.6 to 0.0.7 over #32, #33 and #42 with preparation #43. The package version, both lockfile fields,
  the changelog heading and block, and the notes all say 0.0.7. The rest of each file is byte for byte
  unchanged, a dependency with the same version string included. Only the three files are modified, and
  nothing is staged, committed or tagged
- A dry run on `main` with no pull request, which writes nothing, and the usage errors
- A repeated preparation that changes nothing. After main moves, the branch is refused until it contains
  the new main, and then the block is replaced in place, with prose kept and every merge listed once. A
  title that looks like a marker or a heading stays data
- A feature and a breaking change raising a pending 0.0.7 to 0.1.0, after the pull request is retitled.
  Deprecation and breaking sections appear, no 0.0.7 section is left, and prose is kept
- The merged preparation checked at its merge. The final notes list #43 once with its merge sha, and no
  further commit is needed. The preview labels package version 0.1.0 as ahead of `v0.0.6` and still
  calculates 0.1.0 from the tag. The merge's build tag is `v0.1.0-dev.1`, and its package version has no
  `-dev`. A different date is refused
- A merged preparation that missed a later merge refused as stale, then a new preparation pull request
  listing that merge and the first preparation once each, and checked after its own merge
- A merged preparation refused when a feature merged during its review (title, version, heading and
  block), when its merge kept another title, and when it is the only change since the last release
- A patch after an intervening `v0.0.7`: 0.0.8 from `v0.0.7`, with only its own merge. The released
  section stays byte for byte, every merge sits in exactly one release's section, and every tag,
  `v0.0.8-dev.1` included, keeps its object
- Eleven kinds of candidate metadata that history cannot explain, each refused with nothing written: the
  three versions disagreeing, a version out of range, a prerelease version, a changelog that does not
  match, a generated section from another base, releases out of order, and a file that is not JSON.
  In the working tree, the same, plus three files that agree on a version history does not explain
- CRLF files, an uncommitted field and an untracked file kept exactly
- Every precondition refusal, a stale tag or `main`, a version already released elsewhere, a direct push
  left for the Owner, a file in the way of the write, bytes that are not UTF-8, and a directory where a
  file belongs. None of them changes a file, a ref, the index
  or GitHub, and a file in the way is left where it was

**Proved by fixtures, for normal releases.** The fixtures run main's own policy as well as policies they
write themselves, in disposable Git repositories against a simulated GitHub.

- One valid 0.x release, driven end to end by the Owner's acceptance comment: every gate satisfied, the run
  read from GitHub, exactly two writes, a real annotated `v0.0.7` that peels to the preparation's merge
  with every provenance field, the CI evidence and #32, #33, #42 and #43 listed, and every other ref
  unchanged. Package, lockfile, changelog, notes and tag agree. The final notes list each merge once. The
  same plan re-run by the Owner, and a new run, report `already_published` and write nothing
- Main's own policy: a complete 0.x release is eligible under it, with every record the Owner's and every
  attestation `ChatGPT`, and no approval record read
- The release derived from the acceptance record alone: the commit, version, preparation, deployment,
  ticket and the review and hosted records all come from the block, and the annotation records the
  standing authorization, the ticket and the automatic workflow
- An event that claims a different pull request from the API: refused, not followed. An event with no claim
  at all derives the same release, because only the API is read
- An acceptance from any account but the Owner, however well formed: refused, and no writer path reached
- An acceptance attesting Claude Code, an unknown agent, another role, or a malformed or another release's
  ticket: refused, each with its own code. A block with no attestation at all is not a schema-2 record
- An acceptance edited after posting, one hidden in an HTML comment, one that is prose only, one of another
  kind, and one that does not exist
- The records the acceptance names: a review that is another kind, missing, or quoted with a digest that
  was never its body's. A replayed but genuine READY for the same head publishes the same release
- `v1.0.0`: published only with a preparation made by `--stable-contract`, the Owner's own approval saying
  `authorization: direct-owner-instruction` and `stable-contract: authorized`, and the Owner's own
  dispatch. Refused with no approval, with an unauthorized or differently-authorized stable contract, with
  a role that claims authority rather than relay, with another ticket, and from any account but the Owner.
  Either agent may relay. Refused through the automatic route, with or without the approval
- The routes cannot be swapped: a 0.x release dispatched by hand is refused, and an approval record added
  to one is refused as well. A stable release started by a comment is refused
- Zero writes for every value of `RELEASE_NORMAL_PUBLICATION` except `enabled`. Build activation does not
  activate normal publication, and normal activation does not activate the build writer
- Tampered, foreign, other-run, refused and drifted plans refused before any write; a missing dispatch is a
  usage error
- A re-run by someone else refused, the stale attempt refused, and the Owner's re-run published with its
  attempt recorded
- Interruption: an unreferenced object, a lost reference response and a failed read-back, each without a
  success, then one tag after a retry. A name taken by another tag refused without moving it
- The dispatch an existing tag cites. Refused when the run does not exist, when the attempt does not exist,
  or when it was started by someone else. Also refused when an attempt was re-run by someone else, or the
  run is for another commit, event, branch or workflow, or is a CI run. The writer's retry refuses the same
  tag and writes nothing. Accepted when the writing attempt lost its response and then failed, through the
  Owner's re-run and a later dispatch. A racing tag that cites someone else's dispatch is a collision; one
  citing the Owner's earlier, finished dispatch of the release is `already_published`
- `main` moving between the object and the reference, and before the writer starts: refused, the object
  left unreferenced, and neither the approved nor the newer commit tagged
- Two writers with the same plan racing past the lock: one tag. The loser reads it back or stops on its
  out-of-date checkout
- Records: a READY from any account but the Owner, edited, on another pull request, for another head,
  pull request or version, with another verdict, after the merge, attesting the wrong agent, role or
  ticket, malformed, of another kind, missing a block, or missing altogether. An acceptance from the wrong
  account, for another commit or deployment, attesting the wrong agent, role or ticket, rejected, or before
  the deployment succeeded. Each refused at its own gate alone
- A policy whose evidence author is not `owner`, and one that attests no agent for a kind, which refuses
  that kind's gate rather than accepting anything for it
- Dispatch: another actor, another event, branch, head, workflow or workflow id, an unknown run, a
  finished run, a re-run by someone else, and an earlier attempt
- Deployment: another creator or status creator, another environment or commit, a failed or inactive
  deployment, another Vercel project or team, plain http, a missing id, a newer production deployment,
  and one still running, which is pending
- Version and tags: another version, another preparation, a merge that is not the preparation, a newer
  normal release elsewhere, another normal tag on the commit, and `vX.Y.Z` already taken by a lightweight
  or hand-made tag. `1.0.0` asked for over a preparation that was not made for it is refused by the
  preparation's own metadata
- A preparation made stale by a merge during review, and `main` moved past the approved commit
- CI: a failed, skipped or unfinished gate, and only a pull-request run. A failed attempt retried on the
  same run publishes, with the failure and the accepted flaky retry in the annotation
- No policy, and seven kinds of unusable policy
- Schema boundary: an unchanged tree proved from Git, a history with no migrations, and a stray hosted
  record refused. A changed tree refused without a record and when the policy attests no agent, and refused
  for a record made at or after the migration's merge, by the wrong account, attesting the wrong agent, role
  or ticket, or with another boundary or statement. A record made before the merge publishes, and the
  annotation carries the boundary and record
- Build and normal tags together: three build tags, then `v0.0.7` beside them with nothing moved,
  reconciliation reading the released merges from Git and CI, a failed older merge tagged
  `v0.0.7-dev.4` from `v0.0.6` after the release, and the next fix tagged `v0.0.8-dev.1`. A request for
  0.0.8 cannot reuse the 0.0.7 evidence
- A build writer and the normal writer racing: whatever raced, the next runs converge with each tag once.
  A merge whose normal tag landed first is `not_applicable` for a build tag
- A feature raising the target: a request for 0.0.7 refused, and 0.1.0 published as `minor`
- The normal-release workflow's trigger, inputs, main-only condition, read-only evaluation, environment-only
  inputs, dispatch arguments, bundle conditions, writer call, lock, activation and pinned actions, checked
  as YAML. The writer's normal operation, and the controller evaluating and publishing from the bundle alone
- The standing-release workflow, checked as YAML: its `issue_comment` trigger, the Owner guard as the
  policy's own login and id compared in both directions, no other account named anywhere in the file, the
  same guard repeated on every job that can write, the checkout pinned to `main`, only the comment's id and
  the event's pull-request number reaching the controller, no event value expanded into a script, no
  `pull_request_target`, and pinned actions with no secret, deployment or migration. The workflow's view of
  which route a version takes is compared with the controller's
- What a tag can start: under GitHub's documented filter rules, a tag push, a tag creation or a release
  starts no workflow here. A push to `main` starts only CI, and CI's completion only the build-tag
  workflow. No job any of these can reach, the tag writer included, runs a deployment, a hosted database
  command, a secret or an action outside the pinned set, and CI's database commands start, reset and test
  its own local stack

**Not proved here:**

- GitHub's real responses. The simulator reproduces the documented fields the controller reads,
  cross-checked against read-only responses for this repository's CI run `34738126692`.
- The workflows running on GitHub. `workflow_run` workflows run only from the default branch, so neither
  build-tag workflow runs before a merge. GitHub's evaluation of the conditions, `queue: max`, the
  reusable workflow's permissions and outputs, and the artifact transfer are not exercised.
- Serialisation itself, which is GitHub's. The fixtures prove what happens when it is bypassed: the
  collision is refused.
- GitHub dropping, repeating or replacing workflow runs. The fixtures run plans late, twice or never;
  GitHub's scheduler is not simulated.
- Reconciling a long window within GitHub's API rate limit. The requests are bounded as described
  under Cost, but not measured.
- A build tag added by hand to a merge that a normal release already contains, citing a real passing CI
  attempt, with every field Git can check set correctly but a wrong classification or notes digest. Those
  two fields are not read again once a release contains the merge, so it is reported as recorded.
- Whether a tag push reaches a deployment integration. That is an activation hold, not a test.
- A preparation failing after all three temporary files are written, while it replaces the targets. The
  fixtures inject the failure while the temporary files are created. The restore path is not exercised.
- A file changing while `prepare-release` runs (`working_tree_changed`).
- The preparation procedure on GitHub. No real preparation pull request has been opened, and this
  repository's version has not changed.
- Normal publication on GitHub. The normal-release workflow has never run: GitHub's evaluation of its
  condition and inputs, the reusable writer's permissions, `GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT` inside
  the called workflow, and the fields of a real dispatch run and its attempts are not exercised. The
  simulator reproduces the documented comment, deployment and run fields, cross-checked against read-only
  responses for this repository on 17 September 2026.
- Who wrote a record. GitHub reports the account, and the fixtures prove that only the Owner's counts.
  They cannot prove which agent, or whether a person, composed it, and the `agent` field is not evidence of
  that: see [What an agent attestation is, and is not](#what-an-agent-attestation-is-and-is-not).
- That an Owner instruction for `v1.0.0` was actually given. The controller checks that the Owner's account
  posted a record saying so; it cannot read the conversation, and never claims otherwise.
- GitHub's evaluation of the standing workflow's `if` guard, and of `issue_comment` for a comment on a
  pull request. The workflow has never run. The fixtures check the YAML and drive the controller directly.
- The Vercel and Supabase integrations. Whether either reacts to a tag is outside this repository, so it
  is inspected live before activation, and tested only in an explicitly authorised disposable
  repository, never with an OMS tag.
- A release that changes migrations, on this repository. The controller has no view of hosted Supabase; it
  trusts the Owner's record attesting that ChatGPT verified it.
- An existing `vX.Y.Z` made by hand as a copy of a genuine release's annotation, citing the Owner's real
  dispatch of that commit. Every field and the cited run check out, so it is reported `already_published`,
  and nothing tells it from the tag that dispatch wrote.
- A dispatch from another branch. That branch's copy of the workflow runs, and it can differ, but anyone
  who can push that branch can already push a workflow. The controller refuses a run that is not on `main`,
  which a changed copy could also change.
