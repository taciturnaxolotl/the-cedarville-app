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
  /**
   * The majors and minors this one enrolment covers, named the way a student
   * would name them. One program code routinely carries several: a cyber
   * operations major and the honors program arrive as a single BS.CYOPR.
   */
  majors: string[];
  minors: string[];
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
    majors: list(p.Majors),
    minors: list(p.Minors),
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
 * How much of a group is already paid for by coursework taken for other reasons.
 *
 * The 32-credit upper-division requirement is the case worth naming. It names
 * no subject and no department, so nearly the whole catalog qualifies and
 * shopping for it would fill a plan with one-credit independent studies. It
 * does not need shopping for: a degree's own 3000- and 4000-level courses
 * cover it several times over. But "satisfied incidentally" is an assertion,
 * and this turns it into a count.
 *
 * Courses the group merely *might* accept are reported apart from the ones it
 * certainly accepts, so a claim of satisfaction never rests on a maybe.
 */
export function groupCoverage(
  group: Group,
  courses: Iterable<CatalogCourse>,
  credits: (code: string) => number,
): { credits: number; unsure: number; courses: string[] } {
  let sure = 0;
  let unsure = 0;
  const named: string[] = [];
  for (const course of courses) {
    const verdict = accepts(group, course);
    if (verdict === "no") continue;
    if (verdict === "unknown") {
      unsure += credits(course.CourseName);
      continue;
    }
    sure += credits(course.CourseName);
    named.push(course.CourseName);
  }
  return { credits: sure, unsure, courses: named };
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

/**
 * Credits earned above what the requirements they fill actually asked for.
 *
 * A requirement states a size — "One approved quantitative course (3 credit
 * hours)" — and a student fills it with whatever course qualifies. Those
 * rarely match. `MATH-1705` is four credits into that three-credit slot, and
 * `HON-1010` is five into a three-credit humanities slot.
 *
 * The extra credit is real, earned, and counts toward the degree total, but
 * the catalog's arithmetic never sees it: the printed summary adds up slot
 * sizes, not the transcript. So a plan can finish every requirement and still
 * land above the stated total by exactly this much, without a single credit
 * having been scheduled twice.
 */
export function creditOverflow(tree: ProgramTree): number {
  let over = 0;
  for (const { group } of walkGroups(tree)) {
    const min = group.min.credits ?? 0;
    if (!min) continue;
    const applied = group.applied
      .filter((c) => !c.IsWithdrawn)
      .reduce((n, c) => n + (c.Credit ?? 0), 0);
    if (applied > min) over += applied - min;
  }
  return over;
}

/** A course the evaluation applies to more than one requirement at once. */
export interface SharedCourse {
  course: string;
  credits: number;
  /** Requirement codes it counts toward, in the order Colleague listed them. */
  requirements: string[];
}

/**
 * Courses Colleague is already counting twice.
 *
 * The printed catalog footnotes this on only a handful of programs, and cyber
 * operations is not one of them — but the evaluation gives it away for free.
 * A course that pays for two requirements simply appears under both, so
 * `PHYS-2110` shows up in general education and in the major, once each.
 *
 * The catch is that this only ever describes coursework already done. Nothing
 * says which of the courses still ahead will land in two places, so this
 * measures the past rather than predicting the future.
 */
export function sharedCredits(tree: ProgramTree): SharedCourse[] {
  const seen = new Map<string, SharedCourse>();
  for (const { requirement, group } of walkGroups(tree)) {
    for (const credit of group.applied) {
      if (credit.IsWithdrawn) continue;
      const entry = seen.get(credit.CourseName) ?? {
        course: credit.CourseName,
        credits: credit.Credit ?? 0,
        requirements: [],
      };
      if (!entry.requirements.includes(requirement.code)) entry.requirements.push(requirement.code);
      seen.set(credit.CourseName, entry);
    }
  }
  return [...seen.values()].filter((s) => s.requirements.length > 1);
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
  /**
   * Course lists for groups the evaluation would not enumerate, keyed
   * `requirement/subrequirement/group`.
   *
   * Colleague will expand its own rules on request, so a second pass can hand
   * them back here. That matters beyond filling the group in: once a rule's
   * pool is known it joins the same cover as everything else, and a course
   * bought for one requirement can pay for a rule-based one too.
   */
  resolved?: ReadonlyMap<string, readonly string[]>;
  /**
   * Tracks and concentrations the student has decided on, keyed by
   * `branchKey`. Absent means the solver picks the cheapest, which is a
   * sensible default and a poor decision to make silently.
   */
  tracks?: ReadonlyMap<string, readonly string[]>;
  /**
   * Courses the student has decided to take, entering the cover as if already
   * bought. Everything they satisfy then comes free, which is what lets the
   * cost of a choice be measured: solve without the pin, solve with it, and
   * the difference is what that choice actually costs.
   */
  pinned?: ReadonlySet<string>;
}

/** How a resolved group is addressed in `NeedOptions.resolved`. */
export const groupKey = (ids: Unenumerable["ids"]) =>
  `${ids.requirement}/${ids.subrequirement}/${ids.group}`;

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

/**
 * Remaining credits if this group were chosen. Cheaper is preferred.
 *
 * `free` is everything the plan is already committed to buying, and it is what
 * makes the comparison honest. Computer engineering offers a choice between a
 * twelve-hour concentration and twelve hours of technical electives; priced by
 * their stated sizes those tie at twelve apiece, and the tie breaks on
 * whichever Colleague happened to list first. Priced against the plan, the
 * technical electives cost nothing at all — every course that qualifies is one
 * the major already requires — and the concentration costs a real twelve.
 */
function groupCost(group: Group, options: NeedOptions, free: ReadonlySet<string>): number {
  if (group.status.completion === "Completed") return 0;
  const c = group.constraint;

  if (c.kind === "take-all") {
    return c.courses
      .filter((x) => !options.have.has(x.CourseName) && !free.has(x.CourseName))
      .reduce((n, x) => n + options.credits(x.CourseName), 0);
  }
  if (c.kind === "print-only") return 0;

  const want =
    c.kind === "choose-from"
      ? (group.min.credits ?? options.credits(c.courses[0]?.CourseName ?? ""))
      : // A rule or filter: we know the credits it wants, not the courses.
        (group.min.credits ?? 3);

  const pool =
    c.kind === "choose-from"
      ? c.courses.map((x) => x.CourseName)
      : (options.resolved?.get(
          groupKey({
            requirement: group.requirementCode,
            subrequirement: group.subrequirementId,
            group: group.id,
          }),
        ) ?? []);

  // Credits this group can draw from courses the plan is buying anyway.
  const covered = pool
    .filter((code) => options.have.has(code) || free.has(code))
    .reduce((n, code) => n + options.credits(code), 0);
  return Math.max(0, want - covered);
}

/**
 * Courses the plan owes no matter which branches are taken.
 *
 * Only unconditional groups count: a take-all sitting inside a requirement
 * that picks one subrequirement of six is not owed until that branch wins, and
 * treating it as free would make every rival branch look cheaper than it is.
 */
function committed(tree: ProgramTree, options: NeedOptions): Set<string> {
  const core = new Set<string>();
  for (const requirement of tree.requirements) {
    if (requirement.minSubrequirements !== null) continue;
    for (const sub of requirement.subrequirements) {
      if (sub.minGroups !== null) continue;
      for (const group of sub.groups) {
        if (group.status.completion === "Completed") continue;
        if (group.constraint.kind !== "take-all") continue;
        for (const x of group.constraint.courses) {
          if (!options.have.has(x.CourseName)) core.add(x.CourseName);
        }
      }
    }
  }
  return core;
}

/**
 * A track, concentration or specialization: pick some of these, not all.
 *
 * Colleague states it as a count — `MinSubrequirements` on a requirement, or
 * `MinGroups` on a subrequirement — and the solver has always honoured it by
 * quietly taking the cheapest branch. Quietly is the problem. "Artificial
 * Intelligence Track or six credits of technical electives" is the most
 * consequential decision in a degree, and a planner that answers it on the
 * student's behalf without saying so has hidden the interesting part.
 */
export interface BranchOption {
  id: string;
  /** Colleague's own wording, falling back to its code when it has none. */
  label: string;
  status: Progress;
}

export interface OpenBranch {
  program: string;
  /** Addresses the decision, so a caller can force one: see `NeedOptions.tracks`. */
  key: string;
  text: string;
  /** How many of the options are required. Nearly always one. */
  pick: number;
  options: BranchOption[];
  /** Option ids this solve actually took. */
  chosen: string[];
}

/** Addresses a branch: a requirement's subrequirements, or a subrequirement's groups. */
export const branchKey = (requirement: string, subrequirement?: string) =>
  subrequirement ? `${requirement}/${subrequirement}` : requirement;

/**
 * Picks `want` items, honouring a forced choice before falling back to cost.
 *
 * Finished branches come first regardless: a global-awareness requirement
 * already met by two years of high-school language is met, and offering to
 * "choose" one of the other five would be inventing work.
 */
function pickBranch<T>(
  items: readonly T[],
  want: number,
  id: (item: T) => string,
  done: (item: T) => boolean,
  cost: (item: T) => number,
  forced?: readonly string[],
): T[] {
  const wanted = forced?.length ? items.filter((item) => forced.includes(id(item))) : [];
  const rest = [...items]
    .filter((item) => !wanted.includes(item))
    .sort((a, b) => Number(done(b)) - Number(done(a)) || cost(a) - cost(b));
  return [...wanted, ...rest].slice(0, Math.max(want, 0));
}

/**
 * A requirement whose own pool cannot satisfy it.
 *
 * Nearly always a repeated course: "two sections of the Honors Seminar
 * (HON-3020)" is four credits drawn from a pool containing one two-credit
 * course. The solver holds courses in a set, so it cannot take one twice, and
 * quietly buying whatever else the pool offers understates the degree.
 */
export interface Shortfall {
  program: string;
  text: string;
  ids: Unenumerable["ids"];
  /** Credits the group asks for. */
  wanted: number;
  /** Credits still missing after everything available was bought. */
  short: number;
  pool: string[];
}

/** A group that offers a choice, carried until the cover can solve them together. */
export interface OpenChoice {
  /** Program this came from, so a combined solve can say who wants it. */
  program: string;
  /** Colleague's own wording for the requirement. */
  text: string;
  pool: string[];
  credits: number;
  ids: Unenumerable["ids"];
}

/**
 * Walks one program and reports what it owes, without solving the choices.
 *
 * Split out from `coursesNeeded` so that several programs can be solved
 * against a single cover. A student adding a minor to a major does not owe the
 * two bills separately — a course bought for one pays for the other — and that
 * discount only appears if every choice is on the table at once.
 */
function walkProgram(
  tree: ProgramTree,
  options: NeedOptions,
): {
  courses: Set<string>;
  choices: OpenChoice[];
  branches: OpenBranch[];
  unenumerable: Unenumerable[];
} {
  const courses = new Set<string>();
  const unenumerable: Unenumerable[] = [];
  const choices: OpenChoice[] = [];
  const branches: OpenBranch[] = [];
  // Priced against what the plan already owes, so a branch whose courses are
  // required anyway is recognised as free rather than merely tied.
  const free = committed(tree, options);

  for (const requirement of tree.requirements) {
    const subs = [...requirement.subrequirements];
    // "Any one of these six" — take the cheapest, not all six.
    const wantSubs = requirement.minSubrequirements ?? subs.length;
    const subKey = branchKey(requirement.code);
    const takenSubs = pickBranch(
      subs,
      wantSubs,
      (s) => s.id,
      (s) => s.status.completion === "Completed",
      (s) => s.groups.reduce((n, g) => n + groupCost(g, options, free), 0),
      options.tracks?.get(subKey),
    );
    if (wantSubs < subs.length) {
      branches.push({
        program: tree.code,
        key: subKey,
        text: requirement.text || requirement.code,
        pick: wantSubs,
        options: subs.map((s) => ({
          id: s.id,
          label: s.text || s.code,
          status: s.status,
        })),
        chosen: takenSubs.map((s) => s.id),
      });
    }

    for (const sub of takenSubs) {
      const wantGroups = sub.minGroups ?? sub.groups.length;
      const groupBranchKey = branchKey(requirement.code, sub.id);
      const chosenGroups = pickBranch(
        sub.groups,
        wantGroups,
        (g) => g.id,
        (g) => g.status.completion === "Completed",
        (g) => groupCost(g, options, free),
        options.tracks?.get(groupBranchKey),
      );
      if (wantGroups < sub.groups.length) {
        branches.push({
          program: tree.code,
          key: groupBranchKey,
          text: sub.text || requirement.text || sub.code,
          pick: wantGroups,
          options: sub.groups.map((g) => ({
            id: g.id,
            label: g.text || g.code,
            status: g.status,
          })),
          chosen: chosenGroups.map((g) => g.id),
        });
      }

      for (const group of chosenGroups) {
        if (group.status.completion === "Completed") continue;
        const c = group.constraint;

        if (c.kind === "rule-based" || c.kind === "filter") {
          const bucket =
            c.kind === "filter" && c.subjects.length === 0 && c.departments.length === 0;
          const ids = {
            requirement: group.requirementCode,
            subrequirement: group.subrequirementId,
            group: group.id,
          };

          // Once Colleague has told us what qualifies, the group is just
          // another choice — and joins the cover rather than being filled on
          // its own afterwards.
          const pool = !bucket ? options.resolved?.get(groupKey(ids)) : undefined;
          if (pool?.length) {
            choices.push({
              program: tree.code,
              text: group.text || requirement.text || group.code,
              pool: [...pool],
              credits: group.min.credits ?? 3,
              ids,
            });
            continue;
          }

          unenumerable.push({
            requirement: requirement.text,
            // Colleague leaves DisplayText empty on some groups, and "Group 1"
            // tells a student nothing that the requirement's name does not.
            text: group.text || requirement.text || group.code,
            bucket,
            ...(group.min.credits !== undefined ? { credits: group.min.credits } : {}),
            ids,
          });
          continue;
        }

        if (c.kind === "take-all") {
          for (const x of c.courses) if (!options.have.has(x.CourseName)) courses.add(x.CourseName);
        } else if (c.kind === "choose-from") {
          choices.push({
            program: tree.code,
            text: group.text || requirement.text || group.code,
            pool: c.courses.map((x) => x.CourseName),
            credits: group.min.credits ?? options.credits(c.courses[0]?.CourseName ?? ""),
            ids: {
              requirement: group.requirementCode,
              subrequirement: group.subrequirementId,
              group: group.id,
            },
          });
        }
      }
    }
  }

  return { courses, choices, branches, unenumerable };
}

/**
 * The cheapest set of courses that still satisfies a program.
 *
 * Program-agnostic on purpose: it reads the counts Colleague publishes rather
 * than knowing anything about a particular major's tracks.
 */
export function coursesNeeded(tree: ProgramTree, options: NeedOptions): Needed {
  return coursesNeededAcross([tree], options);
}

/**
 * The cheapest set of courses that satisfies several programs at once.
 *
 * This is the dual-major question stated properly. Solving each program on its
 * own and taking the union double-buys every requirement the two share: both
 * ask for a laboratory science, both accept `GBIO-1000`, and two separate
 * covers each purchase their own. One cover over every choice buys it once.
 *
 * `pinned` is a course the student has decided to take. It enters the cover as
 * though already bought, which is what makes "what does choosing this cost me"
 * answerable: solve once without it, once with, and compare.
 */
export function coursesNeededAcross(
  trees: readonly ProgramTree[],
  options: NeedOptions,
): Needed & { choices: OpenChoice[]; branches: OpenBranch[]; shortfalls: Shortfall[] } {
  const courses = new Set<string>(options.pinned ?? []);
  const choices: OpenChoice[] = [];
  const branches: OpenBranch[] = [];
  const unenumerable: Unenumerable[] = [];

  for (const tree of trees) {
    const walked = walkProgram(tree, options);
    for (const code of walked.courses) courses.add(code);
    choices.push(...walked.choices);
    branches.push(...walked.branches);
    unenumerable.push(...walked.unenumerable);
  }

  // A choice its own pool cannot close is worth naming. Colleague states
  // "two sections of the Honors Seminar" as a four-credit group over a pool
  // holding one two-credit course, because a repeated course is a thing a
  // registrar can express and a set of course codes cannot.
  const short = cover(courses, choices, options);
  const shortfalls = choices
    .map((choice, i) => ({ choice, short: short[i] ?? 0 }))
    .filter(({ short: s }) => s > 0)
    .map(({ choice, short: s }) => ({
      program: choice.program,
      text: choice.text,
      ids: choice.ids,
      wanted: choice.credits,
      short: s,
      pool: choice.pool,
    }));

  return { courses, choices, branches, shortfalls, unenumerable };
}

/**
 * Satisfies every choose-from group with as few extra credits as possible.
 *
 * Solved together rather than one group at a time, because Colleague lets a
 * single course count toward several requirements at once — MATH-1705 satisfies
 * the general-education quantitative slot *and* the major's cognates. Picking
 * per group in isolation buys a second course for a requirement that is already
 * met, and enough of those push a graduation date out by a term.
 *
 * Weighted greedy: repeatedly take whichever course closes the most remaining
 * credit per credit spent. Exact set cover is NP-hard and the greedy bound is
 * comfortably good enough for a few dozen requirements — and unlike an exact
 * solver, its choices stay explainable.
 */
function cover(
  courses: Set<string>,
  choices: { pool: string[]; credits: number }[],
  options: NeedOptions,
): number[] {
  const owed = choices.map((choice) => {
    let left = choice.credits;
    // Anything already passed, or already required outright, counts first.
    for (const code of choice.pool) {
      if (options.have.has(code) || courses.has(code)) left -= options.credits(code);
    }
    return { pool: choice.pool, left };
  });

  /** What each choice still wants once nothing more can be bought for it. */
  const shortfall = () => owed.map((o) => Math.max(0, o.left));

  for (;;) {
    const open = owed.filter((o) => o.left > 0);
    if (open.length === 0) return shortfall();

    const candidates = new Set(
      open.flatMap((o) => o.pool).filter((c) => !courses.has(c) && !options.have.has(c)),
    );
    if (candidates.size === 0) return shortfall();

    let best: { code: string; value: number } | null = null;
    for (const code of candidates) {
      const price = options.credits(code) || 1;
      // Credit actually closed, not credit offered: a 4-credit course against
      // a 3-credit requirement closes three.
      const closed = open
        .filter((o) => o.pool.includes(code))
        .reduce((n, o) => n + Math.min(options.credits(code), o.left), 0);
      const value = closed / price;
      if (!best || value > best.value || (value === best.value && code < best.code)) {
        best = { code, value };
      }
    }
    if (!best || best.value <= 0) return shortfall();

    courses.add(best.code);
    for (const o of open) {
      if (o.pool.includes(best.code)) o.left -= options.credits(best.code);
    }
  }
}

/**
 * Adds enough of `options` to `need` to cover `credits`, preferring courses
 * already scheduled.
 *
 * A requirement is often satisfiable by something the plan already contains:
 * the history elective accepts 46 courses, two of which are on the plan for
 * other reasons. Picking a fresh one because it is cheaper in isolation adds
 * a course that buys nothing, and enough of those push a graduation date out
 * by a term.
 *
 * Returns the credits it could not cover.
 */
export function absorbInto(
  need: Set<string>,
  options: readonly string[],
  credits: number,
  price: (code: string) => number,
): number {
  let want = credits;

  // Free first: anything already on the plan costs no additional credits.
  for (const code of options) {
    if (want <= 0) break;
    if (need.has(code)) want -= price(code);
  }
  // Then cheapest, to cover whatever is left.
  for (const code of [...options].filter((c) => !need.has(c)).sort((a, b) => price(a) - price(b))) {
    if (want <= 0) break;
    need.add(code);
    want -= price(code);
  }
  return Math.max(want, 0);
}
