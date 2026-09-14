# Release controller

This is the read-only part of the release automation in
[issue #36](https://github.com/freeventures-tz/free-oms-app/issues/36). It classifies pull-request
titles, and for one exact accepted merge it previews the next version and the complete release notes.

**It publishes nothing.** It creates no tags, refs, statuses or releases, and it never pushes. Build
tags, recovery of missed tags, release preparation and normal-release publication belong to later
slices of #36. None of them exists yet.

Issue #36 owns the policy: the compatibility contract, the version table and the accepted-merge
rules. This file covers running the commands and what their tests prove.

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
allowed on a loopback address. `GITHUB_SERVER_URL` is used for links. The client sends only GET
requests, follows no redirects, and refuses a pagination link to any other origin.

## Exit status

| Status | Meaning |
| --- | --- |
| 0 | Valid, calculated, or nothing to release |
| 1 | Git or GitHub failed. Nothing was guessed |
| 2 | Usage error |
| 3 | Pending decision: an unsupported merge shape or a missing pull-request association, for the Owner |
| 4 | Refused: malformed, conflicting or ambiguous input |

Each refusal or pending decision carries a named `code`, plus the merge commit and pull request it
concerns.

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

## What the tests prove, and what they do not

The tests are `tests/unit/release/*.test.ts`, and `npm run test:unit` runs them. Each test runs the
controller as a separate process against a disposable Git repository and a GitHub simulator on a
loopback port. It asserts the output, the exit status, that no request other than GET was made, and
that every ref is unchanged.

**Proved by fixtures:**

- Every declared type, the highest bump in a mixed range, and the 0.x and stable mappings
- Explicit `1.0.0` acceptance, deprecation and component resets
- Supported and ambiguous reverts, plus every named refusal and pending decision
- Retained metadata winning over post-merge PR edits
- Pagination, and the stop on an API failure
- Hostile title and body text staying data
- The 0.0.6 → 0.0.7 dry-run shape, a feature raising the target to 0.1.0, and a patch after an
  intervening release
- The workflow's events, permissions, pinned actions, and environment-only handling of PR text,
  checked as YAML

**Not proved here:**

- GitHub's real responses. The simulator reproduces only the documented fields the controller
  reads.
- The workflow running on GitHub. It first runs when this change's pull request opens.
- Anything that publishes. Those behaviours are later slices of #36.
