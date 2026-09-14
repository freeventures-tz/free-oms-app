import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach } from "vitest";
import { parse } from "yaml";

import { createFixtureRepository, type FixtureCheckout, type FixtureRepository } from "./fixture-repository";
import {
  startGitHubSimulator,
  type GitHubSimulator,
  type SimulatedAttempt,
  type SimulatedJob,
} from "./github-simulator";
import { runController, type ControllerRun } from "./run-controller";

export const REPOSITORY = "freeventures-tz/free-oms-app";
export const REPOSITORY_ID = 1329892477;
export const CI_WORKFLOW_ID = 333762957;
export const TOKEN = "fixture-build-token";

type WorkflowFile = { jobs: Record<string, { name: string }> };

/**
 * The required gates, named exactly as ci.yml names its jobs. Simulated runs are built from this list,
 * so a controller whose gate names drift from ci.yml fails every build test.
 */
export const REQUIRED_JOBS = Object.values(
  (parse(readFileSync(".github/workflows/ci.yml", "utf8")) as WorkflowFile).jobs,
).map((job) => job.name);
export const [STATIC_GATE, DATABASE_GATE, INTEGRATION_GATE, E2E_GATE] = REQUIRED_JOBS;

export type BuildReason = { kind: string; code: string; detail: string; commit: string | null; pr: number | null };

export type BuildGate = { name: string; result: string; conclusion: string | null };

export type BuildRun = {
  runId: number;
  attempt: number;
  status: string;
  conclusion: string | null;
  satisfied: boolean;
  gates: BuildGate[];
  attempts: Array<{ attempt: number; conclusion: string | null; unsuccessfulJobs: Array<{ name: string; conclusion: string }> }>;
  acceptedFlakes: Array<{ job: string; unsuccessful: Array<{ attempt: number; conclusion: string }>; passedAttempt: number }>;
  ignoredJobs: unknown[];
};

export type BuildReport = {
  command: string;
  schema: number;
  decision: string;
  publication: string;
  repository: string;
  repositoryId: number | null;
  sha: string;
  runId: number | null;
  status: { context: string; state: string; description: string } | null;
  target: {
    version: string;
    highestChange: string;
    notesDigest: string;
    base: { tag: string; tagObject: string; commit: string; version: string };
    merges: Array<{ pr: number; mergeSha: string; title: string; change: string }>;
  } | null;
  tag: { name: string; ordinal: number; provisional: boolean; object?: string; commit?: string } | null;
  existingTag: { name: string; object: string; ciRun: string; ciAttempt: string } | null;
  releasedAs: string[];
  ci: {
    satisfiedBy: { runId: number; attempt: number; url: string } | null;
    runs: BuildRun[];
    ignoredRuns: Array<{ runId: number; why: string[] }>;
  } | null;
  reasons: BuildReason[];
};

export type ReportRun = ControllerRun & { json: BuildReport };

/** One attempt of a simulated run. Every required job not named concluded success. */
export type AttemptSpec = {
  /** A required job's conclusion, or `in_progress`. */
  jobs?: Record<string, string>;
  omit?: string[];
  extraJobs?: SimulatedJob[];
  status?: string;
  conclusion?: string | null;
};

export type RunSpec = {
  attempts?: AttemptSpec[];
  event?: string;
  branch?: string;
  headRepository?: string;
  repositoryName?: string;
  repositoryId?: number;
  path?: string;
  workflowId?: number;
};

function toAttempt(spec: AttemptSpec): SimulatedAttempt {
  const jobs: SimulatedJob[] = REQUIRED_JOBS.filter((name) => !spec.omit?.includes(name)).map((name) => {
    const outcome = spec.jobs?.[name] ?? "success";
    return outcome === "in_progress"
      ? { name, status: "in_progress", conclusion: null }
      : { name, status: "completed", conclusion: outcome };
  });
  jobs.push(...(spec.extraJobs ?? []));
  const status = spec.status ?? (jobs.some((job) => job.status !== "completed") ? "in_progress" : "completed");
  const conclusion =
    spec.conclusion !== undefined
      ? spec.conclusion
      : status !== "completed"
        ? null
        : jobs.every((job) => job.conclusion === "success")
          ? "success"
          : "failure";
  return { status, conclusion, jobs };
}

/**
 * A fresh disposable repository — standing in for GitHub's copy — a separate checkout of it, and a
 * GitHub simulator serving Git data from that repository and CI runs from memory, for every test.
 * Call inside a `describe`.
 */
export function useBuildFixture() {
  const state = {} as { github: GitHubSimulator; repo: FixtureRepository; checkout: FixtureCheckout; scratch: string };
  let runCount = 0;
  let planCount = 0;

  beforeEach(async () => {
    state.github = await startGitHubSimulator(REPOSITORY);
    state.repo = createFixtureRepository(REPOSITORY, state.github);
    state.github.attachGit(state.repo.gitRaw);
    state.github.workflows.set("ci.yml", {
      id: CI_WORKFLOW_ID,
      name: "CI",
      path: ".github/workflows/ci.yml",
      state: "active",
    });
    state.checkout = state.repo.clone();
    state.scratch = mkdtempSync(join(tmpdir(), "release-build-plans-"));
  });

  afterEach(async () => {
    state.checkout.cleanup();
    state.repo.cleanup();
    rmSync(state.scratch, { recursive: true, force: true });
    await state.github.close();
  });

  const scope = () => [
    "--repo",
    REPOSITORY,
    "--repo-id",
    String(REPOSITORY_ID),
    "--main-ref",
    "origin/main",
    "--path",
    state.checkout.dir,
  ];

  const environment = (activation: string | null | undefined) => ({
    GITHUB_API_URL: state.github.url,
    GITHUB_TOKEN: TOKEN,
    ...(activation === null || activation === undefined ? {} : { RELEASE_BUILD_PUBLICATION: activation }),
  });

  const withReport = async (run: Promise<ControllerRun>): Promise<ReportRun> => {
    const result = await run;
    let json: BuildReport | null = null;
    try {
      json = JSON.parse(result.stdout) as BuildReport;
    } catch {
      json = null;
    }
    return { ...result, json: json as BuildReport };
  };

  const writePlan = (plan: unknown) => {
    planCount += 1;
    const path = join(state.scratch, `plan-${planCount}.json`);
    writeFileSync(path, typeof plan === "string" ? plan : JSON.stringify(plan));
    return path;
  };

  const evaluateArgs = (sha: string, runId: number | null, extra: string[]) => [
    "evaluate-build",
    ...scope(),
    "--sha",
    sha,
    ...(runId === null ? [] : ["--run-id", String(runId)]),
    ...extra,
  ];

  const evaluate = (sha: string, runId: number | null, options: { extra?: string[]; sync?: boolean } = {}) => {
    if (options.sync !== false) state.checkout.sync();
    return withReport(
      runController([...evaluateArgs(sha, runId, options.extra ?? []), "--format", "json"], { env: environment(null) }),
    );
  };

  /** `activation` defaults to `enabled`; null leaves RELEASE_BUILD_PUBLICATION unset. */
  const publish = (
    plan: unknown,
    options: { activation?: string | null; extra?: string[]; sync?: boolean; planPath?: string } = {},
  ) => {
    if (options.sync !== false) state.checkout.sync();
    const planPath = options.planPath ?? writePlan(plan);
    const activation = options.activation === undefined ? "enabled" : options.activation;
    return withReport(
      runController(["publish-build", ...scope(), "--plan", planPath, ...(options.extra ?? []), "--format", "json"], {
        env: environment(activation),
      }),
    );
  };

  return {
    state,
    evaluate,
    publish,
    writePlan,
    environment,

    evaluateMarkdown(sha: string, runId: number | null, extra: string[] = []) {
      state.checkout.sync();
      return runController(evaluateArgs(sha, runId, extra), { env: environment(null) });
    },

    /** Evaluates and then publishes, the way the workflow does. */
    async tagBuild(sha: string, runId: number) {
      const evaluation = await evaluate(sha, runId);
      const publication = await publish(evaluation.json);
      return { evaluation, publication };
    },

    writeStatus(
      plan: unknown,
      writer: { result?: string; decision?: string; tag?: string },
      options: { activation?: string | null; extra?: string[] } = {},
    ) {
      const args = ["write-build-status", "--repo", REPOSITORY, "--plan", writePlan(plan)];
      if (writer.result !== undefined) args.push("--writer-result", writer.result);
      if (writer.decision !== undefined) args.push("--writer-decision", writer.decision);
      if (writer.tag !== undefined) args.push("--writer-tag", writer.tag);
      const activation = options.activation === undefined ? "enabled" : options.activation;
      return withReport(
        runController([...args, ...(options.extra ?? []), "--format", "json"], { env: environment(activation) }),
      );
    },

    /** v0.0.6 at merge #30, then merges #32 and #33: the shape of main since the last release. */
    releasedHistory() {
      const { repo } = state;
      repo.commitFile(
        "package.json",
        `${JSON.stringify({ name: "free-oms-app", version: "0.0.6" }, null, 2)}\n`,
        "chore: add package metadata",
      );
      const released = repo.mergePullRequest({ number: 30, title: "fix(stock): protect promised stock" });
      repo.tag("v0.0.6", released.mergeSha);
      const pr32 = repo.mergePullRequest({ number: 32, title: "test(settlement): prove the walk-in sale landed" });
      const pr33 = repo.mergePullRequest({ number: 33, title: "test: set the yard as well as the ledger" });
      return { released, pr32, pr33 };
    },

    /** Adds a CI workflow run for a commit and returns its id. By default: final-merge CI that passed. */
    ci(sha: string, spec: RunSpec = {}) {
      runCount += 1;
      const id = 7000 + runCount;
      state.github.runs.set(id, {
        id,
        name: "CI",
        path: spec.path ?? ".github/workflows/ci.yml",
        workflow_id: spec.workflowId ?? CI_WORKFLOW_ID,
        event: spec.event ?? "push",
        head_branch: spec.branch ?? "main",
        head_sha: sha,
        repository: { id: spec.repositoryId ?? REPOSITORY_ID, full_name: spec.repositoryName ?? REPOSITORY },
        head_repository: { full_name: spec.headRepository ?? REPOSITORY },
        attempts: (spec.attempts ?? [{}]).map(toAttempt),
      });
      return id;
    },

    /** Adds an attempt to an existing run: a retry. */
    retry(runId: number, attempt: AttemptSpec = {}) {
      state.github.runs.get(runId)!.attempts.push(toAttempt(attempt));
    },

    /** Every tag in GitHub's repository: name, object type, object, peeled commit. */
    remoteTags() {
      return state.repo.git(
        "for-each-ref",
        "--format=%(refname:strip=2) %(objecttype) %(objectname) %(*objectname)",
        "refs/tags",
      );
    },
  };
}

export type BuildFixture = ReturnType<typeof useBuildFixture>;
