# Depot CI

The workflow in `workflows/ci.yml` runs the same four jobs as `.github/workflows/ci.yml`:
static checks and build, database checks, integration tests, and responsive E2E.
Its runner labels use `depot-ubuntu-latest`. Keep both workflows aligned when changing CI.

The Depot Code Access GitHub app connects this repository to the Free Ventures organization,
`zcg6llrm1r`. No repository secrets or variables are needed by this workflow. The Supabase
credentials used in tests are generated inside each disposable job by the local test stack.

Before activation, run the workflow from its task worktree:

```sh
depot ci migrate preflight --org zcg6llrm1r --yes
depot ci run --workflow .depot/workflows/ci.yml --org zcg6llrm1r
```

Automatic triggers are registered after the workflow reaches the default branch. Merge and
release require Owner approval under `AGENTS.md`. GitHub Actions stays enabled alongside Depot
during validation. These workflows perform tests and build the app; they do not deploy it.

If a future CI change needs a secret or variable, approve its name and destination before
transferring it. Never migrate unrelated production credentials just to complete a checklist.

See the [Depot CI quickstart](https://depot.dev/docs/ci/quickstart).
