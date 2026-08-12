/**
 * A plan drawn as the graph it actually is.
 *
 * A term-by-term list answers "what am I taking in spring" and hides the thing
 * that decides the whole shape: which of those courses is holding up four
 * others. `CY-4820` sits at the end of a chain five terms long, and no list
 * ordering makes that visible — you have to see the edges.
 *
 * Geometry is computed rather than measured. Reading positions back out of the
 * DOM means a layout pass per repaint, a frame of the wrong thing on screen,
 * and tests that can assert nothing because happy-dom reports every box as
 * zero. Fixed rows and columns cost a little flexibility and buy a layout that
 * is the same everywhere, including in a test.
 */

import type { Plan } from "./planner";
import { type Graph, gatesOf } from "./prereqs";

export interface MapNode {
  code: string;
  title: string;
  credits: number;
  /** Column, one per term. */
  term: number;
  termName: string;
  x: number;
  y: number;
  /** On the longest chain of prerequisites, which is what sets the end date. */
  critical: boolean;
  /** How many courses in the plan wait on this one, directly or otherwise. */
  unlocks: number;
  /** A prerequisite we could not fully parse, carried through from the plan. */
  caution?: string;
  /** On the transcript rather than ahead: passed, or being taken now. */
  past?: "done" | "running";
}

export interface MapEdge {
  from: string;
  to: string;
  /** Both ends on the critical path, so this edge is what sets the date. */
  critical: boolean;
  /** Cubic bezier, left edge of the dependent to the right edge of its gate. */
  path: string;
}

export interface CourseMap {
  nodes: MapNode[];
  edges: MapEdge[];
  width: number;
  height: number;
  /** Terms in order, for the column headings. */
  terms: { name: string; credits: number; x: number; past?: boolean }[];
}

/** A term already on the transcript, drawn to the left of the plan. */
export interface PastTerm {
  /** Short form, matching the projection: "FA25". */
  name: string;
  courses: { code: string; credits: number; done: boolean }[];
}

export interface MapOptions {
  graph: Graph;
  /** Already passed or under way. Never scheduled, but drawn as history. */
  have: ReadonlySet<string>;
  /**
   * What the student has taken, in the terms they took it.
   *
   * Without this the picture opens mid-degree with chains that start nowhere:
   * `LIT-2090` waits on `LIT-1990`, `BTGE-2730` on `BTGE-1725`, and a plan
   * showing only the work ahead draws neither. It also answers the question a
   * student asks first, which is where their general education went — the
   * answer being that most of it is behind them.
   */
  history?: PastTerm[];
  title?: (code: string) => string;
  columnWidth?: number;
  rowHeight?: number;
  nodeWidth?: number;
  nodeHeight?: number;
  padding?: number;
  /** Room for the term heading above the first row. */
  headerHeight?: number;
}

/**
 * The longest chain of prerequisites inside the plan, by term.
 *
 * Not `criticalPath` from the planner, which reasons about the whole catalog:
 * here the question is narrower and more useful — given what is scheduled and
 * when, which run of courses is the one you cannot compress.
 */
function longestChain(
  nodes: Map<string, MapNode>,
  edges: { from: string; to: string }[],
): Set<string> {
  const into = new Map<string, string[]>();
  for (const e of edges) into.set(e.to, [...(into.get(e.to) ?? []), e.from]);

  const best = new Map<string, { length: number; via?: string }>();
  const walk = (code: string): { length: number; via?: string } => {
    const cached = best.get(code);
    if (cached) return cached;
    // Guard against a cycle in the catalog before recursing.
    best.set(code, { length: 1 });

    let longest: { length: number; via?: string } = { length: 1 };
    for (const from of into.get(code) ?? []) {
      const deeper = walk(from).length + 1;
      if (deeper > longest.length) longest = { length: deeper, via: from };
    }
    best.set(code, longest);
    return longest;
  };

  let tail: string | undefined;
  let longest = 0;
  for (const code of nodes.keys()) {
    const { length } = walk(code);
    if (length > longest) {
      longest = length;
      tail = code;
    }
  }

  const chain = new Set<string>();
  for (let at = tail; at; at = best.get(at)?.via) {
    if (chain.has(at)) break;
    chain.add(at);
  }
  return longest > 1 ? chain : new Set();
}

/** Everything downstream of a course within the plan. */
function reach(from: string, out: Map<string, string[]>): number {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length) {
    for (const next of out.get(queue.pop()!) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen.size;
}

export function buildMap(plan: Plan, options: MapOptions): CourseMap {
  const {
    columnWidth = 200,
    rowHeight = 42,
    nodeWidth = 168,
    nodeHeight = 32,
    padding = 16,
    headerHeight = 28,
  } = options;

  const nodes = new Map<string, MapNode>();
  const terms: CourseMap["terms"] = [];

  const history = options.history ?? [];
  history.forEach((term, column) => {
    const x = padding + column * columnWidth;
    terms.push({
      name: term.name,
      credits: term.courses.reduce((n, c) => n + c.credits, 0),
      x,
      past: true,
    });
    term.courses.forEach((course, row) => {
      nodes.set(course.code, {
        code: course.code,
        title: options.title?.(course.code) ?? "",
        credits: course.credits,
        term: column,
        termName: term.name,
        x,
        y: padding + headerHeight + row * rowHeight,
        critical: false,
        unlocks: 0,
        past: course.done ? "done" : "running",
      });
    });
  });

  plan.terms.forEach((term, index) => {
    const column = history.length + index;
    const x = padding + column * columnWidth;
    terms.push({ name: term.slot.name, credits: term.credits, x });
    term.courses.forEach((course, row) => {
      nodes.set(course.code, {
        code: course.code,
        title: options.title?.(course.code) ?? "",
        credits: course.credits,
        term: column,
        termName: term.slot.name,
        x,
        y: padding + headerHeight + row * rowHeight,
        critical: false,
        unlocks: 0,
        ...(course.caution ? { caution: course.caution } : {}),
      });
    });
  });

  // An edge only exists between two courses both on the plan. A prerequisite
  // already passed is satisfied and draws nothing: the graph is about what is
  // still ahead, not a history of the degree.
  const pairs: { from: string; to: string }[] = [];
  const out = new Map<string, string[]>();
  for (const node of nodes.values()) {
    // Direct gates only: the implied CS-1210 to CS-2210 edge says nothing the
    // two it is drawn over do not already say, and crosses the picture.
    // Completion is passed as empty here on purpose: a prerequisite already
    // met still draws its edge once the course sits on the board, and that
    // edge is the whole reason to draw the history at all.
    for (const from of gatesOf(options.graph, node.code, new Set(), new Set(nodes.keys()))) {
      if (!nodes.has(from)) continue;
      pairs.push({ from, to: node.code });
      out.set(from, [...(out.get(from) ?? []), node.code]);
    }
  }

  const critical = longestChain(nodes, pairs);
  for (const node of nodes.values()) {
    node.critical = critical.has(node.code);
    node.unlocks = reach(node.code, out);
  }

  const edges: MapEdge[] = pairs.map(({ from, to }) => {
    const a = nodes.get(from)!;
    const b = nodes.get(to)!;
    const x1 = a.x + nodeWidth;
    const y1 = a.y + nodeHeight / 2;
    const x2 = b.x;
    const y2 = b.y + nodeHeight / 2;
    // Control points a third of the way across, so edges leave and arrive
    // horizontally and stay readable where several converge on one course.
    const bend = Math.max(24, (x2 - x1) / 3);
    return {
      from,
      to,
      critical: critical.has(from) && critical.has(to),
      path: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
    };
  });

  const columns = history.length + plan.terms.length;
  const rows = Math.max(
    0,
    ...plan.terms.map((t) => t.courses.length),
    ...history.map((t) => t.courses.length),
  );
  return {
    nodes: [...nodes.values()],
    edges,
    width: padding * 2 + Math.max(1, columns) * columnWidth,
    height: padding * 2 + headerHeight + rows * rowHeight,
    terms,
  };
}
