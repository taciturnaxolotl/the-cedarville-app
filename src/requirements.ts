/**
 * A normalized view of a Colleague program evaluation.
 *
 * Ellucian's raw Group is a bag of ~40 nullable fields that together encode
 * one of four quite different ideas. Collapsing them into a tagged union up
 * front is what lets the planner reason about "can one course satisfy this
 * group in major A *and* that group in major B" without re-deriving intent
 * at every call site.
 */

import type {
  AppliedCredit,
  CourseRef,
  EvaluationResponse,
  RawGroup,
  RawRequirement,
  RawSubrequirement,
} from "./types";

/**
 * Colleague tracks completion and planning independently, and the pair is
 * more informative than either half. "Partly done and the rest is planned"
 * is a different situation from "partly done and the rest is a gap"; a
 * single flattened status cannot say which.
 *
 * Observed values, from real BS.CYOPR and BS.CMPEG evaluations.
 */
export type Completion = "Completed" | "PartiallyCompleted" | "NotStarted" | "Unknown";
export type Planning = "CompletelyPlanned" | "PartiallyPlanned" | "NotPlanned" | "Unknown";

export interface Progress {
  completion: Completion;
  planning: Planning;
}

/** Set of courses a group will accept, expressed the way Colleague expressed it. */
export type Constraint =
  /** Take every one of these. */
  | { kind: "take-all"; courses: CourseRef[] }
  /** Take some number from this enumerated pool. The swappable elective. */
  | { kind: "choose-from"; courses: CourseRef[] }
  /** Take some number matching these attributes. The open elective. */
  | { kind: "filter"; subjects: string[]; departments: string[]; levels: string[] }
  /**
   * Real work, but Colleague describes the eligible courses only through an
   * opaque rule ("one laboratory course from the biological sciences"). The
   * server can evaluate it; we cannot enumerate it. Never drop these.
   */
  | { kind: "rule-based"; ruleIds: string[] }
  /** Genuinely prose. No courses, no credits, no rule. */
  | { kind: "print-only" };

export interface Thresholds {
  courses?: number;
  credits?: number;
  creditsPerCourse?: number;
  subjects?: number;
  departments?: number;
}

export interface Group {
  id: string;
  code: string;
  /**
   * Where this group sits in the catalog. Together these address it in the
   * course search, which is the only way to learn what a rule-based or
   * attribute-filtered group will actually accept.
   */
  requirementCode: string;
  subrequirementId: string;
  /** Ellucian's own rendering. Always show this when `unverifiable`. */
  text: string;
  status: Progress;
  constraint: Constraint;
  min: Thresholds;
  max: Thresholds;
  exclude: { courseIds: string[]; subjects: string[]; levels: string[] };
  /** Credits already counting toward this group. */
  applied: AppliedCredit[];
  /** Colleague's own gap list. */
  needed: CourseRef[];
  /**
   * The group carries opaque Colleague rule ids that only the server can
   * evaluate. We cannot decide satisfaction locally; render `text` and defer.
   */
  unverifiable: boolean;
}

export interface Subrequirement {
  id: string;
  code: string;
  text: string;
  status: Progress;
  /** Satisfy this many of `groups`; null means all of them. */
  minGroups: number | null;
  groups: Group[];
}

export interface Requirement {
  id: string;
  code: string;
  text: string;
  status: Progress;
  /** Satisfy this many of `subrequirements`; null means all of them. */
  minSubrequirements: number | null;
  subrequirements: Subrequirement[];
}

export interface ProgramTree {
  studentId: string;
  code: string;
  title: string;
  catalog: string;
  degree: string;
  credits: { minimum: number; completed: number; inProgress: number; planned: number };
  requirements: Requirement[];
}

// ---- normalization -----------------------------------------------------

const list = <T>(v: T[] | null | undefined): T[] => v ?? [];

/** Colleague sends CamelCase enum names; compare on letters alone. */
const token = (s: string) => (s ?? "").toLowerCase().replace(/[^a-z]/g, "");

/**
 * Matched exactly, never by substring: "PartiallyCompleted" contains
 * "Completed" and "NotPlanned" contains "Planned", so `includes` reports
 * unfinished work as finished.
 */
function progress(completion: string, planning: string): Progress {
  const done = token(completion);
  const plan = token(planning);
  return {
    completion:
      done === "completed" || done === "waived"
        ? "Completed"
        : done === "partiallycompleted"
          ? "PartiallyCompleted"
          : done === "notstarted"
            ? "NotStarted"
            : "Unknown",
    planning:
      plan === "completelyplanned" || plan === "planned"
        ? "CompletelyPlanned"
        : plan === "partiallyplanned"
          ? "PartiallyPlanned"
          : plan === "notplanned"
            ? "NotPlanned"
            : "Unknown",
  };
}

function constraintOf(g: RawGroup, min: Thresholds): Constraint {
  if (g.OnlyConveysPrintText) return { kind: "print-only" };

  const take = list(g.Courses);
  if (take.length > 0) return { kind: "take-all", courses: take };

  const pool = list(g.FromCourses);
  if (pool.length > 0) return { kind: "choose-from", courses: pool };

  const subjects = list(g.FromSubjects).map((s) => s.Code);
  const departments = list(g.FromDepartments).map((d) => d.Code);
  const levels = list(g.FromLevels);
  if (subjects.length || departments.length || levels.length) {
    return { kind: "filter", subjects, departments, levels };
  }

  // Nothing enumerable. If it still asks for credits or carries a rule, it is
  // a requirement we must show rather than a heading we may drop.
  const rules = list(g.AcademicCreditRules);
  if (rules.length > 0 || g.HasRules || Object.keys(min).length > 0) {
    return { kind: "rule-based", ruleIds: rules };
  }

  return { kind: "print-only" };
}

/** Drops nulls so `min.credits ?? fallback` reads correctly downstream. */
function defined(t: Record<string, number | null>): Thresholds {
  return Object.fromEntries(Object.entries(t).filter(([, v]) => v !== null));
}

const minima = (g: RawGroup): Thresholds =>
  defined({
    courses: g.MinCourses,
    credits: g.MinCredits,
    creditsPerCourse: g.MinCreditsPerCourse,
    subjects: g.MinSubjects,
    departments: g.MinDepartments,
  });

const maxima = (g: RawGroup): Thresholds =>
  defined({
    courses: g.MaxCourses,
    credits: g.MaxCredits,
    creditsPerCourse: g.MaxCreditsPerCourse,
  });

function normalizeGroup(g: RawGroup): Group {
  const min = minima(g);
  return {
    id: g.Id,
    code: g.Code,
    requirementCode: g.RequirementCode ?? "",
    subrequirementId: g.SubrequirementId ?? "",
    text: g.DisplayText,
    status: progress(g.CompletionStatus, g.PlanningStatus),
    constraint: constraintOf(g, min),
    min,
    max: maxima(g),
    exclude: {
      courseIds: list(g.ButNotCourses).map((c) => c.Id),
      subjects: list(g.ButNotSubjects).map((s) => s.Code),
      levels: list(g.ButNotCourseLevels),
    },
    applied: list(g.AppliedAcademicCredits),
    needed: list(g.CoursesThatNeedPlanned),
    // A rule attached to an enumerated course list still narrows that list in
    // ways we cannot see, so flag it regardless of constraint kind.
    unverifiable: g.HasRules || list(g.AcademicCreditRules).length > 0,
  };
}

function normalizeSubrequirement(s: RawSubrequirement): Subrequirement {
  return {
    id: s.Id,
    code: s.Code,
    text: s.DisplayText,
    status: progress(s.CompletionStatus, s.PlanningStatus),
    minGroups: s.MinGroups,
    groups: list(s.Groups).map(normalizeGroup),
  };
}

function normalizeRequirement(r: RawRequirement): Requirement {
  return {
    id: r.Id,
    code: r.Code,
    text: r.Description,
    status: progress(r.CompletionStatus, r.PlanningStatus),
    minSubrequirements: r.MinSubrequirements,
    subrequirements: list(r.Subrequirements).map(normalizeSubrequirement),
  };
}

export function normalize(res: EvaluationResponse): ProgramTree {
  const p = res.Program;
  return {
    studentId: res.StudentId,
    code: p.Code,
    title: p.Title,
    catalog: p.Catalog,
    degree: p.Degree,
    credits: {
      minimum: p.MinimumCredits,
      completed: p.CompletedCredits,
      inProgress: p.InProgressCredits,
      planned: p.PlannedCredits,
    },
    requirements: list(p.Requirements).map(normalizeRequirement),
  };
}

// ---- querying ----------------------------------------------------------

export function* walkGroups(
  tree: ProgramTree,
): Generator<{ requirement: Requirement; subrequirement: Subrequirement; group: Group }> {
  for (const requirement of tree.requirements) {
    for (const subrequirement of requirement.subrequirements) {
      for (const group of subrequirement.groups) {
        yield { requirement, subrequirement, group };
      }
    }
  }
}

/**
 * Groups still needing courses. The planner's worklist.
 *
 * PartiallyCompleted stays in: half a requirement is not a finished one.
 */
export function openGroups(tree: ProgramTree) {
  return [...walkGroups(tree)].filter(
    ({ group }) =>
      group.constraint.kind !== "print-only" && group.status.completion !== "Completed",
  );
}

/**
 * Open groups with nothing on the degree plan covering the remainder. This
 * is the list a student actually needs to act on, and the reason completion
 * and planning are kept as separate axes.
 */
export function gaps(tree: ProgramTree) {
  return openGroups(tree).filter(({ group }) => group.status.planning !== "CompletelyPlanned");
}

/** Every course id a group would accept, when the group enumerates them. */
export function enumeratedCourseIds(group: Group): Set<string> | null {
  const c = group.constraint;
  if (c.kind !== "take-all" && c.kind !== "choose-from") return null;
  const ids = new Set<string>();
  for (const course of c.courses) {
    if (group.exclude.courseIds.includes(course.Id)) continue;
    ids.add(course.Id);
    // An equated course substitutes for the listed one, so it satisfies too.
    for (const eq of course.EquatedCourseIds ?? []) ids.add(eq);
  }
  return ids;
}

/**
 * A course carrying the attributes only the catalog knows. `CourseRef` as
 * returned inside an evaluation has neither level nor department.
 */
export interface CatalogCourse extends CourseRef {
  levels?: string[];
  departments?: string[];
}

/**
 * Colleague states levels as "100".."400" and Cedarville numbers courses with
 * four digits, so LIT-2300 sits at level "200". Two catalog entries (PROF, an
 * HS placeholder) carry no number and therefore no level.
 */
export function levelOf(course: CourseRef): string | undefined {
  const digits = /^(\d)\d{3}$/.exec(course.Number);
  return digits ? `${digits[1]}00` : undefined;
}

const levelsOf = (course: CatalogCourse): string[] | undefined => {
  if (course.levels?.length) return course.levels;
  const derived = levelOf(course);
  return derived ? [derived] : undefined;
};

/**
 * Tri-state on purpose. A filter group can key off attributes we have not
 * loaded, and answering "no" there would silently hide valid options while
 * answering "yes" would invent them. Surface the doubt instead.
 */
export type Acceptance = "yes" | "no" | "unknown";

export function accepts(group: Group, course: CatalogCourse): Acceptance {
  const levels = levelsOf(course);

  if (group.exclude.courseIds.includes(course.Id)) return "no";
  if (group.exclude.subjects.includes(course.SubjectCode)) return "no";
  if (levels?.some((l) => group.exclude.levels.includes(l))) return "no";

  const enumerated = enumeratedCourseIds(group);
  if (enumerated) {
    const listed =
      enumerated.has(course.Id) || (course.EquatedCourseIds ?? []).some((id) => enumerated.has(id));
    if (!listed) return "no";
    return group.unverifiable ? "unknown" : "yes";
  }

  const c = group.constraint;
  // Only the server can expand a rule, so every course is a maybe.
  if (c.kind === "rule-based") return "unknown";
  if (c.kind !== "filter") return "no";
  if (c.subjects.length && !c.subjects.includes(course.SubjectCode)) return "no";
  if (c.levels.length) {
    if (!levels) return "unknown";
    if (!levels.some((l) => c.levels.includes(l))) return "no";
  }
  if (c.departments.length) {
    if (!course.departments) return "unknown";
    if (!course.departments.some((d) => c.departments.includes(d))) return "no";
  }
  return group.unverifiable ? "unknown" : "yes";
}

/**
 * Course names the student has actually finished, e.g. "CS-1220".
 *
 * Colleague reports these per group rather than as a transcript, so the same
 * course appears under every requirement it counts toward; the Set collapses
 * that. In-progress credit is excluded on purpose: a prerequisite is not met
 * until it is passed.
 */
export function completedCourses(tree: ProgramTree): Set<string> {
  const done = new Set<string>();
  for (const { group } of walkGroups(tree)) {
    for (const credit of group.applied) {
      if (credit.IsCompletedCredit && !credit.IsWithdrawn) done.add(credit.CourseName);
    }
  }
  return done;
}

/** Courses the student is enrolled in now, which satisfy a corequisite. */
export function inProgressCourses(tree: ProgramTree): Set<string> {
  const now = new Set<string>();
  for (const { group } of walkGroups(tree)) {
    for (const credit of group.applied) {
      if (!credit.IsCompletedCredit && !credit.IsWithdrawn) now.add(credit.CourseName);
    }
  }
  return now;
}

// ---- what a student actually still owes --------------------------------

/**
 * Colleague expresses choice with two counts: a requirement may ask for only
 * `minSubrequirements` of its subrequirements, and a subrequirement for only
 * `minGroups` of its groups. That is how tracks, concentrations and
 * "satisfy the global-awareness rule any one of six ways" are encoded.
 *
 * Ignoring those counts makes every alternative look mandatory, which is both
 * wrong and program-specific — it was why a plan could demand Greek *and*
 * Spanish, and why filtering by track name ever seemed necessary.
 */
export interface NeedOptions {
  /** Credits for a course; used to pick the cheapest way to satisfy a choice. */
  credits: (code: string) => number;
  /** Courses already passed or under way. */
  have: ReadonlySet<string>;
}

export interface Unenumerable {
  requirement: string;
  text: string;
  credits?: number;
  /**
   * A bucket rather than a shopping list: "32 hours of upper-division work"
   * names no subject or department, so nearly the whole catalog qualifies and
   * it is satisfied incidentally by the courses a degree already requires.
   * Expanding one and filling it cheapest-first produces thirty-two 1-credit
   * independent studies, which is arithmetically valid and obvious nonsense.
   */
  bucket: boolean;
  /** Coordinates for `POST /rules/resolve`, which asks Colleague directly. */
  ids: { requirement: string; subrequirement: string; group: string };
  /** Filled in once the server expands the group. */
  resolved?: string[];
}

export interface Needed {
  /** Courses to take, from the cheapest satisfying path through the tree. */
  courses: Set<string>;
  /**
   * Groups the evaluation will not enumerate: a Colleague rule, or a filter
   * over attributes it does not carry. Real work, and resolvable — each one
   * carries the ids the course search needs to expand it.
   */
  unenumerable: Unenumerable[];
}

/** Remaining credits if this group were chosen. Cheaper is preferred. */
function groupCost(group: Group, options: NeedOptions): number {
  if (group.status.completion === "Completed") return 0;
  const c = group.constraint;

  if (c.kind === "take-all") {
    return c.courses
      .filter((x) => !options.have.has(x.CourseName))
      .reduce((n, x) => n + options.credits(x.CourseName), 0);
  }
  if (c.kind === "choose-from")
    return group.min.credits ?? options.credits(c.courses[0]?.CourseName ?? "");
  if (c.kind === "print-only") return 0;
  // A rule or filter: we know the credits it wants, not the courses.
  return group.min.credits ?? 3;
}

function coursesForGroup(group: Group, options: NeedOptions): string[] {
  const c = group.constraint;
  if (c.kind === "take-all") return c.courses.map((x) => x.CourseName);

  if (c.kind === "choose-from") {
    // Cheapest first until the minimum is met; anything already done is free.
    let want = group.min.credits ?? options.credits(c.courses[0]?.CourseName ?? "");
    const picked: string[] = [];
    const pool = [...c.courses].sort(
      (a, b) =>
        Number(options.have.has(b.CourseName)) - Number(options.have.has(a.CourseName)) ||
        options.credits(a.CourseName) - options.credits(b.CourseName),
    );
    for (const x of pool) {
      if (want <= 0) break;
      picked.push(x.CourseName);
      want -= options.credits(x.CourseName);
    }
    return picked;
  }
  return [];
}

/**
 * The cheapest set of courses that still satisfies a program.
 *
 * Program-agnostic on purpose: it reads the counts Colleague publishes rather
 * than knowing anything about a particular major's tracks.
 */
export function coursesNeeded(tree: ProgramTree, options: NeedOptions): Needed {
  const courses = new Set<string>();
  const unenumerable: Needed["unenumerable"] = [];

  for (const requirement of tree.requirements) {
    const subs = [...requirement.subrequirements];
    // "Any one of these six" — take the cheapest, not all six.
    const wantSubs = requirement.minSubrequirements ?? subs.length;
    const chosenSubs = subs
      .map((sub) => ({
        sub,
        cost: sub.groups.reduce((n, g) => n + groupCost(g, options), 0),
        done: sub.status.completion === "Completed",
      }))
      .sort((a, b) => Number(b.done) - Number(a.done) || a.cost - b.cost)
      .slice(0, Math.max(wantSubs, 0))
      .map((x) => x.sub);

    for (const sub of chosenSubs) {
      const wantGroups = sub.minGroups ?? sub.groups.length;
      const chosenGroups = [...sub.groups]
        .map((group) => ({
          group,
          cost: groupCost(group, options),
          done: group.status.completion === "Completed",
        }))
        .sort((a, b) => Number(b.done) - Number(a.done) || a.cost - b.cost)
        .slice(0, Math.max(wantGroups, 0))
        .map((x) => x.group);

      for (const group of chosenGroups) {
        if (group.status.completion === "Completed") continue;
        const kind = group.constraint.kind;

        if (kind === "rule-based" || kind === "filter") {
          const c = group.constraint;
          const bucket =
            c.kind === "filter" && c.subjects.length === 0 && c.departments.length === 0;
          unenumerable.push({
            requirement: requirement.text,
            // Colleague leaves DisplayText empty on some groups, and "Group 1"
            // tells a student nothing that the requirement's name does not.
            text: group.text || requirement.text || group.code,
            bucket,
            ...(group.min.credits !== undefined ? { credits: group.min.credits } : {}),
            ids: {
              requirement: group.requirementCode,
              subrequirement: group.subrequirementId,
              group: group.id,
            },
          });
          continue;
        }
        for (const code of coursesForGroup(group, options)) {
          if (!options.have.has(code)) courses.add(code);
        }
      }
    }
  }
  return { courses, unenumerable };
}
