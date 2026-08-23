/**
 * What a course needs, and what needs it.
 *
 * Colleague states requisites as a rule id the API never expands, but it also
 * ships the registrar's own rendering: "Take CS-1220" with an extension line
 * saying whether it must come before, alongside, or is merely recommended.
 * That text is the only machine-readable prerequisite data available, so this
 * parses it — and refuses to parse the parts that are prose.
 *
 * Surveyed against all 943 courses in Fall 2026: 373 carry requisites, and
 * five distinct extension phrasings cover every one of them.
 */

import type { CatalogCourseRecord } from "./catalog";

/** How the requisite relates in time, from DisplayTextExtension. */
export type Timing =
  /** Must be finished first. */
  | "before"
  /** Before or alongside. */
  | "before-or-with"
  /** Strictly alongside. */
  | "with";

export interface Requisite {
  /** Course codes like "CS-1220". Empty when the text was prose. */
  courses: string[];
  /** Whether any one course suffices, or all are needed. */
  mode: "all" | "any";
  timing: Timing;
  required: boolean;
  /** Colleague's own wording. Always shown when `understood` is false. */
  text: string;
  /**
   * False when the text says more than we parsed: "junior status", "permission
   * of instructor", "acceptance into the PA program". Those gate the course
   * just as hard, and pretending otherwise would tell a student they are
   * eligible when they are not.
   */
  understood: boolean;
}

export interface RawRequisite {
  DisplayText?: string | null;
  DisplayTextExtension?: string | null;
  IsRequired?: boolean;
}

const COURSE = /\b[A-Z]{2,5}-[0-9][0-9A-Z]{2,4}\b/g;

function timingOf(extension: string): { timing: Timing; recommended: boolean } {
  const text = extension.toLowerCase();
  const recommended = text.includes("recommended");
  if (text.includes("at the same time") && !text.includes("prior")) {
    return { timing: "with", recommended };
  }
  if (text.includes("prior to or at the same time")) {
    return { timing: "before-or-with", recommended };
  }
  return { timing: "before", recommended };
}

/**
 * True when the text is nothing but "Take" and a list of course codes. Any
 * other word means a human condition we cannot evaluate.
 */
function fullyUnderstood(text: string): boolean {
  const residue = text
    .replace(COURSE, " ")
    .replace(/\b(take|and|or)\b/gi, " ")
    .replace(/[.,;#]/g, " ")
    .trim();
  return residue === "";
}

export function parseRequisite(raw: RawRequisite): Requisite {
  const text = (raw.DisplayText ?? "").trim();
  const courses = [...new Set(text.match(COURSE) ?? [])];
  const { timing, recommended } = timingOf(raw.DisplayTextExtension ?? "");

  return {
    courses,
    // "Take CS-3220 CS-3610" is a conjunction; only an explicit "or" is not.
    mode: /\bor\b/i.test(text) ? "any" : "all",
    timing,
    required: raw.IsRequired !== false && !recommended,
    text: [text, (raw.DisplayTextExtension ?? "").trim()].filter(Boolean).join(" "),
    understood: courses.length > 0 && fullyUnderstood(text),
  };
}

// ---- the graph ---------------------------------------------------------

export interface CourseNode {
  /** "CS-2210". */
  code: string;
  title: string;
  requisites: Requisite[];
  /**
   * Class standing the course demands. Stated in prose and nowhere else, so it
   * is not a requisite record and never appears in `requisites`.
   */
  standing?: Standing;
}

/**
 * How far through a degree a student must be. Cedarville states these as
 * prose — "Prerequisite: senior status in engineering" — usually in the
 * description rather than in any requisite the API returns.
 */
export type Standing = "sophomore" | "junior" | "senior";

const STANDING =
  /\b(sophomore|junior|senior)s?\s+(?:status|standing)\b|\bonly to (sophomore|junior|senior)s\b/i;

/**
 * The standing a piece of catalog prose demands, if any.
 *
 * 58 courses gate on this and nothing else. `EGGN-4010` Senior Seminar carries
 * no requisite record at all: the whole of its condition is one sentence of
 * description. Read literally that course is open to a freshman, and a plan
 * that believes it will put the senior seminar in a student's first autumn.
 */
export function standingIn(text: string): Standing | null {
  const found = STANDING.exec(text);
  const word = found?.[1] ?? found?.[2];
  return word ? (word.toLowerCase() as Standing) : null;
}

/**
 * A catalog record as the graph wants it.
 *
 * Five call sites built this by hand, so none of them could learn a new field
 * without the other four going stale.
 */
/**
 * A course whose own name says when it is taken.
 *
 * "Honors Sr Colloq I" carries no description, no requisite and no rule: the
 * only thing in Colleague that says it is a senior course is the word in its
 * title. Read literally it is open to a freshman, and a plan that believes
 * that puts the senior colloquium in somebody's sophomore summer.
 *
 * Thirty-one courses are in exactly this position, and none of them is a
 * course a first-year student takes.
 */
const SENIOR_TITLE = /\b(?:sr|senior)\b/i;

export function nodeOf(record: CatalogCourseRecord): CourseNode {
  const requisites = record.CourseRequisites ?? [];
  const standing =
    standingIn(
      `${record.Description ?? ""} ${requisites.map((r) => r.DisplayText ?? "").join(" ")}`,
    ) ?? (SENIOR_TITLE.test(record.Title ?? "") ? "senior" : null);
  return {
    code: `${record.SubjectCode}-${record.Number}`,
    title: record.Title,
    requisites: requisites.map(parseRequisite),
    ...(standing ? { standing } : {}),
  };
}

export interface Graph {
  courses: Map<string, CourseNode>;
  /** code -> courses that list it as a requisite. What this unlocks. */
  unlocks: Map<string, Set<string>>;
}

export function buildGraph(nodes: CourseNode[]): Graph {
  const courses = new Map(nodes.map((n) => [n.code, n]));
  const unlocks = new Map<string, Set<string>>();

  for (const node of nodes) {
    for (const requisite of node.requisites) {
      if (!requisite.required) continue;
      for (const needed of requisite.courses) {
        const set = unlocks.get(needed) ?? new Set<string>();
        set.add(node.code);
        unlocks.set(needed, set);
      }
    }
  }
  return { courses, unlocks };
}

/**
 * Teaches the graph about a second sitting of a course.
 *
 * `HON-3020#2` is the same course with its own place in a plan, so it waits on
 * exactly what the first sitting waited on. Nothing waits on *it*, which is
 * right: a requirement that wants the course twice is the only thing that
 * cares, and it is already satisfied.
 */
export function addSitting(graph: Graph, code: string): void {
  const base = code.split("#")[0] ?? code;
  if (base === code || graph.courses.has(code)) return;
  const node = graph.courses.get(base);
  if (node) graph.courses.set(code, { ...node, code });
}

export type Eligibility =
  /** Every required prerequisite is satisfied. */
  | { state: "open"; blockedBy: [] }
  /** Waiting on courses the student has not taken. */
  | { state: "blocked"; blockedBy: string[] }
  /** Gated by something we cannot check, such as instructor permission. */
  | { state: "unknown"; blockedBy: string[]; why: string[] };

/**
 * Can a student take this course, given what they have completed?
 *
 * `alsoTaking` covers the before-or-with case: a course you are enrolling in
 * this same term satisfies a corequisite but not a prerequisite.
 */
export interface EligibilityOptions {
  /**
   * Codes that count as a given course. A transcript from an earlier catalog
   * year carries course codes the current one has never heard of, and
   * Colleague tracks the equivalences itself.
   */
  aliases?: (code: string) => string[];
  /**
   * Whether a course exists in the catalog at all.
   *
   * Each entering class is locked to a catalog year, and courses are retired
   * and renumbered between them. Requisite text written under an older
   * catalog outlives it: MATH-1720 was Calculus II, is named by five courses,
   * and no longer exists — today it is MATH-1715. A few entries also carry
   * transposed subject codes (CLUM for CLMU).
   *
   * Treating a course nobody can enrol in as a hard blocker marks its
   * dependents permanently unreachable, which is worse than admitting doubt.
   */
  exists?: (code: string) => boolean;
}

export function eligibility(
  node: CourseNode,
  completed: ReadonlySet<string>,
  alsoTaking: ReadonlySet<string> = new Set(),
  options: EligibilityOptions = {},
): Eligibility {
  const blocked = new Set<string>();
  const unclear: string[] = [];

  for (const requisite of node.requisites) {
    if (!requisite.required) continue;

    // An unparseable requisite still usually names courses: "Take CS-3310,
    // junior status, and permission of instructor". Record the doubt, then go
    // on to check the courses anyway — skipping them reports no blockers at
    // all, which reads as "nothing in the way" and is the opposite of true.
    if (!requisite.understood) unclear.push(requisite.text);
    if (requisite.courses.length === 0) continue;

    // A corequisite is satisfied by taking it now; a prerequisite is not.
    const satisfies = (code: string) =>
      (options.aliases ? options.aliases(code) : [code]).some(
        (c) => completed.has(c) || (requisite.timing !== "before" && alsoTaking.has(c)),
      );

    // A prerequisite naming a course the catalog does not have is a stale
    // reference, not a wall. Say so rather than blocking forever.
    const phantom = options.exists
      ? requisite.courses.filter((c) => !options.exists!(c) && !satisfies(c))
      : [];
    if (phantom.length === requisite.courses.length) {
      unclear.push(
        `${requisite.text} — ${phantom.join(", ")} ${phantom.length === 1 ? "is" : "are"} not in the current catalog, likely retired or renumbered under an earlier catalog year`,
      );
      continue;
    }

    const met =
      requisite.mode === "any"
        ? requisite.courses.some(satisfies)
        : requisite.courses.every(satisfies);
    if (met) continue;

    // Only name options a student could actually enrol in. Cedarville's
    // calculus transition leaves requisites like "MATH-2705 or MATH-2710"
    // where the second no longer exists; listing it as a blocker is noise.
    const reachable = requisite.courses.filter((c) => !phantom.includes(c));
    for (const code of reachable.length ? reachable : requisite.courses) {
      if (!satisfies(code)) blocked.add(code);
    }
    // Only raise the phantom once nothing reachable is standing in the way.
    // While a real prerequisite is still outstanding, "blocked on CS-1210" is
    // the more actionable truth than "there is something we cannot check".
    if (phantom.length && reachable.every(satisfies)) {
      unclear.push(
        `${requisite.text} — ${phantom.join(", ")} no longer ${phantom.length === 1 ? "exists" : "exist"}; an earlier catalog's course`,
      );
    }
  }

  if (unclear.length) return { state: "unknown", blockedBy: [...blocked], why: unclear };
  return blocked.size
    ? { state: "blocked", blockedBy: [...blocked] }
    : { state: "open", blockedBy: [] };
}

/**
 * Every course that must be passed before `code`, transitively.
 *
 * Choosing a course is never just that course. A student who picks a 4000-level
 * elective has also picked the two courses gating it, and pricing the choice
 * without them says a three-credit decision when it is a nine-credit one.
 *
 * Where a requisite offers alternatives, the shallowest is taken — the same
 * "cheapest satisfying path" the requirement solver uses, applied to time
 * rather than credits.
 */
/**
 * The courses standing immediately in front of this one.
 *
 * One level, not the closure. A drawing wants the edges the catalog actually
 * states: `CS-2210` waits on `CS-1220`, which waits on `CS-1210`. Adding the
 * implied `CS-1210 → CS-2210` says nothing new and crosses the picture.
 */
export function gatesOf(
  graph: Graph,
  code: string,
  completed: ReadonlySet<string> = new Set(),
  planned: ReadonlySet<string> = new Set(),
): string[] {
  const gates: string[] = [];
  for (const requisite of graph.courses.get(code)?.requisites ?? []) {
    // A corequisite is taken alongside, so it gates nothing.
    if (!requisite.required || requisite.timing === "with") continue;

    // "Take A or B" with A already passed is satisfied outright; adding B
    // because A was filtered out buys a course for a requisite that is met.
    if (requisite.mode === "any" && requisite.courses.some((c) => completed.has(c))) continue;

    const open = requisite.courses.filter((c) => !completed.has(c) && graph.courses.has(c));
    if (open.length === 0) continue;

    if (requisite.mode === "any") {
      gates.push(
        open.find((c) => planned.has(c)) ??
          open.reduce((a, b) => (depth(graph, a) <= depth(graph, b) ? a : b)),
      );
    } else {
      gates.push(...open);
    }
  }
  return [...new Set(gates)];
}

export function prerequisitesOf(
  graph: Graph,
  code: string,
  completed: ReadonlySet<string> = new Set(),
  /**
   * Courses the plan already intends to take. A requisite offering a choice
   * should reach for one of these before introducing anything new: the AI
   * track's `DSAI-3110` accepts five different statistics courses, one of
   * which — `MATH-2520` — cyber operations already requires, and picking any
   * of the other four invents a chain the student was never going to walk.
   */
  planned: ReadonlySet<string> = new Set(),
  seen = new Set<string>(),
): Set<string> {
  const needed = new Set<string>();
  if (seen.has(code)) return needed; // A cycle in the catalog; do not hang on it.
  seen.add(code);

  for (const gate of gatesOf(graph, code, completed, planned)) {
    needed.add(gate);
    for (const deeper of prerequisitesOf(graph, gate, completed, planned, seen)) needed.add(deeper);
  }
  return needed;
}

/**
 * Everything that becomes reachable once `code` is done, transitively.
 *
 * This is the number that should drive planning order: a course gating eleven
 * others is worth taking before one that gates none, even when both are
 * merely "required".
 */
export function downstream(graph: Graph, code: string): Set<string> {
  const reached = new Set<string>();
  const queue = [code];

  while (queue.length) {
    const current = queue.pop()!;
    for (const next of graph.unlocks.get(current) ?? []) {
      if (reached.has(next)) continue;
      reached.add(next);
      queue.push(next);
    }
  }
  return reached;
}

/**
 * Longest chain of prerequisites ending at this course, in courses. A depth
 * of 3 means three terms minimum, no matter how light your load is.
 */
export function depth(graph: Graph, code: string, seen = new Set<string>()): number {
  if (seen.has(code)) return 0; // A cycle in the catalog; do not hang on it.
  seen.add(code);

  const node = graph.courses.get(code);
  if (!node) return 0;

  let longest = 0;
  for (const requisite of node.requisites) {
    if (!requisite.required || requisite.timing === "with") continue;
    for (const needed of requisite.courses) {
      longest = Math.max(longest, 1 + depth(graph, needed, new Set(seen)));
    }
  }
  return longest;
}
