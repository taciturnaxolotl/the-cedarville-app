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

import {
  nextPlannableTerm,
  runsIn,
  seasonsOffered,
  type TermCatalog,
  yearsOffered,
} from "../catalog";
import { crawlGroup } from "../crawl";
import {
  type Plan,
  type PlanRequest,
  projectPlan,
  type Season,
  type TermSlot,
  termsFrom,
} from "../planner";
import { addSitting, buildGraph, type Graph, nodeOf, prerequisitesOf } from "../prereqs";
import {
  baseCode,
  completedCourses,
  coursesNeededAcross,
  expectedCredits,
  groupKey,
  inProgressCourses,
  type NeedOptions,
  type ProgramTree,
  type Shortfall,
  sittingCode,
  type Unenumerable,
} from "../requirements";
import { sequencesFrom } from "../sequences";
import { installed, resolveRules, searcher } from "./bridge";
import type { Ctx } from "./ctx";
import { FULL_TIME, type Load } from "./load";
import { editsOf, type Moves } from "./moves";

/**
 * A second sitting of a course is a code of its own, and everything that
 * prices, names or dates one reads past the suffix. Re-exported because the
 * views ask this question constantly and the solver is where it is answered.
 */
export { baseCode } from "../requirements";

/** Where the build view keeps what the student has settled on. */
export const PINS = "cedarville:pins";
export const TRACKS = "cedarville:tracks";
/**
 * Rule pools this browser has already resolved.
 *
 * Course codes keyed by requirement coordinates: a catalog fact, the same for
 * every student, and unchanged between page loads. Worth keeping because the
 * answer now costs a request on the student's own session.
 */
const POOLS = "cedarville:rule-pools";

/** The first term a plan may use. Everything before it is history or now. */
const START = nextPlannableTerm(new Date());
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

const readPools = (): Record<string, string[]> => {
  const held = read<Record<string, string[]>>(POOLS, {});
  // A record read off disk is only as good as whatever wrote it.
  return Object.fromEntries(
    Object.entries(held ?? {}).filter(
      ([key, pool]) => typeof key === "string" && Array.isArray(pool),
    ),
  );
};

const writePools = (pools: Record<string, string[]>) => {
  try {
    localStorage.setItem(POOLS, JSON.stringify(pools));
  } catch {
    /* A cache that will not fit is a cache we do without. */
  }
};

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
  /** Colleague's own id for a course, which every write to a plan is keyed on. */
  courseId(code: string): string | undefined;
  /** Courses that run back to back, follower to leader. */
  sequences: ReadonlyMap<string, string>;
  /**
   * Makes a second (or third) sitting of a course plannable, and hands back
   * the code that names it. Idempotent: asking twice for the same sitting
   * registers it once.
   */
  sitting(code: string, nth: number): string;
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
  /** Placements are the student's own; everything else arranges around them. */
  project(need: Iterable<string>, load: Load, placements?: ReadonlyMap<string, string>): Plan;
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
  const ids = new Map(records.map((c) => [key(c), (c as { Id?: string }).Id]));
  const seasons = new Map(records.map((c) => [key(c), seasonsOffered(c)]));
  const cycles = new Map(records.map((c) => [key(c), yearsOffered(c)]));

  const graph = buildGraph(records.map(nodeOf));
  // Which courses run back to back, which a prerequisite alone never says.
  const sequences = sequencesFrom(records);

  // A variable-credit course is worth what the requirement asking for it
  // demands, not its floor: HON-4950 runs 1 to 2 and the capstone wants 2.
  const stretched = expectedCredits(trees, (c) => ({
    min: credits.get(c) ?? 3,
    max: maxima.get(c) || (credits.get(c) ?? 3),
  }));

  const passed = completedCourses(trees);
  const running = inProgressCourses(trees);

  const price = (code: string) => {
    const base = baseCode(code);
    return stretched.get(base) ?? credits.get(base) ?? 3;
  };
  const have = new Set([...passed, ...running]);
  const pursuing = new Set(trees.flatMap((t) => [...t.majors, ...t.minors]));
  const earned = trees.length
    ? Math.max(...trees.map((t) => t.credits.completed + t.credits.inProgress))
    : 0;

  const offeredIn: PlanRequest["offeredIn"] = (code, slot) => {
    const base = baseCode(code);
    const stated = seasons.get(base);
    if (stated?.length && !stated.includes(slot.season)) return false;
    // 268 courses run in alternate academic years, and a plan that ignores
    // that puts a student in a classroom that is not running.
    return runsIn(cycles.get(base) ?? "all", slot.year, slot.season);
  };

  /** A sitting the graph can answer for: same requisites, its own code. */
  const sitting = (code: string, nth: number) => {
    const instance = sittingCode(code, nth);
    addSitting(graph, instance);
    return instance;
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
    title: (code) => titles.get(baseCode(code)) ?? "",
    price,
    courseId: (code) => ids.get(baseCode(code)),
    sequences,
    sitting,
    seasonsOf: (code) => seasons.get(baseCode(code)) ?? [],
    offeredIn,
    passed,
    running,
    have,
    earned,
    pursuing,

    solve: (over = {}) => {
      const solved = coursesNeededAcross(trees, {
        credits: price,
        // What a course could be taken for, which is what decides whether a
        // pool can close its requirement at all.
        ceiling: (code) => maxima.get(baseCode(code)) || price(code),
        // And what it is called, which is where a requirement asking for two
        // of something says so.
        titleOf: (code) => titles.get(baseCode(code)) ?? "",
        have,
        pursuing,
        ...storedPicks(),
        ...over,
      });
      // The cover mints a second sitting when a pool cannot close its own
      // requirement, and nothing downstream can plan a course the graph has
      // never heard of.
      for (const code of solved.courses) {
        if (code.includes("#")) sitting(code, Number(code.split("#")[1]));
      }
      return solved;
    },

    slots,

    project: (need, load, placements) =>
      projectPlan({
        need,
        completed: have,
        graph,
        credits: price,
        offeredIn,
        earnedCredits: earned,
        keepSemestersFull: load.fullSemesters,
        sequences,
        slots: slots(load),
        ...(placements?.size ? { placements } : {}),
      }),

    async expandRules(groups) {
      const asked = groups.filter((u) => !u.bucket).map((u) => u.ids);
      const found = new Map<string, string[]>();
      if (!asked.length) return found;

      /** A pool is only useful as the courses the student has not taken. */
      const take = (key: string, pool: readonly string[] | undefined) => {
        const owed = pool?.filter((code) => !have.has(code));
        if (owed?.length) found.set(key, owed);
      };

      // Anything this browser has already worked out. A rule's pool is a
      // catalog fact and does not change between page loads, so asking twice
      // is a round trip for an answer already in hand.
      const remembered = readPools();
      const unanswered = asked.filter((ids) => {
        const key = groupKey(ids);
        take(key, remembered[key]);
        return !found.has(key);
      });
      if (!unanswered.length) return found;

      try {
        const answers = await resolveRules(unanswered);
        for (const key of Object.keys(answers)) take(key, answers[key]);
      } catch {
        /* The server may have none of these; the session below might. */
      }

      /*
       * Whatever the server could not expand, asked on the student's own
       * session.
       *
       * Colleague states a handful of requirements as a rule it will not
       * enumerate — "one laboratory course from the biological sciences" —
       * and answers them only through the search its own pages use. The
       * server used to ask anonymously; SSO ended that, and a hosted planner
       * then listed five requirements as unplannable that worked perfectly
       * well on a laptop whose cache still held yesterday's answers.
       *
       * One page per group, and the answer is kept, so this is a few requests
       * once per browser rather than a crawl.
       */
      const missing = unanswered.filter((ids) => !found.has(groupKey(ids)));
      if (missing.length && installed()) {
        for (const ids of missing) {
          try {
            take(groupKey(ids), await crawlGroup(searcher, ids));
          } catch {
            /* Leave the group listed as unresolved rather than guess at it. */
          }
        }
      }

      writePools({ ...remembered, ...Object.fromEntries(found) });
      return found;
    },
  };
}

// ---- the projection itself ---------------------------------------------

/*
 * The same reason `planningFrom` exists, one layer up.
 *
 * A projection is not just the graph and the prices: it is the solve, the
 * prerequisite closure over what the solve asked for, and the student's own
 * moves laid on top. Two views now draw that — the term-by-term and the
 * semester — and the first time they each assembled it themselves they
 * disagreed about which courses the autumn held.
 */
export interface Projection {
  planning: Planning;
  /** Courses still owed, with the prerequisites they drag along. */
  readonly need: ReadonlySet<string>;
  readonly unenumerable: readonly Unenumerable[];
  readonly shortfalls: readonly Shortfall[];
  /**
   * What the plan schedules once the student has had their say.
   *
   * An inserted course brings its prerequisites with it — asking for a
   * capstone and being handed only the capstone would be a lie — and a
   * dropped one leaves even if something else's chain wants it back, because
   * a drop is a decision and the closure is only an inference.
   */
  scheduled(moves: Moves): Set<string>;
  project(moves: Moves, load: Load): Plan;
  /**
   * Asks the server what the rule-based groups hold, then solves again over
   * the answer, so a course bought for one requirement can pay for a
   * rule-based one too. True when anything moved and the view should repaint.
   */
  refine(): Promise<boolean>;
}

export function projectionFrom(planning: Planning): Projection {
  const { graph, have } = planning;

  /** A pool names what satisfies it, never what that costs to reach. */
  const closed = (courses: Set<string>) => {
    for (const code of [...courses]) {
      for (const p of prerequisitesOf(graph, code, have, courses)) courses.add(p);
    }
    return courses;
  };

  const first = planning.solve();
  let need = closed(first.courses);
  let unenumerable: Unenumerable[] = first.unenumerable;
  /**
   * Requirements their own pool cannot close, which is nearly always a course
   * meant to be taken twice: "Honors Integrative Seminars (4 credit hours)"
   * draws on a pool whose seminar is worth two. Colleague can say that; a set
   * of course codes cannot, so the plan says it in words and offers the
   * second sitting as something to add.
   */
  let shortfalls: Shortfall[] = first.shortfalls;

  const scheduled = (moves: Moves) => {
    const { placements, dropped } = editsOf(moves);
    // A sitting the student added is only plannable once the graph can answer
    // for it, and the moves outlive the session that made them.
    for (const code of placements.keys()) {
      if (code.includes("#")) planning.sitting(code, Number(code.split("#")[1]));
    }
    const set = closed(new Set([...need, ...placements.keys()]));
    for (const code of dropped) set.delete(code);
    return set;
  };

  return {
    planning,
    get need() {
      return need;
    },
    get unenumerable() {
      return unenumerable;
    },
    get shortfalls() {
      return shortfalls;
    },
    scheduled,

    project: (moves, load) => planning.project(scheduled(moves), load, editsOf(moves).placements),

    async refine() {
      const resolved = await planning.expandRules(first.unenumerable);
      if (resolved.size === 0) return false;
      for (const u of first.unenumerable) {
        const pool = resolved.get(groupKey(u.ids));
        if (pool?.length) u.resolved = pool;
      }
      const second = planning.solve({ resolved });
      need = closed(second.courses);
      unenumerable = second.unenumerable;
      shortfalls = second.shortfalls;
      return true;
    },
  };
}
