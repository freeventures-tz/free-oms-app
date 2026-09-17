/**
 * The GitHub REST API, split by what a caller is allowed to do with it.
 *
 *   createGitHubReader   GET only. Every decision the controller makes is read through this.
 *   createTagWriter      Creates a build-tag object and its `refs/tags/` reference. Nothing else: it
 *                        cannot update, force or delete a reference, and it cannot name a branch.
 *   createStatusWriter   Creates one commit status in the `release/build-tag` context.
 *
 * None of them follows a redirect, and none sends a request — a pagination link included — to any
 * origin other than the API it was given, so a token can never be carried somewhere else.
 */

import { FULL_SHA } from "./cli.mjs";
import { ControllerError } from "./errors.mjs";
import { BUILD_TAG } from "./version.mjs";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_PAGES = 100;

export const STATUS_CONTEXT = "release/build-tag";
const STATUS_STATES = new Set(["pending", "success", "failure"]);
const STATUS_DESCRIPTION_LIMIT = 140;

function connect({ apiUrl, token, repository }) {
  let base;
  try {
    base = new URL(apiUrl);
  } catch {
    throw new ControllerError("github_api_url_invalid", `GITHUB_API_URL is not a URL: ${apiUrl}`);
  }
  if (base.protocol !== "https:" && !(base.protocol === "http:" && LOOPBACK.has(base.hostname))) {
    throw new ControllerError(
      "github_api_url_insecure",
      "GITHUB_API_URL must be https (plain http is accepted only on a loopback address)",
    );
  }
  const root = `${base.origin}${base.pathname.replace(/\/$/, "")}`;

  const headers = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "free-oms-release-controller",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };

  async function send(method, url, body) {
    const target = new URL(url);
    if (target.origin !== base.origin) {
      throw new ControllerError("github_link_refused", `refusing to follow a link to ${target.origin}`);
    }
    try {
      return await fetch(target, {
        method,
        headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
      });
    } catch (error) {
      throw new ControllerError("github_request_failed", `${method} ${target.pathname} failed: ${error.message}`);
    }
  }

  async function readJson(response, method, path) {
    try {
      return await response.json();
    } catch {
      throw new ControllerError("github_response_invalid", `${method} ${path} did not return JSON`);
    }
  }

  /** One resource, or null when GitHub has no such resource. */
  async function getOne(path) {
    const response = await send("GET", `${root}${path}`);
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new ControllerError("github_request_failed", `GET ${path} answered ${response.status}`);
    }
    return readJson(response, "GET", path);
  }

  /** Every page of a list. `pick` finds the list in each page's body. */
  async function getAll(path, query, pick) {
    let url = `${root}${path}?${new URLSearchParams({ ...query, per_page: "100" })}`;
    const items = [];
    for (let page = 1; url; page += 1) {
      if (page > MAX_PAGES) {
        throw new ControllerError("github_pagination_unbounded", `GET ${path} kept paginating`);
      }
      const response = await send("GET", url);
      if (!response.ok) {
        throw new ControllerError("github_request_failed", `GET ${path} answered ${response.status}`);
      }
      const list = pick(await readJson(response, "GET", path));
      if (!Array.isArray(list)) {
        throw new ControllerError("github_response_invalid", `GET ${path} did not return a list`);
      }
      items.push(...list);
      url = nextLink(response.headers.get("link"));
    }
    return items;
  }

  return { root, repositoryPath: `/repos/${repository}`, send, readJson, getOne, getAll };
}

const segment = (value) => encodeURIComponent(String(value));

export function createGitHubReader(options) {
  const api = connect(options);
  const repo = api.repositoryPath;

  return {
    /** One pull request, or null when GitHub has no such pull request in this repository. */
    pullRequest: (number) => api.getOne(`${repo}/pulls/${segment(number)}`),

    /** Every pull request GitHub associates with a commit, across all pages. */
    pullRequestsForCommit: (sha) => api.getAll(`${repo}/commits/${segment(sha)}/pulls`, {}, (body) => body),

    /** A workflow by its file name, or null. */
    workflow: (file) => api.getOne(`${repo}/actions/workflows/${segment(file)}`),

    /** Every run of a workflow whose head is a commit, across all pages. */
    workflowRunsForCommit: (file, sha) =>
      api.getAll(`${repo}/actions/workflows/${segment(file)}/runs`, { head_sha: sha }, (body) => body?.workflow_runs),

    /** A workflow run as it stands now, at its latest attempt, or null. */
    workflowRun: (id) => api.getOne(`${repo}/actions/runs/${segment(id)}`),

    /** One earlier attempt of a workflow run, or null. */
    workflowRunAttempt: (id, attempt) => api.getOne(`${repo}/actions/runs/${segment(id)}/attempts/${segment(attempt)}`),

    /** Every job of every attempt of a workflow run, across all pages. */
    workflowRunJobs: (id) => api.getAll(`${repo}/actions/runs/${segment(id)}/jobs`, { filter: "all" }, (body) => body?.jobs),

    /** Every `refs/tags/` reference, across all pages. */
    tagReferences: async () =>
      (await api.getAll(`${repo}/git/matching-refs/tags`, {}, (body) => body)).filter((ref) =>
        String(ref?.ref ?? "").startsWith("refs/tags/"),
      ),

    /** One branch reference, or null. */
    branchReference: (name) => api.getOne(`${repo}/git/ref/heads/${segment(name)}`),

    /** One tag reference, or null. */
    tagReference: (name) => api.getOne(`${repo}/git/ref/tags/${segment(name)}`),

    /** One annotated tag object, or null. */
    tagObject: (sha) => api.getOne(`${repo}/git/tags/${segment(sha)}`),

    /** The latest status on a commit in the `release/build-tag` context, from its combined status, or null. */
    buildTagStatus: async (sha) =>
      (await api.getAll(`${repo}/commits/${segment(sha)}/status`, {}, (body) => body?.statuses)).find(
        (status) => status?.context === STATUS_CONTEXT,
      ) ?? null,
  };
}

export function createTagWriter(options) {
  const api = connect(options);
  const repo = api.repositoryPath;

  const requireBuildTag = (name) => {
    if (!BUILD_TAG.test(name)) {
      throw new ControllerError("tag_writer_refused", `the tag writer creates build tags only, not ${JSON.stringify(name)}`);
    }
  };

  return {
    /** Creates an annotated tag object for a commit. It is not a tag until a reference names it. */
    async createTagObject({ tag, message, commit }) {
      requireBuildTag(tag);
      if (!FULL_SHA.test(commit)) throw new ControllerError("tag_writer_refused", "a build tag must name a full commit sha");
      const path = `${repo}/git/tags`;
      const response = await api.send("POST", `${api.root}${path}`, { tag, message, object: commit, type: "commit" });
      if (response.status !== 201) {
        throw new ControllerError("github_write_failed", `POST ${path} answered ${response.status}`);
      }
      const body = await api.readJson(response, "POST", path);
      if (!FULL_SHA.test(String(body?.sha ?? ""))) {
        throw new ControllerError("github_response_invalid", `POST ${path} did not return a tag object sha`);
      }
      return body;
    },

    /**
     * Creates `refs/tags/<tag>` pointing at a tag object. There is no force: GitHub refuses a name
     * that already exists, and `{ created: false }` says only that it refused — the caller reads the
     * reference back to learn whose it is.
     */
    async createTagReference({ tag, object }) {
      requireBuildTag(tag);
      if (!FULL_SHA.test(object)) throw new ControllerError("tag_writer_refused", "a reference must name a full object sha");
      const path = `${repo}/git/refs`;
      const response = await api.send("POST", `${api.root}${path}`, { ref: `refs/tags/${tag}`, sha: object });
      if (response.status === 201) return { created: true };
      if (response.status === 422) return { created: false };
      throw new ControllerError("github_write_failed", `POST ${path} answered ${response.status}`);
    },
  };
}

export function createStatusWriter(options) {
  const api = connect(options);
  const repo = api.repositoryPath;

  return {
    async createStatus({ sha, state, description, targetUrl }) {
      if (!FULL_SHA.test(sha)) throw new ControllerError("status_writer_refused", "a status must name a full commit sha");
      if (!STATUS_STATES.has(state)) throw new ControllerError("status_writer_refused", `unknown status state ${state}`);
      if (typeof description !== "string" || description.length > STATUS_DESCRIPTION_LIMIT || /[\r\n]/.test(description)) {
        throw new ControllerError("status_writer_refused", "a status description is one line of at most 140 characters");
      }
      const path = `${repo}/statuses/${sha}`;
      const response = await api.send("POST", `${api.root}${path}`, {
        state,
        context: STATUS_CONTEXT,
        description,
        ...(targetUrl ? { target_url: targetUrl } : {}),
      });
      if (response.status !== 201) {
        throw new ControllerError("github_write_failed", `POST ${path} answered ${response.status}`);
      }
    },
  };
}

function nextLink(header) {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match) return match[1];
  }
  return null;
}
