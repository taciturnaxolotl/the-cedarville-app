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
  /** Credits per summer. Zero means no summers at all. */
  summer: number;
}

export const FULL_TIME = 12;
export const NORMAL = [15, 17] as const;
export const OVERBLOCK = 17;
export const CEILING = 18.5;

export const DEFAULT_LOAD: Load = { perTerm: 15, summer: 7 };

const KEY = "cedarville:load";

export function readLoad(): Load {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "") as Partial<Load>;
    return {
      perTerm: clamp(stored.perTerm ?? DEFAULT_LOAD.perTerm, FULL_TIME, CEILING),
      summer: clamp(stored.summer ?? DEFAULT_LOAD.summer, 0, 12),
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
