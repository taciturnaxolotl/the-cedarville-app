/**
 * Choosing which section of each course to be in.
 *
 * The planner answers "what am I taking in the spring". That leaves a second
 * problem with the same shape and a much smaller search space: each of those
 * courses runs in two or six or eleven sections, at most one of which you can
 * be in, and no two of them may put you in two rooms at once. A student does
 * this by hand, on paper, badly, once a semester.
 *
 * It is a constraint problem, so it is solved as one rather than greedily: a
 * greedy pass that takes the nicest-looking section for the first course
 * routinely paints the last course into a corner, and the student cannot see
 * why. Depth-first with the most constrained course first, pruning on
 * conflict, searches a five-course term exhaustively in a few thousand steps.
 *
 * What makes one conflict-free week better than another is a judgement, so it
 * is stated rather than buried:
 *
 *   seats     a section you cannot get into is worth less than one you can
 *   days      a day with nothing on it is worth more than a tidy hour
 *   gaps      an hour between classes is an hour spent waiting
 *   shape     and then whatever the student said they wanted
 *
 * Pins come first and are never weighed at all. A student who has decided to
 * be in Dr Smith's section at eight in the morning has decided; the arranger
 * works around that and reports what it costs.
 */

import { conflictsBetween, type Offering } from "./schedule";

/** One course, and the sections it is taught in this term. */
export interface SectionChoice {
  /** The course code, which is what the plan calls it. */
  code: string;
  offerings: Offering[];
}

/** What the student asked the arranger to aim for. */
export type Shape = "compact" | "early" | "late";

export interface ArrangeOptions {
  /** Section ids the student chose. Forced, never weighed, never moved. */
  pinned?: ReadonlySet<string>;
  shape?: Shape;
  /**
   * Nodes the search may visit before it settles for the best it has found.
   * A five-course term needs a few thousand; the cap is there so a pathological
   * catalog cannot hang the tab.
   */
  budget?: number;
}

export interface Unplaced {
  code: string;
  why: string;
}

export interface Arrangement {
  /** Course code to the section chosen for it. */
  chosen: Map<string, Offering>;
  /** Sections the student pinned, which are in `chosen` as well. */
  pinned: ReadonlySet<string>;
  unplaced: Unplaced[];
  /** Days of the week with anything on them. */
  days: number;
  /** Minutes spent waiting between classes, summed over the week. */
  gapMinutes: number;
  /** Sections with no seats left, which is a cost rather than a refusal. */
  full: number;
  /** Nodes visited, and whether the search finished rather than ran out. */
  explored: number;
  exhaustive: boolean;
}

const DEFAULT_BUDGET = 20_000;

/** Whether an offering can sit alongside everything already placed. */
const fitsWith = (offering: Offering, placed: readonly Offering[]) =>
  placed.every((other) => conflictsBetween(offering, other).length === 0);

interface Spread {
  days: number;
  gapMinutes: number;
  earliestStart: number;
  latestEnd: number;
}

/** How a week sits on the clock: days used, time waited, and its edges. */
export function spread(offerings: readonly Offering[]): Spread {
  const byDay = new Map<number, { start: number; end: number }[]>();
  for (const offering of offerings) {
    for (const meeting of offering.meetings) {
      for (const day of meeting.days) {
        byDay.set(day, [...(byDay.get(day) ?? []), { start: meeting.start, end: meeting.end }]);
      }
    }
  }

  let gapMinutes = 0;
  let earliestStart = Number.POSITIVE_INFINITY;
  let latestEnd = Number.NEGATIVE_INFINITY;
  for (const slots of byDay.values()) {
    const sorted = [...slots].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      gapMinutes += Math.max(0, sorted[i]!.start - sorted[i - 1]!.end);
    }
    earliestStart = Math.min(earliestStart, sorted[0]!.start);
    latestEnd = Math.max(latestEnd, ...sorted.map((s) => s.end));
  }

  return {
    days: byDay.size,
    gapMinutes,
    // A week with no scheduled meeting at all has no edges; zero is the
    // neutral value for every comparison that reads them.
    earliestStart: Number.isFinite(earliestStart) ? earliestStart : 0,
    latestEnd: Number.isFinite(latestEnd) ? latestEnd : 0,
  };
}

/**
 * A week's cost, lowest better, compared term by term.
 *
 * Lexicographic rather than weighted, because a weighted sum invites someone
 * to tune the weights until the answer is the one they wanted. Every entry
 * here is a sentence a student would agree with out loud.
 */
function cost(offerings: readonly Offering[], shape: Shape): number[] {
  const full = offerings.filter((o) => o.seats.available <= 0).length;
  const { days, gapMinutes, earliestStart, latestEnd } = spread(offerings);
  const open = offerings.reduce((n, o) => n + Math.max(0, o.seats.available), 0);

  if (shape === "early") {
    // Done for the day as early as possible, then the usual tidiness.
    return [full, latestEnd, days, gapMinutes, -open];
  }
  if (shape === "late") {
    // Nothing before it has to be. A later first class is a lower cost.
    return [full, -earliestStart, days, gapMinutes, -open];
  }
  return [full, days, gapMinutes, latestEnd, -open];
}

const cheaper = (a: number[], b: number[] | null) => {
  if (!b) return true;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
};

/**
 * Picks one section per course so that nothing collides.
 *
 * Courses with the fewest places to go are decided first, which is what makes
 * the search cheap: a course with one section either fits or ends the branch,
 * and finding that out late means exploring everything above it twice.
 */
export function arrange(
  choices: readonly SectionChoice[],
  options: ArrangeOptions = {},
): Arrangement {
  const pinned = options.pinned ?? new Set<string>();
  const shape = options.shape ?? "compact";
  const budget = options.budget ?? DEFAULT_BUDGET;

  const forced: { code: string; offering: Offering }[] = [];
  const open: SectionChoice[] = [];
  const unplaceable: Unplaced[] = [];

  for (const choice of choices) {
    const pin = choice.offerings.find((o) => pinned.has(o.id));
    if (pin) forced.push({ code: choice.code, offering: pin });
    else if (choice.offerings.length === 0) {
      unplaceable.push({ code: choice.code, why: "no section is offered this term" });
    } else open.push(choice);
  }

  const held = forced.map((f) => f.offering);

  // Sections that cannot sit beside the pins are off the table before the
  // search starts, which is also how we can say *why* a course went unplaced.
  const viable = open.map((choice) => ({
    code: choice.code,
    offerings: choice.offerings.filter((o) => fitsWith(o, held)),
  }));

  const order = [...viable].sort(
    (a, b) => a.offerings.length - b.offerings.length || a.code.localeCompare(b.code),
  );

  interface Best {
    chosen: Map<string, Offering>;
    unplaced: Unplaced[];
  }

  let explored = 0;
  // Held on an object rather than in two locals: a function call invalidates
  // what the compiler believes about a property, which is exactly the truth
  // here — `walk` is what fills these in.
  const found: { best: Best | null; cost: number[] | null } = { best: null, cost: null };

  const chosen = new Map<string, Offering>();
  const unplaced: Unplaced[] = [];

  const consider = () => {
    const all = [...held, ...chosen.values()];
    // Unplaced courses dominate everything: a week missing a course is worse
    // than any arrangement of a week that holds them all.
    const score = [unplaced.length + unplaceable.length, ...cost(all, shape)];
    if (!cheaper(score, found.cost)) return;
    found.cost = score;
    found.best = { chosen: new Map(chosen), unplaced: [...unplaced] };
  };

  const walk = (at: number) => {
    if (explored >= budget) return;
    explored++;
    if (at === order.length) {
      consider();
      return;
    }

    const course = order[at]!;
    const placed = [...held, ...chosen.values()];
    const fits = course.offerings.filter((o) => fitsWith(o, placed));

    for (const offering of fits) {
      chosen.set(course.code, offering);
      walk(at + 1);
      chosen.delete(course.code);
      if (explored >= budget) return;
    }

    // Leaving it out is a last resort, and only worth exploring when the
    // course had nowhere to go — otherwise every branch would double.
    if (fits.length === 0) {
      unplaced.push({
        code: course.code,
        why: course.offerings.length
          ? "every section clashes with something else in this term"
          : "every section clashes with a section you pinned",
      });
      walk(at + 1);
      unplaced.pop();
    }
  };

  walk(0);

  const result = new Map<string, Offering>(found.best?.chosen ?? []);
  for (const { code, offering } of forced) result.set(code, offering);

  const all = [...result.values()];
  const { days, gapMinutes } = spread(all);
  return {
    chosen: result,
    pinned,
    unplaced: [...unplaceable, ...(found.best?.unplaced ?? [])],
    days,
    gapMinutes,
    full: all.filter((o) => o.seats.available <= 0).length,
    explored,
    exhaustive: explored < budget,
  };
}
