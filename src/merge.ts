/**
 * Finding where two programs overlap.
 *
 * The useful question is not "which courses appear in both trees" but "which
 * requirement in A draws from the same pool as which requirement in B", since
 * that is the pair a student can satisfy once and count twice. Reporting per
 * course instead buries six real findings under a hundred rows of the same
 * gen-ed elective list.
 */

import type { CatalogCourse, Group, ProgramTree, Requirement } from "./requirements";
import { accepts, enumeratedCourseIds, openGroups } from "./requirements";
import type { CourseRef } from "./types";

export interface Located {
  program: string;
  requirement: string;
  group: Group;
}

/**
 * How much a pair is worth reading, which is not the same as how many courses
 * it shares.
 *
 * "Any 300-level course, 32 credits" overlaps with nearly everything and tells
 * a student nothing; two required-cognate lists overlapping on four courses is
 * the whole reason to double major. Ranking by pool size alone inverts that.
 */
export type Significance =
  /** Both sides require the course outright, so it double-counts by default. */
  | "guaranteed"
  /** At least one side is a choice, so the overlap is an option worth taking. */
  | "elective"
  /** One side accepts almost anything; true, but not a finding. */
  | "catch-all";

export interface SharedPool {
  a: Located;
  b: Located;
  /** Courses that would satisfy both groups. */
  courses: CourseRef[];
  /** Credits each side still wants, when it says. */
  credits: { a?: number; b?: number };
  significance: Significance;
}

/** Why a requirement could not be compared. */
export type Reason =
  /** Eligible courses live in a server-side Colleague rule. */
  | "rule"
  /** Filters on an attribute we hold no data for, currently department. */
  | "missing-attributes";

export interface Unresolved {
  at: Located;
  reason: Reason;
}

export interface MergeResult {
  programs: [string, string];
  /**
   * Only pairs we can affirm. A planner that pads this list with maybes is
   * worse than one that admits a shorter answer.
   */
  shared: SharedPool[];
  /**
   * Requirements that may well overlap but cannot be checked from the data we
   * have. Surfaced for a human rather than guessed at or dropped.
   */
  unresolved: Unresolved[];
  /** Distinct courses that certainly count toward both programs. */
  certainSharedCourses: CourseRef[];
  /**
   * Schools cap how many credits two majors may share, and that policy lives
   * in the academic catalog rather than the API. Pass it to get a verdict.
   */
  sharedCreditCap?: number;
  exceedsCap: boolean;
}

const locate = (program: string, requirement: Requirement, group: Group): Located => ({
  program,
  requirement: requirement.text,
  group,
});

/** Only groups that name their courses can be compared automatically. */
const comparable = (g: Group) =>
  g.constraint.kind === "take-all" ||
  g.constraint.kind === "choose-from" ||
  g.constraint.kind === "filter";

/**
 * A department filter is unanswerable without a subject-to-department map,
 * which no evaluation endpoint returns. Colleague uses it for things like
 * "any 3XXX or 4XXX EG course", where EG spans several subject codes.
 */
function needsAttributesWeLack(g: Group, catalog: CatalogCourse[]): boolean {
  if (g.constraint.kind !== "filter") return false;
  if (g.constraint.departments.length === 0) return false;
  return !catalog.some((c) => c.departments?.length);
}

export function merge(
  a: ProgramTree,
  b: ProgramTree,
  options: { catalog?: CatalogCourse[]; sharedCreditCap?: number } = {},
): MergeResult {
  const catalog = options.catalog ?? [];
  const byId = new Map(catalog.map((c) => [c.Id, c]));
  const enrich = (c: CourseRef): CatalogCourse => byId.get(c.Id) ?? c;

  const left = openGroups(a).map(({ requirement, group }) => locate(a.code, requirement, group));
  const right = openGroups(b).map(({ requirement, group }) => locate(b.code, requirement, group));

  const unresolved: Unresolved[] = [];
  const pairable: Located[][] = [[], []];

  for (const [side, groups] of [left, right].entries()) {
    for (const at of groups) {
      if (at.group.constraint.kind === "rule-based") unresolved.push({ at, reason: "rule" });
      else if (needsAttributesWeLack(at.group, catalog)) {
        unresolved.push({ at, reason: "missing-attributes" });
      } else if (comparable(at.group)) pairable[side]!.push(at);
    }
  }

  const shared: SharedPool[] = [];
  for (const l of pairable[0]!) {
    for (const r of pairable[1]!) {
      const courses = candidates(l.group, r.group, catalog).filter((course) => {
        const enriched = enrich(course);
        return accepts(l.group, enriched) === "yes" && accepts(r.group, enriched) === "yes";
      });

      if (courses.length === 0) continue;
      shared.push({
        a: l,
        b: r,
        courses,
        credits: { a: l.group.min.credits, b: r.group.min.credits },
        significance: significanceOf(l.group, r.group),
      });
    }
  }

  const rank: Record<Significance, number> = { guaranteed: 0, elective: 1, "catch-all": 2 };
  shared.sort(
    (x, y) => rank[x.significance] - rank[y.significance] || y.courses.length - x.courses.length,
  );

  const certainSharedCourses = distinct(shared.flatMap((s) => s.courses));
  const cap = options.sharedCreditCap;

  return {
    programs: [a.code, b.code],
    shared,
    unresolved,
    certainSharedCourses,
    sharedCreditCap: cap,
    exceedsCap: cap !== undefined && certainSharedCourses.length > cap,
  };
}

/**
 * Course pool worth testing against a pair of groups. Enumerated groups bring
 * their own; two filters have to borrow from the catalog, and without one
 * there is nothing honest to say.
 */
function candidates(a: Group, b: Group, catalog: CatalogCourse[]): CourseRef[] {
  const left = coursesOf(a);
  const right = coursesOf(b);

  // Both enumerate: a direct set intersection, and the common case.
  if (left && right) {
    const ids = enumeratedCourseIds(b) ?? new Set<string>();
    return left.filter(
      (c) => ids.has(c.Id) || (c.EquatedCourseIds ?? []).some((id) => ids.has(id)),
    );
  }
  // One enumerates: test its pool against the other's filter.
  // Neither does: only the catalog can say.
  return left ?? right ?? catalog;
}

/**
 * A filter naming no subject and no department is a bucket, not a
 * requirement: Colleague's "Upper-Division Hours" is `FromLevels: ["300",
 * "400"]` and nothing else, so every junior course on earth satisfies it.
 */
const catchAll = (g: Group) =>
  g.constraint.kind === "filter" &&
  g.constraint.subjects.length === 0 &&
  g.constraint.departments.length === 0;

function significanceOf(a: Group, b: Group): Significance {
  if (catchAll(a) || catchAll(b)) return "catch-all";
  if (a.constraint.kind === "take-all" && b.constraint.kind === "take-all") return "guaranteed";
  return "elective";
}

function coursesOf(g: Group): CourseRef[] | null {
  const c = g.constraint;
  return c.kind === "take-all" || c.kind === "choose-from" ? c.courses : null;
}

function distinct(courses: CourseRef[]): CourseRef[] {
  const seen = new Map<string, CourseRef>();
  for (const c of courses) if (!seen.has(c.Id)) seen.set(c.Id, c);
  return [...seen.values()];
}
