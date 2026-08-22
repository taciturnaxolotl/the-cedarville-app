/*
 * The edits a student makes to a generated plan.
 *
 * A projection is a first draft. It knows the catalog and the prerequisites
 * and nothing at all about the summer job, the semester abroad, or the course
 * worth waiting a year to take with the right professor. So the plan is
 * generated, then moved around, and then regenerated with the moves still in
 * place — every other course reflowing around the ones that were pinned down.
 *
 * Three edits cover it, and they are all the same edit underneath: a course
 * is either in a term the student named, or out of the plan entirely.
 *
 *   move    drag a course the plan already placed into another term
 *   insert  drag in a course the plan never asked for
 *   drop    take one out, and see what that costs
 *
 * Kept as one flat record so it survives a reload, and so "regenerate" is
 * nothing more interesting than clearing it.
 */

const KEY = "cedarville:moves";

/** A course marked out of the plan rather than into a term. */
export const OUT = "out";

/** Course code to slot name, or to OUT. */
export type Moves = Record<string, string>;

export interface Edits {
  /** Terms the student named, which the planner honours outright. */
  placements: Map<string, string>;
  /** Courses taken out of the plan. */
  dropped: Set<string>;
}

export function readMoves(): Moves {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "") as Moves;
    // A record read off disk is only as good as what wrote it, and a bad one
    // would put a course in a term named `undefined`.
    return Object.fromEntries(
      Object.entries(stored).filter(
        ([code, at]) => typeof code === "string" && typeof at === "string",
      ),
    );
  } catch {
    return {};
  }
}

export const writeMoves = (moves: Moves) => localStorage.setItem(KEY, JSON.stringify(moves));

export function editsOf(moves: Moves): Edits {
  const placements = new Map<string, string>();
  const dropped = new Set<string>();
  for (const [code, at] of Object.entries(moves)) {
    if (at === OUT) dropped.add(code);
    else placements.set(code, at);
  }
  return { placements, dropped };
}
