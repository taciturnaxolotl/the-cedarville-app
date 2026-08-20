/*
 * How heavy a term the student intends to carry.
 *
 * Every projection rests on this and nothing else decides a graduation date so
 * directly, so it is worth stating rather than assuming. Cedarville's own
 * numbers, from the 2026-27 catalog, page 26:
 *
 *   12      full time; below this a student is part time
 *   15-17   "a normal course load"
 *   17      above this, overblock tuition applies
 *   18.5    the ceiling with advisor approval alone
 *   16      the average needed to finish in eight semesters
 *
 * And a line worth repeating to anyone working their way through: "students
 * working more than 20 hours per week are advised not to carry a full course
 * of studies."
 */

export interface Load {
  /** Credits per autumn and spring term. */
  perTerm: number;
  /** Credits per summer. */
  summer: number;
  /** How many summers to give up. Zero plans none. */
  summers: number;
  /**
   * Hold work back from a summer rather than leave the semester behind it part
   * time. On by default, and worth being able to turn off: a student who has
   * already decided to finish early would rather see the earlier date.
   */
  fullSemesters: boolean;
}

export const FULL_TIME = 12;
export const NORMAL = [15, 17] as const;
export const OVERBLOCK = 17;
export const CEILING = 18.5;

/** Four summers is every one the twelve-term horizon holds. */
export const SUMMERS = 4;

export const DEFAULT_LOAD: Load = {
  perTerm: 15,
  summer: 7,
  summers: SUMMERS,
  fullSemesters: true,
};

const KEY = "cedarville:load";

export function readLoad(): Load {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "") as Partial<Load>;
    return {
      perTerm: clamp(stored.perTerm ?? DEFAULT_LOAD.perTerm, FULL_TIME, CEILING),
      summer: clamp(stored.summer ?? DEFAULT_LOAD.summer, 0, 12),
      // A load saved before summers were countable said only how heavy one
      // was, and zero credits meant none at all.
      summers: clamp(
        stored.summers ?? (stored.summer === 0 ? 0 : DEFAULT_LOAD.summers),
        0,
        SUMMERS,
      ),
      fullSemesters: stored.fullSemesters ?? DEFAULT_LOAD.fullSemesters,
    };
  } catch {
    return DEFAULT_LOAD;
  }
}

export const writeLoad = (load: Load) => localStorage.setItem(KEY, JSON.stringify(load));

const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n));

/** What the school would say about a term of this size. */
export function verdictOf(perTerm: number): { text: string; kind: string } {
  if (perTerm < FULL_TIME) {
    return { text: "part time", kind: "bad" };
  }
  if (perTerm > OVERBLOCK) {
    return { text: "overblock tuition", kind: "bad" };
  }
  if (perTerm < NORMAL[0]) {
    return { text: "full time, under a normal load", kind: "cheap" };
  }
  return { text: "a normal load", kind: "free" };
}
