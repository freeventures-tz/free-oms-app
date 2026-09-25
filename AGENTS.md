# Agents workflow: Free Ventures OMS

## Route by size

| Work | Chain |
|---|---|
| Tweak (copy, styling) | Isolate → edit → Prove → Ship |
| Bug | Isolate → `diagnosing-bugs` → `tdd` → Prove → Ship |
| Feature | Align → Plan → Isolate → Build → Prove → Ship |
| Epic (more than one session holds) | `wayfinder`, then the Feature chain per ticket |

## Beats

0. **Align**: `grill-with-docs`; add `prototype` for unsettled UI. **Stop**: the human confirms shared understanding before Plan.
1. **Plan**: `to-spec` → `to-tickets`, labelled `ready-for-agent`. Claude Code runs Align and Plan.
2. **Isolate**: `new-feature`. Every task gets its own worktree. Claude Code: harness worktree, branch `claude/<task>`. Codex: `.worktrees/<task>` (gitignored), branch `codex/<task>`. Claim the ticket first with a comment `Claimed by <claude|codex> on <branch>`; skip tickets that already carry a claim.
3. **Build**: `implement` → `tdd`, to the invariants below.
4. **Prove**: `evidence-driven-testing`. Capture *before* while reproducing, *after* once it works.
5. **Ship**: `code-review` → cross-review (the human starts the other agent on `code-review` for the PR) → `before-and-after` (production vs PR preview) → PR → `greploop` (`greploop-apps` over the file limit) until **5/5, zero unresolved**. End by presenting the PR URL. **Stop**: merge is the human's.
6. **Release**: once the human approves the merge, merge, tag and changelog it. See *Releasing*.

End an unfinished session with `handoff`.

**If any Dependency to execute this workflow is missing: Stop and report so that it can be setup before continuing blindly or ignoring any step.** 

## What this repo holds

The repo is complete on its own: everything it needs is committed, and it holds only permanent project material. Transient working files (handoffs, prototypes, scratch notes) go to the workspace `docs/` folder one level above the repo root, never into the repo.

## Data and evidence

- Schema changes are files in `supabase/migrations/`, tested against local Supabase. Hosted databases change only through the Supabase GitHub integration on merge; agents hold no hosted database credentials.
- Real customer records stay out of git and out of evidence. Screens, recordings and tests use the seeded fixture data and the seeded test account.
- Upload images with `IMAGE_ADAPTER=gist`. Post videos through the PR comment box in the signed-in browser.

## Checks

`npm run lint`, `npm run typecheck`, `npm run test`, `npm run test:e2e`, `npm run build`. Run all of them before opening a PR and again after rebasing.

## Multi-agent rules

- Work on your own task branch; `main` changes only by merged PR.
- Leave other agents' worktrees, branches and uncommitted work untouched.
- Before starting, scope-check open PRs (`gh pr list`, `gh pr diff <n> --name-only`). On overlap, stop and ask.
- Force-push only with `--force-with-lease`, only on your own branch.
- Regenerate lockfiles on conflict (`npm install`).
- Confirm a dev-server port answers *your* process before trusting it.
- If a conflict can't be resolved confidently, stop and report.

## Completing a task

1. Keep changes to the assigned task.
2. Run the checks.
3. Assemble before/after pairs from the evidence captured along the way.
4. Commit, rebase onto `origin/main`, rerun the checks.
5. `git push -u origin <branch>` (`--force-with-lease` after rebasing a pushed branch).
6. Open the PR: what changed, how it was tested (every claim backed by evidence), before/after proof, risks and follow-ups. Run the title and body through `unslop`.
7. `greploop` to 5/5 with zero unresolved comments.
8. Present the PR URL. Keep the worktree until the PR merges or closes.

## Releasing

Every merge to `main` is a release: it carries a SemVer tag and a `CHANGELOG.md` entry. A merge without both is unfinished work. Add the changelog entry to the PR before merging, so the tag contains the entry that describes it.

This section is the whole release process. No tool calculates versions, opens preparation PRs or writes tags. When the human says "merge and tag", do steps 3 to 5 for that PR.

1. Pick the version. `v1.0.0` is reserved for the complete app, so stay in `0.x` until then. Before 1.0, a new capability bumps the minor (`v0.2.0`) and a correction to shipped behaviour bumps the patch (`v0.1.1`). After 1.0, ordinary SemVer: breaking change major, capability minor, fix patch.
2. Write the entry, newest at the top, as a date heading carrying the version, then only the sections that have content: `NEW` for what a person can now do, `IMPROVED` for what already existed and got better, `FIXED` for what was broken. Write each line for someone using the app, in the plain voice the existing entries use, not as a commit subject. `unslop` applies. Set the same version in `package.json` and both version fields of `package-lock.json` with `npm version <X.Y.Z> --no-git-tag-version`.
3. Merge the PR with a message that says what the change does.
4. Tag the merge commit on `main`, annotated, message `<version>: <one line>`, then `git push origin <version>`.
5. Give the human the tag and the release entry alongside the merged PR URL.

## Writing for humans

Run `unslop` over text a person will read (commits, PR title and body, docs, comments, the closing reply), only on text you wrote or changed.

## Agent skills

### Issue tracker

GitHub Issues via `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five defaults: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `../CONTEXT.md` plus `../docs/adr/` at the workspace root (one level above the repo root). See `../docs/agents/domain.md`.
