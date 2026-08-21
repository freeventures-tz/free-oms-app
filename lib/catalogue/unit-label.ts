/**
 * Which of a counting unit's two labels a reader sees (product.md §6, design.md §8.2).
 *
 * Its own file, and deliberately: `lib/catalogue/catalogue.ts` reaches Supabase on the server, and
 * a client component importing a VALUE from there drags `server-only` into the browser bundle and
 * fails the build. A type import is erased and costs nothing; this is not, so it lives where both
 * sides can reach it.
 *
 * One place, so no screen improvises its own fallback. There is nothing to fall back to: both
 * labels are required at creation, because a unit named only in English is unreadable to half the
 * yard and Part C provides no rename path to fix it later.
 */
export type UnitLabels = { labelEn: string; labelSw: string };

export function unitLabel(unit: UnitLabels, locale: string): string {
  return locale === "sw" ? unit.labelSw : unit.labelEn;
}
