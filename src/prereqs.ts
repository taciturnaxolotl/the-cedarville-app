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
export function eligibility(
  node: CourseNode,
  completed: ReadonlySet<string>,
  alsoTaking: ReadonlySet<string> = new Set(),
): Eligibility {
  const blocked = new Set<string>();
  const unclear: string[] = [];

  for (const requisite of node.requisites) {
    if (!requisite.required) continue;

    if (!requisite.understood) {
      unclear.push(requisite.text);
      continue;
    }

    // A corequisite is satisfied by taking it now; a prerequisite is not.
    const satisfies = (code: string) =>
      completed.has(code) || (requisite.timing !== "before" && alsoTaking.has(code));

    const met =
      requisite.mode === "any"
        ? requisite.courses.some(satisfies)
        : requisite.courses.every(satisfies);
    if (met) continue;

    for (const code of requisite.courses) if (!satisfies(code)) blocked.add(code);
  }

  if (unclear.length) return { state: "unknown", blockedBy: [...blocked], why: unclear };
  return blocked.size
    ? { state: "blocked", blockedBy: [...blocked] }
    : { state: "open", blockedBy: [] };
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
