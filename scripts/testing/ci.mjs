#!/usr/bin/env node
/**
 * What CI needs from a plan, as plain values.
 *
 *   node scripts/testing/ci.mjs outputs --plan <plan.json>
 *       prints `name=value` lines for $GITHUB_OUTPUT: which jobs the plan requires, and the E2E
 *       shard numbers as a JSON list for a job matrix
 *   node scripts/testing/ci.mjs shard-files --plan <plan.json> --shard <n>
 *       prints the E2E spec files of one shard, space separated
 *
 * The plan decides; this only reads it. A job the plan does not require is skipped by its `if:`,
 * and the gate accepts that skip only because the same plan says so.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs, readJson } from "./common.mjs";

/** Minutes of specs one E2E shard aims to hold, by the manifest's measured local minutes. */
export const SHARD_TARGET_MINUTES = 12;
/** A spec with no measured time is assumed to be an average one. */
const DEFAULT_MINUTES = 2;

/**
 * Splits spec files into shards of similar weight. Every spec runs on all three projects inside its
 * own shard, mobile first, so the order within a spec is the one the full suite has always used.
 *
 * Deterministic: heaviest first, each into the lightest shard so far, ties to the lower shard and
 * the earlier name. One shard when the work is small, because every shard pays for its own
 * checkout, build and local stack.
 */
/** @param {string[]} files @param {Record<string, number>} [minutes] @param {{ maxShards?: number, targetMinutes?: number }} [options] @returns {string[][]} */
export function partitionShards(files, minutes = {}, { maxShards = 1, targetMinutes = SHARD_TARGET_MINUTES } = {}) {
  const sorted = [...new Set(files)].sort();
  if (sorted.length === 0) return [];
  const weight = (file) => (Number.isFinite(minutes[file]) && minutes[file] > 0 ? minutes[file] : DEFAULT_MINUTES);
  const total = sorted.reduce((sum, file) => sum + weight(file), 0);
  const count = Math.max(1, Math.min(maxShards, sorted.length, Math.ceil(total / targetMinutes)));
  const shards = Array.from({ length: count }, () => ({ files: [], weight: 0 }));
  for (const file of [...sorted].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
    const lightest = shards.reduce((best, shard) => (shard.weight < best.weight ? shard : best), shards[0]);
    lightest.files.push(file);
    lightest.weight += weight(file);
  }
  return shards.map((shard) => shard.files.sort());
}

/** The E2E shards a plan holds. A plan made before shards existed is one shard of everything. */
/** @param {any} plan @returns {string[][]} */
export function planShards(plan) {
  const e2e = plan?.execution?.e2e;
  if (!e2e || e2e.mode === "none" || (e2e.files ?? []).length === 0) return [];
  return Array.isArray(e2e.shards) && e2e.shards.length > 0 ? e2e.shards : [e2e.files];
}

/** @param {any} plan @returns {Record<string, string>} */
export function planOutputs(plan) {
  const jobs = new Set(plan?.expectedJobs ?? []);
  const shards = planShards(plan);
  return {
    lane: String(plan?.lane ?? "critical"),
    database: String(jobs.has("database")),
    integration: String(jobs.has("integration")),
    e2e: String(jobs.has("e2e") && shards.length > 0),
    "e2e-shards": JSON.stringify(shards.map((_, index) => index + 1)),
    "e2e-shard-total": String(shards.length),
  };
}

export function runCiCli(argv) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  if (typeof args.plan !== "string") throw new Error("--plan <plan.json> is required");
  const plan = readJson(args.plan);
  if (command === "outputs") {
    return Object.entries(planOutputs(plan))
      .map(([name, value]) => `${name}=${value}`)
      .join("\n");
  }
  if (command === "shard-files") {
    const shards = planShards(plan);
    const index = Number(args.shard);
    if (!Number.isInteger(index) || index < 1 || index > shards.length) {
      throw new Error(`--shard must be 1 to ${shards.length}, not ${args.shard}`);
    }
    return shards[index - 1].join(" ");
  }
  throw new Error(`unknown command ${command ?? "(none)"}: use outputs or shard-files`);
}

const invokedDirectly = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    console.log(runCiCli(process.argv.slice(2)));
  } catch (error) {
    console.error(`ci plan refused: ${error.message}`);
    process.exit(2);
  }
}
