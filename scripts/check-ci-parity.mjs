import { readFileSync } from "node:fs";

// The migration adds a leading comment and changes only the runner labels. Keep everything
// else, including the commands, action revisions and triggers, identical across providers.
const normalize = (source) => source
  .replace(/\r\n/g, "\n")
  .replace(/^(?:[ \t]*(?:#[^\n]*)?\n)+/, "")
  .replace(/^([ \t]*runs-on:[ \t]*)(?:depot-)?ubuntu-latest(?:[ \t]+#.*)?$/gm, "$1ubuntu-latest")
  .trimEnd();

const github = normalize(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
const depot = normalize(readFileSync(new URL("../.depot/workflows/ci.yml", import.meta.url), "utf8"));

if (github !== depot) {
  throw new Error("GitHub and Depot CI workflows differ. Keep jobs, steps and triggers aligned apart from runner labels.");
}

console.log("CI parity: GitHub and Depot workflows match apart from runner labels.");
