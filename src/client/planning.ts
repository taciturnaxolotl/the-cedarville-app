/*
 * Everything three views were each working out for themselves.
 *
 * Build, map and plan all answer questions about one projection, so all three
 * need the same graph, the same prices, the same seasons and the same set of
 * courses already held. Each had assembled that on its own, and the copies had
 * already drifted: the plan view was still inferring seasons from one term's
 * section listing — the inference this repo documents as wrong for 367 courses
 * — and solving without the pins and tracks the student had chosen. It finished
 * a term earlier than the other two tabs and neither said which to believe.
 *
 * So the projection is assembled once, here. A view decides what to draw; it
 * does not decide what is true.
 */

import { runsIn, seasonsOffered, type TermCatalog, yearsOffered } from "../catalog";
import {
  type Plan,
  type PlanRequest,
  projectPlan,
  type Season,
  type TermSlot,
  termsFrom,
} from "../planner";
import { buildGraph, type Graph, nodeOf } from "../prereqs";
import {
  completedCourses,
  coursesNeededAcross,
  expectedCredits,
  inProgressCourses,
  type NeedOptions,
  type ProgramTree,
  type Unenumerable,
} from "../requirements";
import { resolveRules } from "./bridge";
import type { Ctx } from "./ctx";
import { FULL_TIME, type Load } from "./load";

/** Where the build view keeps what the student has settled on. */
export const PINS = "cedarville:pins";
export const TRACKS = "cedarville:tracks";

/** The first term a plan may use. Everything before it is history or now. */
const START = { year: 2027, season: "spring" } as const;
/** Terms to project. Twelve is six years without summers, and four with. */
const HORIZON = 12;

export const read = <T>(key: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "") as T;
  } catch {
    return fallback;
  }
};

/** What the student has decided, as the solver wants it. */
export interface Picks {
  pinned: Set<string>;
  tracks: Map<string, string[]>;
}

export const storedPicks = (): Picks => ({
  pinned: new Set(read<string[]>(PINS, [])),
  tracks: new Map(
    Object.entries(read<Record<string, string>>(TRACKS, {})).map(([key, value]) => [key, [value]]),
  ),
});

export type Solved = ReturnType<typeof coursesNeededAcross>;

export interface Planning {
  trees: readonly ProgramTree[];
  records: NonNullable<TermCatalog["courses"]>;
  graph: Graph;
  /** A course's own name, or "" when no catalog we hold lists it. */
  title(code: string): string;
  /** Its price, stretched to what the requirement asking for it wants. */
  price(code: string): number;
  /** Seasons the registrar states. Empty means it states none, not never. */
  seasonsOf(code: string): Season[];
  offeredIn: PlanRequest["offeredIn"];
  /** Passed, under way, and the union — which is what a prerequisite wants. */
  passed: Set<string>;
  running: Set<string>;
  have: Set<string>;
  /** Credits on the transcript, which is what class standing is measured on. */
  earned: number;
  /** The majors and minors on the table, which some requirements ask about. */
  pursuing: Set<string>;
  solve(over?: Partial<NeedOptions>): Solved;
  slots(load: Load): TermSlot[];
  project(need: Iterable<string>, load: Load): Plan;
  /**
   * Asks the server to expand the groups Colleague would not, then hands back
   * the pools it found. Silent on failure: a group listed as unresolved is a
   * better answer than a guess.
   */
  expandRules(groups: readonly Unenumerable[]): Promise<Map<string, string[]>>;
}

export function planningFrom(ctx: Ctx): Planning {
  const trees = ctx.trees;
  // The whole catalog when we have it: prerequisites name courses nobody is
  // teaching this term, and a graph built from one term's offerings loses
  // about a third of its depth.
  const records = ctx.allCourses?.length ? ctx.allCourses : (ctx.sections?.courses ?? []);

  const key = (c: { SubjectCode: string; Number: string }) => `${c.SubjectCode}-${c.Number}`;
  const credits = new Map(records.map((c) => [key(c), c.MinimumCredits ?? 0]));
  const maxima = new Map(records.map((c) => [key(c), c.MaximumCredits ?? c.MinimumCredits ?? 0]));
  const titles = new Map(records.map((c) => [key(c), c.Title]));
  const seasons = new Map(records.map((c) => [key(c), seasonsOffered(c)]));
  const cycles = new Map(records.map((c) => [key(c), yearsOffered(c)]));

  const graph = buildGraph(records.map(nodeOf));

  // A variable-credit course is worth what the requirement asking for it
  // demands, not its floor: HON-4950 runs 1 to 2 and the capstone wants 2.
  const stretched = expectedCredits(trees, (c) => ({
    min: credits.get(c) ?? 3,
    max: maxima.get(c) || (credits.get(c) ?? 3),
  }));

  const passed = completedCourses(trees);
  const running = inProgressCourses(trees);

  const price = (code: string) => stretched.get(code) ?? credits.get(code) ?? 3;
  const have = new Set([...passed, ...running]);
  const pursuing = new Set(trees.flatMap((t) => [...t.majors, ...t.minors]));
  const earned = trees.length
    ? Math.max(...trees.map((t) => t.credits.completed + t.credits.inProgress))
    : 0;

  const offeredIn: PlanRequest["offeredIn"] = (code, slot) => {
    const stated = seasons.get(code);
    if (stated?.length && !stated.includes(slot.season)) return false;
    // 268 courses run in alternate academic years, and a plan that ignores
    // that puts a student in a classroom that is not running.
    return runsIn(cycles.get(code) ?? "all", slot.year, slot.season);
  };

  const slots = (load: Load) =>
    termsFrom(START, HORIZON, {
      capacity: load.perTerm,
      summerCapacity: load.summer,
      summers: load.summers,
      minimum: FULL_TIME,
    });

  return {
    trees,
    records,
    graph,
    title: (code) => titles.get(code) ?? "",
    price,
    seasonsOf: (code) => seasons.get(code) ?? [],
    offeredIn,
    passed,
    running,
    have,
    earned,
    pursuing,

    solve: (over = {}) =>
      coursesNeededAcross(trees, { credits: price, have, pursuing, ...storedPicks(), ...over }),

    slots,

    project: (need, load) =>
      projectPlan({
        need,
        completed: have,
        graph,
        credits: price,
        offeredIn,
        earnedCredits: earned,
        keepSemestersFull: load.fullSemesters,
        slots: slots(load),
      }),

    async expandRules(groups) {
      const asked = groups.filter((u) => !u.bucket).map((u) => u.ids);
      const found = new Map<string, string[]>();
      if (!asked.length) return found;
      try {
        const answers = await resolveRules(asked);
        for (const key of Object.keys(answers)) {
          const pool = answers[key]?.filter((code) => !have.has(code));
          if (pool?.length) found.set(key, pool);
        }
      } catch {
        /* Leave the group listed as unresolved rather than guessing at it. */
      }
      return found;
    },
  };
}
