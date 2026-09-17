/**
 * The next normal version, from the last normal release and the highest accepted change.
 *
 * | Change     | During 0.x          | At or above 1.0.0 |
 * | ---------- | ------------------- | ----------------- |
 * | patch      | PATCH               | PATCH             |
 * | minor      | MINOR               | MINOR             |
 * | breaking   | MINOR, with notes   | MAJOR             |
 *
 * The 0.x mapping is OMS policy (issue #36), not something SemVer prescribes. `1.0.0` comes only from
 * an explicit stable-contract acceptance — never from a breaking marker. Lower components reset when
 * a higher one moves; `semver.inc` does exactly that.
 */

import semver from "semver";

/** An annotated normal release tag: `vMAJOR.MINOR.PATCH`, no prerelease, no build metadata. */
export const NORMAL_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** A normal version, as package metadata and the changelog carry it: `NORMAL_TAG` without the `v`. */
export const NORMAL_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * A build tag: `vMAJOR.MINOR.PATCH-dev.N`, where MAJOR.MINOR.PATCH is the target normal version and N
 * is a positive integer with no leading zero. The only kind of tag the tag writer can create.
 */
export const BUILD_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-dev\.([1-9]\d*)$/;

export function policyFor(baseVersion) {
  return semver.major(baseVersion) === 0 ? "0.x" : "stable";
}

/**
 * @returns {{ ok: true, version: string } | { ok: false, reason: { code: string, detail: string } }}
 */
export function nextVersion({ baseVersion, highest, stableContractAcceptance }) {
  const policy = policyFor(baseVersion);
  if (stableContractAcceptance) {
    if (policy !== "0.x") {
      return {
        ok: false,
        reason: {
          code: "stability_acceptance_not_applicable",
          detail: `${baseVersion} is already a stable version; stable-contract acceptance applies only during 0.x`,
        },
      };
    }
    return { ok: true, version: "1.0.0" };
  }
  const release = highest === "breaking" ? (policy === "0.x" ? "minor" : "major") : highest;
  return { ok: true, version: semver.inc(baseVersion, release) };
}

export function compareVersions(a, b) {
  return semver.compare(a, b);
}
