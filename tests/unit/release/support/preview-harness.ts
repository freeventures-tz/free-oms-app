import { afterEach, beforeEach } from "vitest";

import { createFixtureRepository, type FixtureRepository } from "./fixture-repository";
import { startGitHubSimulator, type GitHubSimulator } from "./github-simulator";
import { runController, runControllerJson } from "./run-controller";

export const REPOSITORY = "freeventures-tz/free-oms-app";
export const TOKEN = "fixture-read-token";
export const PULL = (n: number) => `https://github.com/${REPOSITORY}/pull/${n}`;
export const COMMIT = (sha: string) => `https://github.com/${REPOSITORY}/commit/${sha}`;

export type PreviewMerge = {
  pr: number;
  mergeSha: string;
  title: string;
  change: string;
  breaking: boolean;
  breakingExplanation: string | null;
  deprecation: string | null;
  reverts: Array<{ sha: string; url: string }>;
};

export type PreviewReason = {
  kind: "refusal" | "pending_decision";
  code: string;
  detail: string;
  commit: string | null;
  pr: number | null;
};

/**
 * A fresh disposable repository and GitHub simulator for every test, and the preview command
 * pointed at both. Call inside a `describe`.
 */
export function usePreviewFixture() {
  const state = {} as { github: GitHubSimulator; repo: FixtureRepository };

  beforeEach(async () => {
    state.github = await startGitHubSimulator(REPOSITORY);
    state.repo = createFixtureRepository(REPOSITORY, state.github);
  });

  afterEach(async () => {
    state.repo.cleanup();
    await state.github.close();
  });

  const env = () => ({ GITHUB_API_URL: state.github.url, GITHUB_TOKEN: TOKEN });
  const args = (extra: string[]) => ["preview", "--repo", REPOSITORY, "--main-ref", "main", ...extra];

  return {
    state,
    preview: (extra: string[]) => runControllerJson(args(extra), { cwd: state.repo.dir, env: env() }),
    previewMarkdown: (extra: string[]) => runController(args(extra), { cwd: state.repo.dir, env: env() }),
  };
}

/** How many times a string occurs in another. */
export function occurrences(text: string, fragment: string) {
  return text.split(fragment).length - 1;
}
