import { readFileSync } from "node:fs";

// The migration adds a leading comment and changes only the runner labels. Keep everything
// else, including the commands, action revisions and triggers, identical across providers.
const normalize = (source, expectedRunner) => {
  let runnerCount = 0;
  const normalized = source
    .replace(/\r\n/g, "\n")
    .replace(/^(?:[ \t]*(?:#[^\n]*)?\n)+/, "")
    .replace(/^([ \t]*runs-on:[ \t]*)([^ \t\n#]+)(?:[ \t]+#.*)?$/gm, (line, prefix, runner) => {
      if (runner !== expectedRunner) {
        throw new Error(`Expected runs-on: ${expectedRunner}, found ${line.trim()}`);
      }
      runnerCount += 1;
      return `${prefix}ubuntu-latest`;
    })
    .trimEnd();
  if (runnerCount === 0) {
    throw new Error(`Workflow has no ${expectedRunner} runner labels.`);
  }
  return normalized;
};

const github = normalize(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"), "ubuntu-latest");
const depot = normalize(readFileSync(new URL("../.depot/workflows/ci.yml", import.meta.url), "utf8"), "depot-ubuntu-latest");

if (github !== depot) {
  throw new Error("GitHub and Depot CI workflows differ. Keep jobs, steps and triggers aligned apart from runner labels.");
}

console.log("CI parity: GitHub and Depot workflows match apart from runner labels.");
