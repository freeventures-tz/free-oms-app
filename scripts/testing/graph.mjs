/**
 * The import graph of the TypeScript and JavaScript sources, read from the files themselves.
 *
 * It answers one question for the selector: which test files can reach a changed file through
 * imports? Edges come from static imports and re-exports, dynamic imports and requires of a string
 * literal, and Vitest module mocks. Specifiers resolve through the `@/` alias and relative paths.
 * Package imports are not followed: a dependency change is a lockfile change, and that forces full
 * coverage on its own.
 *
 * The scan is textual, so an import written inside a comment or a string also counts. That can only
 * add edges, which selects more, never less; it is the safe direction to be wrong in.
 *
 * What the graph cannot see (SQL called by name, routes a browser visits, files read at run time)
 * is the manifest's job. A source file the graph and the manifest both miss is unmapped, and an
 * unmapped path forces full coverage. A repository import the graph cannot resolve is an edge it
 * cannot follow, so the selector forces full coverage for that too.
 */
import { posix } from "node:path";

const SOURCE = /\.(ts|tsx|mts|mjs|js|jsx)$/;
const RESOLVE_EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".mjs", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"];

const SPECIFIERS = [
  /\bimport\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g,
  /\bexport\s+(?:type\s+)?[^'";]*?\s+from\s+["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bvi\.(?:mock|doMock|importActual)\s*\(\s*["']([^"']+)["']/g,
];

export function isSource(path) {
  return SOURCE.test(path) && !path.endsWith(".d.ts");
}

/** The specifiers a source file names, in order of appearance, without duplicates. */
export function importSpecifiers(text) {
  const found = new Set();
  for (const pattern of SPECIFIERS) {
    for (const match of text.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

/** The repository file a specifier names, or null for a package or a file that does not exist. */
export function resolveSpecifier(from, specifier, files) {
  let base;
  if (specifier.startsWith("@/")) base = specifier.slice(2);
  else if (specifier.startsWith("./") || specifier.startsWith("../")) base = posix.join(posix.dirname(from), specifier);
  else return null;
  for (const extension of RESOLVE_EXTENSIONS) {
    if (files.has(base + extension)) return base + extension;
  }
  // TypeScript lets `./x.js` name `x.ts` or `x.tsx` (and `.mjs` name `.mts`, `.jsx` name `.tsx`).
  const substituted = SUBSTITUTIONS.find(([from]) => base.endsWith(from));
  if (substituted) {
    const stem = base.slice(0, -substituted[0].length);
    for (const extension of substituted[1]) if (files.has(stem + extension)) return stem + extension;
  }
  return null;
}

const SUBSTITUTIONS = [
  [".js", [".ts", ".tsx"]],
  [".jsx", [".tsx"]],
  [".mjs", [".mts"]],
  [".cjs", [".cts"]],
];

/**
 * `readText(path)` returns a file's text. Returns the forward edges and, for each file, the
 * specifiers that looked like repository paths but resolved to nothing.
 */
export function buildGraph(paths, readText) {
  const files = new Set(paths);
  const edges = new Map();
  const unresolved = [];
  for (const path of paths) {
    if (!isSource(path)) continue;
    const targets = new Set();
    for (const specifier of importSpecifiers(readText(path))) {
      const target = resolveSpecifier(path, specifier, files);
      if (target) targets.add(target);
      else if (specifier.startsWith("@/") || specifier.startsWith(".")) unresolved.push({ from: path, specifier });
    }
    edges.set(path, [...targets].sort());
  }
  return { edges, unresolved };
}

/** Every file that reaches one of `changed` through imports, including the changed files themselves. */
export function reverseClosure(edges, changed) {
  const reverse = new Map();
  for (const [from, targets] of edges) {
    for (const target of targets) {
      if (!reverse.has(target)) reverse.set(target, []);
      reverse.get(target).push(from);
    }
  }
  const reached = new Set(changed);
  const queue = [...changed];
  while (queue.length > 0) {
    const next = queue.shift();
    for (const importer of reverse.get(next) ?? []) {
      if (!reached.has(importer)) {
        reached.add(importer);
        queue.push(importer);
      }
    }
  }
  return reached;
}
