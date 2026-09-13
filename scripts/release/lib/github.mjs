/**
 * The GitHub REST reads the preview makes. This client has no method that writes: it can only send
 * GET, it follows no redirect, and it refuses a pagination link to any origin other than the API it
 * was given, so a token can never be carried somewhere else.
 */

import { ControllerError } from "./errors.mjs";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MAX_PAGES = 100;

export function createGitHubReader({ apiUrl, token, repository }) {
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

  async function get(url) {
    const target = new URL(url);
    if (target.origin !== base.origin) {
      throw new ControllerError("github_link_refused", `refusing to follow a link to ${target.origin}`);
    }
    try {
      return await fetch(target, { method: "GET", headers, redirect: "error" });
    } catch (error) {
      throw new ControllerError("github_request_failed", `GET ${target.pathname} failed: ${error.message}`);
    }
  }

  async function readJson(response, path) {
    try {
      return await response.json();
    } catch {
      throw new ControllerError("github_response_invalid", `GET ${path} did not return JSON`);
    }
  }

  const repositoryPath = `/repos/${repository}`;

  return {
    /** One pull request, or null when GitHub has no such pull request in this repository. */
    async pullRequest(number) {
      const path = `${repositoryPath}/pulls/${number}`;
      const response = await get(`${root}${path}`);
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new ControllerError("github_request_failed", `GET ${path} answered ${response.status}`);
      }
      return readJson(response, path);
    },

    /** Every pull request GitHub associates with a commit, across all pages. */
    async pullRequestsForCommit(sha) {
      const path = `${repositoryPath}/commits/${sha}/pulls`;
      let url = `${root}${path}?per_page=100`;
      const pulls = [];
      for (let page = 1; url; page += 1) {
        if (page > MAX_PAGES) {
          throw new ControllerError("github_pagination_unbounded", `GET ${path} kept paginating`);
        }
        const response = await get(url);
        if (!response.ok) {
          throw new ControllerError("github_request_failed", `GET ${path} answered ${response.status}`);
        }
        const body = await readJson(response, path);
        if (!Array.isArray(body)) {
          throw new ControllerError("github_response_invalid", `GET ${path} did not return a list`);
        }
        pulls.push(...body);
        url = nextLink(response.headers.get("link"));
      }
      return pulls;
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
