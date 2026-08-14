import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import sw from "@/messages/sw.json";

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === "string" ? [path] : flatten(value, path);
  });
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

function entries(tree: Tree, prefix = ""): [string, string][] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === "string"
      ? ([[path, value]] as [string, string][])
      : entries(value, path);
  });
}

/**
 * A missing Swahili key is not a cosmetic gap: it puts an English sentence in front of a
 * Swahili-speaking user, which is the exact failure design.md §8.2 forbids. The build fails here
 * rather than in the yard.
 */
describe("translation dictionaries", () => {
  const enKeys = flatten(en as Tree).sort();
  const swKeys = flatten(sw as Tree).sort();

  it("has the same key set in both languages", () => {
    expect(swKeys).toEqual(enKeys);
  });

  it("uses named placeholders identically, so word order can differ freely", () => {
    const swByKey = new Map(entries(sw as Tree));

    for (const [key, english] of entries(en as Tree)) {
      expect(placeholders(swByKey.get(key) ?? ""), key).toEqual(placeholders(english));
    }
  });

  it("has no empty strings", () => {
    for (const [key, value] of [...entries(en as Tree), ...entries(sw as Tree)]) {
      expect(value.trim().length, key).toBeGreaterThan(0);
    }
  });
});
