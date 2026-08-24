/**
 * Putting the projection back into Colleague's own degree plan.
 *
 * Everything else in this project reads. This is the one thing that writes,
 * and it writes to the registrar's system, where an advisor will see it. So
 * the rule it works by is worth stating at the top: the plan on the screen is
 * the plan, and Colleague's copy is made to match it — adding, moving and
 * withdrawing as that takes. Two things are never touched, and between them
 * they are the whole safety of it: a course that carries a section, because
 * that is a registration decision rather than a plan, and anything in a term
 * that has already begun.
 *
 * Self-Service's own Plan & Schedule page drives these endpoints, and its
 * script bundle names their arguments exactly:
 *
 *   POST /Student/Planning/DegreePlans/AddCourse
 *        { courseId, termId, credits, degreePlan }
 *   POST /Student/Planning/DegreePlans/UpdateCourse
 *        { courseId, oldTerm, newTerm, degreePlan }
 *   POST /Student/Planning/DegreePlans/RemoveCourse
 *        { removeCourseId, removeCourseTermId, removeCourseSectionId, degreePlan }
 *   POST /Student/Planning/DegreePlans/AddTerm     { addTermId, degreePlan }
 *   POST /Student/Planning/DegreePlans/RemoveTerm  { removeTermId, degreePlan }
 *
 * Every one carries the whole plan back with it and returns the updated copy,
 * which is Ellucian's concurrency check: the DTO holds a Version, and a stale
 * one is refused. So the calls run in sequence, each fed the plan the last one
 * handed back, and never in parallel.
 *
 * `RegisterSections` sits on the same controller and is deliberately not
 * wired to anything. Planning a course and registering for it are different
 * promises, and only one of them is ours to make.
 */

import { termKey } from "./catalog";

/** A course as Colleague has it on the plan. */
export interface PlannedCourse {
  /** Colleague's numeric course id, which is what the endpoints want. */
  courseId: string;
  /** "2027SP". */
  termId: string;
  credits: number | null;
  /** Set once a section is chosen, and the mark of work we must not touch. */
  sectionId: string | null;
  isProtected?: boolean;
}

/** A course the projection wants in a term, one entry per sitting. */
export interface Sitting {
  /** "HON-3020", for saying what happened in words a student recognises. */
  code: string;
  courseId: string;
  termId: string;
  credits: number;
}

export type Change =
  /** Open a term on the plan. Colleague will not hold a course in a term the plan has not got. */
  | { kind: "term"; termId: string }
  | { kind: "add"; code: string; courseId: string; termId: string; credits: number }
  | { kind: "move"; code: string; courseId: string; from: string; to: string }
  | { kind: "remove"; code: string; courseId: string; termId: string; sectionId: string | null };

/** Something the projection wanted and this will not do, with the reason. */
export interface Skipped {
  code?: string;
  termId?: string;
  why: string;
}

export interface SyncRequest {
  /** What the projection wants, sittings expanded. */
  wanted: readonly Sitting[];
  /** What Colleague has planned now. */
  planned: readonly PlannedCourse[];
  /** Terms already on the plan. */
  terms: readonly string[];
  /** Terms Colleague would let us open, from `UnplannedTerms`. */
  addable: readonly string[];
  /**
   * The first term the projection covers.
   *
   * Everything before it is the term under way and the ones behind it, which
   * are history however they are stored, and which this never touches. It is
   * the difference between a plan that mirrors and a plan that vandalises: a
   * course in progress is on the degree plan too, and it is not ours to
   * withdraw because a projection starting next spring did not mention it.
   */
  from: string;
}

export const mark = (courseId: string, termId: string) => `${courseId}@${termId}`;

export interface SyncPlan {
  changes: Change[];
  skipped: Skipped[];
}

/**
 * What it would take to make Colleague's plan agree with this one.
 *
 * Pure, so the dry run and the real thing are the same computation: what a
 * student is shown before confirming is exactly what gets sent.
 */
export function syncPlan(request: SyncRequest): SyncPlan {
  const { wanted, planned, terms, addable, from } = request;
  /** Ours to arrange: within the horizon, unregistered, unprotected. */
  const arrangeable = (course: PlannedCourse) =>
    termKey(course.termId) >= termKey(from) && !course.sectionId && !course.isProtected;
  const changes: Change[] = [];
  const skipped: Skipped[] = [];

  // Colleague holds a course once per term, so a plan wanting two sittings of
  // one course in one term cannot be expressed there whatever we do.
  const seen = new Set<string>();
  const asked: Sitting[] = [];
  for (const sitting of wanted) {
    const key = mark(sitting.courseId, sitting.termId);
    if (seen.has(key)) {
      skipped.push({
        code: sitting.code,
        termId: sitting.termId,
        why: "Colleague plans a course once per term, so the second sitting needs another term",
      });
      continue;
    }
    seen.add(key);
    asked.push(sitting);
  }

  /** Colleague's entries by course, so the sittings of one course match up. */
  const held = new Map<string, PlannedCourse[]>();
  for (const course of planned) {
    held.set(course.courseId, [...(held.get(course.courseId) ?? []), course]);
  }
  const matched = new Set<PlannedCourse>();

  const opened = new Set(terms);
  /** Nothing lands in a term the plan has not got; open it first, once. */
  const openTerm = (termId: string): boolean => {
    if (opened.has(termId)) return true;
    if (!addable.includes(termId)) return false;
    changes.push({ kind: "term", termId });
    opened.add(termId);
    return true;
  };

  const moves: Change[] = [];
  const adds: Change[] = [];

  for (const sitting of asked) {
    const entries = held.get(sitting.courseId) ?? [];

    const here = entries.find((c) => !matched.has(c) && c.termId === sitting.termId);
    if (here) {
      matched.add(here);
      continue;
    }

    // Elsewhere on the plan, and ours to carry: the plan on this screen is the
    // plan, and Colleague's copy is made to match it.
    const elsewhere = entries.find((c) => !matched.has(c) && arrangeable(c));
    if (elsewhere) {
      matched.add(elsewhere);
      if (!openTerm(sitting.termId)) {
        skipped.push({
          code: sitting.code,
          termId: sitting.termId,
          why: `Colleague has no ${sitting.termId} to plan into`,
        });
        continue;
      }
      moves.push({
        kind: "move",
        code: sitting.code,
        courseId: sitting.courseId,
        from: elsewhere.termId,
        to: sitting.termId,
      });
      continue;
    }

    // Registered or protected, and so not ours to say anything about.
    const fixed = entries.find((c) => !matched.has(c));
    if (fixed) {
      matched.add(fixed);
      skipped.push({
        code: sitting.code,
        termId: sitting.termId,
        why: fixed.sectionId
          ? `you have a section of this in ${fixed.termId}`
          : `${fixed.termId} is protected on your plan`,
      });
      continue;
    }

    if (!openTerm(sitting.termId)) {
      skipped.push({
        code: sitting.code,
        termId: sitting.termId,
        why: `Colleague has no ${sitting.termId} to plan into`,
      });
      continue;
    }
    adds.push({
      kind: "add",
      code: sitting.code,
      courseId: sitting.courseId,
      termId: sitting.termId,
      credits: sitting.credits,
    });
  }

  // Anything planned that this plan does not call for. A course with a section
  // is never withdrawn, whoever planned it: that is a registration decision
  // wearing a plan's clothes. Nor is anything in a term already under way.
  const removals: Change[] = [];
  for (const course of planned) {
    if (matched.has(course)) continue;
    if (!arrangeable(course)) continue;
    removals.push({
      kind: "remove",
      code: course.courseId,
      courseId: course.courseId,
      termId: course.termId,
      sectionId: course.sectionId,
    });
  }

  // Terms first, because nothing lands without them. Removals last, so a run
  // that fails halfway has added rather than taken away.
  changes.push(...moves, ...adds, ...removals);
  return { changes, skipped };
}

/** What a change says to a student, in one line. */
export function describe(change: Change): string {
  switch (change.kind) {
    case "term":
      return `open ${change.termId} on your plan`;
    case "add":
      return `plan ${change.code} in ${change.termId}`;
    case "move":
      return `move ${change.code} from ${change.from} to ${change.to}`;
    case "remove":
      return `take ${change.code} out of ${change.termId}`;
  }
}
