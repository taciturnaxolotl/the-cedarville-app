/**
 * Courses that count as each other.
 *
 * Each entering class is locked to a catalog year, so a transcript can carry
 * codes the current catalog has never heard of. Colleague tracks this itself
 * with `EquatedCourseIds`, and publishes it on section records — 902 of Fall
 * 2026's sections declare one — though not on the catalog-search view.
 *
 * The ids arrive in two shapes: numeric Colleague ids, and old-style keys like
 * `ENGR_191` for what is now `EGCP-1010`.
 *
 * What this deliberately does *not* do is infer equivalence from adjacency.
 * `MATH-1720` and `MATH-1715` are both Calculus II and one replaced the other,
 * but they carry 5 and 4 credits and Colleague equates neither to the other.
 * Guessing there would tell a student a requirement is met when it is not.
 */

export interface EquivalenceSource {
  /** The modern course, e.g. "EGCP-1010". */
  code: string;
  /** Colleague ids or old-style keys it declares itself equal to. */
  equatedIds: string[];
}

export type Equivalences = Map<string, Set<string>>;

/** "ENGR_191" is how Colleague writes what the catalog calls ENGR-1910. */
const OLD_KEY = /^([A-Z]{2,5})_(\d{3})$/;

export function buildEquivalences(
  sources: EquivalenceSource[],
  codeForId: (id: string) => string | undefined,
): Equivalences {
  const map: Equivalences = new Map();

  const link = (a: string, b: string) => {
    if (a === b) return;
    for (const [from, to] of [
      [a, b],
      [b, a],
    ] as const) {
      map.set(from, new Set([...(map.get(from) ?? []), to]));
    }
  };

  for (const { code, equatedIds } of sources) {
    for (const raw of equatedIds ?? []) {
      const known = codeForId(String(raw));
      if (known) {
        link(code, known);
        continue;
      }
      const old = OLD_KEY.exec(String(raw));
      if (old) link(code, `${old[1]}-${old[2]}0`);
    }
  }
  return map;
}

/**
 * Every code that counts as this one, including itself.
 *
 * Equivalence is treated as symmetric but not transitive: Colleague states it
 * pairwise, and chaining "A counts as B, B counts as C" across curriculum
 * revisions asserts more than the registrar did.
 */
export function aliasesOf(equivalences: Equivalences, code: string): string[] {
  return [code, ...(equivalences.get(code) ?? [])];
}

/** Has the student passed this course, or anything that counts as it? */
export function satisfiedBy(
  equivalences: Equivalences,
  code: string,
  completed: ReadonlySet<string>,
): boolean {
  return aliasesOf(equivalences, code).some((c) => completed.has(c));
}
