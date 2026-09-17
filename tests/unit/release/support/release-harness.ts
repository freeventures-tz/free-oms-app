import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { BuildReason } from "./build-harness";
import type { FixtureRepository } from "./fixture-repository";
import type { SimulatedAccount } from "./github-simulator";
import {
  BRANCH,
  changelog,
  DATE,
  lockfile,
  packageJson,
  REPOSITORY,
  usePreparationFixture,
} from "./preparation-harness";
import { runController, type ControllerRun } from "./run-controller";

export { DATE, REPOSITORY };

/** The Owner, as the release-evidence policy on main names the account. */
export const OWNER: SimulatedAccount = { login: "freeventures-tz", id: 313431047 };
/** Fixture-only issuers. Main's policy names none; these stand in for a future Owner decision. */
export const REVIEWER: SimulatedAccount = { login: "fixture-reviewer", id: 9001 };
export const VERIFIER: SimulatedAccount = { login: "fixture-verifier", id: 9002 };
export const MIGRATOR: SimulatedAccount = { login: "fixture-migrator", id: 9003 };
export const INTRUDER: SimulatedAccount = { login: "fixture-intruder", id: 9666 };
/** Vercel's GitHub App, as this repository's production deployments name it. */
export const VERCEL: SimulatedAccount = { login: "vercel[bot]", id: 35613825 };

export const POLICY_PATH = "scripts/release/release-evidence-policy.json";
/** The policy committed on main, byte for byte. */
export const MAIN_POLICY = readFileSync(POLICY_PATH, "utf8");
export const NORMAL_WORKFLOW_ID = 333762999;
export const MIGRATIONS = "supabase/migrations";
export const PRODUCTION_URL = "https://free-oms-k3x9q2w7r-freeventures-tz.vercel.app";

/** The GitHub server times of a release, in the order the procedure produces them. */
export const TIMES = {
  hosted: "2026-09-13T08:00:00Z",
  review: "2026-09-13T08:30:00Z",
  merged: "2026-09-13T09:00:00Z",
  deployed: "2026-09-13T09:05:00Z",
  deploySucceeded: "2026-09-13T09:06:00Z",
  accepted: "2026-09-13T10:00:00Z",
  approved: "2026-09-13T11:00:00Z",
};

export const preparationTitle = (version: string) => `chore(release): prepare ${version}`;

type Issuers = Partial<Record<"independent-review" | "production-acceptance" | "hosted-migration", SimulatedAccount | null>>;

/** A release-evidence policy, written out by hand from the README's contract. */
export function policyText(options: { issuers?: Issuers; owner?: SimulatedAccount; extra?: Record<string, unknown> } = {}) {
  return `${JSON.stringify(
    {
      schema: 1,
      repository: REPOSITORY,
      owner: options.owner ?? OWNER,
      issuers: {
        "independent-review": REVIEWER,
        "production-acceptance": VERIFIER,
        "hosted-migration": MIGRATOR,
        ...options.issuers,
      },
      vercel: { creator: VERCEL, environment: "Production", project: "free-oms", team: "freeventures-tz" },
      ...options.extra,
    },
    null,
    2,
  )}\n`;
}

export const digestOf = (body: string) => `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;

/** A comment body holding one release-evidence block, with GitHub's CRLF line endings and prose around it. */
export function recordBody(kind: string, fields: Record<string, string | number>, options: { prose?: string; eol?: string } = {}) {
  const eol = options.eol ?? "\r\n";
  return [
    options.prose ?? `Release evidence: ${kind}.`,
    "",
    "```release-evidence",
    "schema: 1",
    `kind: ${kind}`,
    `repository: ${REPOSITORY}`,
    ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`),
    "```",
    "",
  ].join(eol);
}

export type Reference = { id: number; body: string; reference: string };

export type ReleaseRequest = {
  sha: string;
  version: string;
  preparationPr: number;
  deployment: number;
  review: string;
  productionAcceptance: string;
  ownerApproval: string;
  hostedMigration: string;
};

export type Dispatch = { runId: number; attempt: number };

export type GateReport = { gate: string; state: string; reasons: Array<BuildReason & { gate: string }> };

export type ReleaseRecord = {
  kind: string;
  reference: string;
  id: number;
  digest: string | null;
  author: { login: string | null; id: number | null } | null;
  via: string | null;
  createdAt: string | null;
  issue: number | null;
  fields: Record<string, string> | null;
  satisfied: boolean;
};

export type ReleaseReport = {
  command: string;
  schema: number;
  decision: string;
  publication: string;
  repository: string;
  request: ReleaseRequest & { dispatch: Dispatch | null };
  owner: SimulatedAccount | null;
  main: string | null;
  tag: { name: string; provisional: boolean; object?: string; commit?: string } | null;
  existingTag: { name: string; object: string; commit: string } | null;
  release: {
    version: string;
    policy: string;
    highestChange: string;
    base: { tag: string; tagObject: string; commit: string; version: string };
    notesDigest: string;
    preparationPr: number;
    reviewedHead: string | null;
    releaseDate: string | null;
    merges: Array<{ pr: number; mergeSha: string; headSha: string; title: string; type: string; change: string }>;
  } | null;
  schemaBoundary: { state: string; before: string | null; after: string | null; value: string; changedBy: number[] } | null;
  dispatch: { runId: number; attempt: number; actor: SimulatedAccount | null; triggeringActor: SimulatedAccount | null } | null;
  ci: { satisfiedBy: { runId: number; attempt: number } | null } | null;
  deployment: { id: number; sha: string | null; environment: string | null; state: string | null; environmentUrl: string | null } | null;
  records: Record<"review" | "productionAcceptance" | "ownerApproval" | "hostedMigration", ReleaseRecord | null>;
  gates: GateReport[];
  reasons: Array<BuildReason & { gate: string }>;
  approvalTemplate: string | null;
  notes: string | null;
};

export type ReleaseRun = ControllerRun & { json: ReleaseReport };

export type HistoryOptions = { policy?: string | null; migrations?: boolean };

type Merge = ReturnType<FixtureRepository["mergePullRequest"]>;
export type History = { released: Merge; pr32: Merge; pr33: Merge; pr42: Merge };
export type Evidence = {
  ciRun: number;
  deployment: number;
  review: Reference;
  acceptance: Reference;
  approval: Reference;
  request: ReleaseRequest;
};

/** Successive ids, from `start + 1`. */
function sequence(start: number) {
  let last = start;
  return () => {
    last += 1;
    return last;
  };
}

export type PreparedRelease = {
  pr: number;
  version: string;
  mergeSha: string;
  reviewedHead: string;
  boundary: string;
};

/**
 * The preparation fixture — GitHub's copy, a checkout, the simulator — plus everything a normal release
 * needs: a policy in history, a merged preparation, final-merge CI, Vercel's production deployment, the
 * three evidence records and the Owner's dispatch. Call inside a `describe`.
 */
export function useReleaseFixture() {
  const prep = usePreparationFixture();
  const { fixture, state } = prep;
  const nextComment = sequence(5_700_000_000);
  const nextDeployment = sequence(6_500_000_000);
  const nextDeploymentStatus = sequence(18_000_000_000);
  const nextDispatch = sequence(9100);

  const toJson = async (run: Promise<ControllerRun>): Promise<ReleaseRun> => {
    const result = await run;
    let json: ReleaseReport | null = null;
    try {
      json = JSON.parse(result.stdout) as ReleaseReport;
    } catch {
      json = null;
    }
    return { ...result, json: json as ReleaseReport };
  };

  const scope = () => [
    "--repo",
    REPOSITORY,
    "--repo-id",
    String(1329892477),
    "--main-ref",
    "origin/main",
    "--path",
    state.checkout.dir,
  ];

  const requestArgs = (request: ReleaseRequest) => [
    "--sha",
    request.sha,
    "--version",
    request.version,
    "--preparation-pr",
    String(request.preparationPr),
    "--deployment",
    String(request.deployment),
    "--review",
    request.review,
    "--production-acceptance",
    request.productionAcceptance,
    "--owner-approval",
    request.ownerApproval,
    "--hosted-migration",
    request.hostedMigration,
  ];

  const dispatchArgs = (dispatch: Dispatch | null) =>
    dispatch === null ? [] : ["--dispatch-run-id", String(dispatch.runId), "--dispatch-run-attempt", String(dispatch.attempt)];

  const environment = (activation: string | null) => ({
    ...fixture.environment(null),
    ...(activation === null ? {} : { RELEASE_NORMAL_PUBLICATION: activation }),
  });

  const api = {
    prep,
    fixture,
    state,

    /** Metadata, the policy and a migration at 0.0.6; v0.0.6 at #30; then #32, #33 and #42. */
    history(options: HistoryOptions = {}): History {
      const { repo, github } = state;
      const files: Record<string, string> = {
        "package.json": packageJson("0.0.6"),
        "package-lock.json": lockfile("0.0.6"),
        "CHANGELOG.md": changelog(),
      };
      if (options.policy !== null) files[POLICY_PATH] = options.policy ?? policyText();
      if (options.migrations !== false) files[`${MIGRATIONS}/20260801000000_base.sql`] = "create table base (id int);\n";
      repo.commitFiles(files, "chore: add release metadata");
      const released = repo.mergePullRequest({ number: 30, title: "fix(stock): protect promised stock" });
      repo.tag("v0.0.6", released.mergeSha);
      const pr32 = repo.mergePullRequest({ number: 32, title: "test(settlement): prove the walk-in sale landed" });
      const pr33 = repo.mergePullRequest({ number: 33, title: "test: set the yard as well as the ledger" });
      const pr42 = repo.mergePullRequest({
        number: 42,
        title: "ci(release): preview releases, tag exact merges and recover missed build tags",
      });
      github.workflows.set("release-normal-tag.yml", {
        id: NORMAL_WORKFLOW_ID,
        name: "Release normal tag",
        path: ".github/workflows/release-normal-tag.yml",
        state: "active",
      });
      return { released, pr32, pr33, pr42 };
    },

    /** A pull request that changes files, merged the way this repository merges. */
    mergeFiles: prep.mergeFileChange,

    /** Prepares `version` from main on a branch, as the README's procedure does, and merges the preparation. */
    async prepareAndMerge(options: { pr?: number; version?: string; branch?: string; date?: string } = {}): Promise<PreparedRelease> {
      const pr = options.pr ?? 43;
      const version = options.version ?? "0.0.7";
      const branch = options.branch ?? BRANCH;
      prep.startBranch(branch);
      prep.openPullRequest(pr, preparationTitle(version), branch);
      const main = state.repo.git("rev-parse", "main");
      const prepared = await prep.prepare(["--sha", main, "--pr", String(pr), "--date", options.date ?? DATE]);
      if (prepared.json?.status !== "prepared") {
        throw new Error(`the fixture's preparation did not prepare: ${prepared.stdout}${prepared.stderr}`);
      }
      prep.commitPreparation(preparationTitle(version));
      prep.pushBranch(branch);
      const merge = prep.mergePreparation(pr, preparationTitle(version), branch);
      return { pr, version, mergeSha: merge.mergeSha, reviewedHead: merge.headSha, boundary: api.boundary(merge.mergeSha) };
    },

    /** The migration tree at a commit, read with Git itself, as a boundary against v0.0.6. */
    boundary(sha: string, base = "v0.0.6") {
      const tree = (rev: string) => {
        try {
          return state.repo.git("rev-parse", "--verify", "--quiet", `${rev}:${MIGRATIONS}`);
        } catch {
          return "absent";
        }
      };
      const before = tree(`${base}^{commit}`);
      const after = tree(sha);
      return before === after ? `unchanged ${after}` : `changed ${before} ${after}`;
    },

    /** Posts a comment on an issue or pull request. */
    comment(issue: number, user: SimulatedAccount, body: string, createdAt: string, options: { via?: string } = {}): Reference {
      const id = nextComment();
      state.github.comments.set(id, { id, body, user, issue, created_at: createdAt, via: options.via ?? null });
      return { id, body, reference: `comment:${id}@${digestOf(body)}` };
    },

    /** Edits a comment's body in place, as GitHub does. Its reference no longer matches. */
    editComment(id: number, body: string) {
      const comment = state.github.comments.get(id)!;
      comment.body = body;
      comment.updated_at = "2026-09-13T12:00:00Z";
    },

    /** A production deployment by Vercel, successful unless told otherwise. */
    deploy(
      sha: string,
      options: {
        creator?: SimulatedAccount;
        statusCreator?: SimulatedAccount;
        environment?: string;
        state?: string | null;
        url?: string;
        createdAt?: string;
        succeededAt?: string;
      } = {},
    ) {
      const id = nextDeployment();
      const creator = options.creator ?? VERCEL;
      const statuses = [];
      if (options.state !== null) {
        statuses.push({
          id: nextDeploymentStatus(),
          state: options.state ?? "success",
          environment_url: options.url ?? PRODUCTION_URL,
          creator: options.statusCreator ?? creator,
          created_at: options.succeededAt ?? TIMES.deploySucceeded,
        });
      }
      state.github.deployments.set(id, {
        id,
        sha,
        ref: sha,
        environment: options.environment ?? "Production",
        creator,
        created_at: options.createdAt ?? TIMES.deployed,
        statuses,
      });
      return id;
    },

    /** The Owner's dispatch of the normal-release workflow, as GitHub records the run. */
    dispatch(
      sha: string,
      options: { actor?: SimulatedAccount; event?: string; branch?: string; path?: string; workflowId?: number; headSha?: string } = {},
    ): Dispatch {
      const runId = nextDispatch();
      state.github.runs.set(runId, {
        id: runId,
        name: "Release normal tag",
        path: options.path ?? ".github/workflows/release-normal-tag.yml",
        workflow_id: options.workflowId ?? NORMAL_WORKFLOW_ID,
        event: options.event ?? "workflow_dispatch",
        head_branch: options.branch ?? "main",
        head_sha: options.headSha ?? sha,
        repository: { id: 1329892477, full_name: REPOSITORY },
        head_repository: { full_name: REPOSITORY },
        actor: options.actor ?? OWNER,
        attempts: [{ status: "in_progress", conclusion: null, jobs: [] }],
      });
      return { runId, attempt: 1 };
    },

    /** A re-run of a dispatch, by `by`. Returns the new attempt. */
    rerun(dispatch: Dispatch, by: SimulatedAccount): Dispatch {
      const run = state.github.runs.get(dispatch.runId)!;
      run.attempts.push({ status: "in_progress", conclusion: null, jobs: [], triggering_actor: by });
      return { runId: dispatch.runId, attempt: run.attempts.length };
    },

    reviewBody(release: PreparedRelease, overrides: Record<string, string | number> = {}) {
      return recordBody("independent-review", {
        "pull-request": release.pr,
        "reviewed-head": release.reviewedHead,
        version: release.version,
        verdict: "READY",
        ...overrides,
      });
    },

    acceptanceBody(release: PreparedRelease, deployment: number, overrides: Record<string, string | number> = {}) {
      return recordBody("production-acceptance", {
        version: release.version,
        commit: release.mergeSha,
        deployment,
        verdict: "ACCEPTED",
        ...overrides,
      });
    },

    approvalBody(
      release: PreparedRelease,
      refs: { deployment: number; review: string; productionAcceptance: string; hostedMigration?: string },
      overrides: Record<string, string | number> = {},
    ) {
      return recordBody("owner-release-approval", {
        version: release.version,
        tag: `v${release.version}`,
        commit: release.mergeSha,
        "pull-request": release.pr,
        "reviewed-head": release.reviewedHead,
        "release-date": DATE,
        "schema-boundary": release.boundary,
        deployment: refs.deployment,
        review: refs.review,
        "production-acceptance": refs.productionAcceptance,
        "hosted-migration": refs.hostedMigration ?? "none",
        "authorized-actions": "publish-normal-tag",
        ...overrides,
      });
    },

    /**
     * The complete, valid evidence for a merged preparation: passing final-merge CI, Vercel's production
     * deployment, the READY before the merge, the acceptance after the deployment, then the Owner's approval.
     */
    evidence(release: PreparedRelease, options: { hostedMigration?: string } = {}): Evidence {
      const ciRun = fixture.ci(release.mergeSha);
      const deployment = api.deploy(release.mergeSha);
      const review = api.comment(release.pr, REVIEWER, api.reviewBody(release), TIMES.review);
      const acceptance = api.comment(release.pr, VERIFIER, api.acceptanceBody(release, deployment), TIMES.accepted);
      const approval = api.comment(
        release.pr,
        OWNER,
        api.approvalBody(release, {
          deployment,
          review: review.reference,
          productionAcceptance: acceptance.reference,
          hostedMigration: options.hostedMigration,
        }),
        TIMES.approved,
      );
      const request: ReleaseRequest = {
        sha: release.mergeSha,
        version: release.version,
        preparationPr: release.pr,
        deployment,
        review: review.reference,
        productionAcceptance: acceptance.reference,
        ownerApproval: approval.reference,
        hostedMigration: options.hostedMigration ?? "none",
      };
      return { ciRun, deployment, review, acceptance, approval, request };
    },

    /** `evaluate-release`, after fetching what GitHub has. */
    evaluate(
      request: ReleaseRequest,
      options: { dispatch?: Dispatch | null; sync?: boolean; extra?: string[]; bundle?: { cwd: string; controller: string } } = {},
    ): Promise<ReleaseRun> {
      if (options.sync !== false) state.checkout.sync();
      return toJson(
        runController(
          ["evaluate-release", ...scope(), ...requestArgs(request), ...dispatchArgs(options.dispatch ?? null), ...(options.extra ?? []), "--format", "json"],
          { env: environment(null), ...options.bundle },
        ),
      );
    },

    /** `publish-release`: the tag writer's normal operation. `activation` defaults to `enabled`. */
    publish(
      plan: unknown,
      dispatch: Dispatch | null,
      options: {
        activation?: string | null;
        sync?: boolean;
        planPath?: string;
        env?: Record<string, string>;
        bundle?: { cwd: string; controller: string };
      } = {},
    ) {
      if (options.sync !== false) state.checkout.sync();
      const planPath = options.planPath ?? fixture.writePlan(plan);
      return toJson(
        runController(["publish-release", ...scope(), "--plan", planPath, ...dispatchArgs(dispatch), "--format", "json"], {
          env: { ...environment(options.activation === undefined ? "enabled" : options.activation), ...options.env },
          ...options.bundle,
        }),
      );
    },

    /** One run of the normal-release workflow: the evaluation, then the writer when every gate holds. */
    async workflowRun(
      request: ReleaseRequest,
      dispatch: Dispatch,
      options: { activation?: string | null } = {},
    ): Promise<{ plan: ReleaseRun; publication: ReleaseRun | null }> {
      const plan = await api.evaluate(request, { dispatch });
      const publication = plan.json?.decision === "eligible" ? await api.publish(plan.json, dispatch, options) : null;
      return { plan, publication };
    },

    /** The prepared release, its evidence and the Owner's dispatch: everything a valid publication needs. */
    async validRelease(
      options: { history?: HistoryOptions } = {},
    ): Promise<{ history: History; release: PreparedRelease; evidence: Evidence; dispatch: Dispatch }> {
      const history = api.history(options.history);
      const release = await api.prepareAndMerge();
      const evidence = api.evidence(release);
      const dispatch = api.dispatch(release.mergeSha);
      return { history, release, evidence, dispatch };
    },

    gate(report: ReleaseReport, name: string) {
      const found = report.gates.find((gate) => gate.gate === name);
      if (!found) throw new Error(`no gate ${name}`);
      return found;
    },

    /** Every gate that is not satisfied, as `gate:code` pairs, or `gate:state` when it has no reason. */
    unsatisfied(report: ReleaseReport) {
      return report.gates
        .filter((gate) => gate.state !== "satisfied" && gate.state !== "not_required")
        .flatMap((gate) => (gate.reasons.length > 0 ? gate.reasons.map((r) => `${gate.gate}:${r.code}`) : [`${gate.gate}:${gate.state}`]));
    },
  };
  return api;
}

export type ReleaseFixture = ReturnType<typeof useReleaseFixture>;
