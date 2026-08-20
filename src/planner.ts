/**
 * Projecting the terms it takes to finish.
 *
 * The planner answers the question a credit total cannot: *when*. Two things
 * decide that, and only one of them is arithmetic. Credits set a floor, but a
 * chain of prerequisites four deep cannot be compressed by taking a heavier
 * load, and a course taught only in spring cannot move to autumn.
 *
 * Everything here is a projection, not a promise. Future terms are modelled
 * from the seasons a course was observed in, because Colleague publishes only
 * the next term or two.
 */

import { eligibility, type Graph } from "./prereqs";

export type Season = "fall" | "spring" | "summer";

export interface TermSlot {
  /** "SP27", "SU27". */
  name: string;
  season: Season;
  /** Calendar year the term falls in, which decides an alternate-year course. */
  year: number;
  /** Credits allowed. Block tuition usually caps the regular terms. */
  capacity: number;
  /**
   * Credits below which a term is not worth opening. Twelve is full time at
   * Cedarville, and a plan that strands three credits in a term of their own
   * has quietly made the student part time for a semester.
   */
  minimum?: number;
}

export interface PlanRequest {
  /** Course codes still required. */
  need: Iterable<string>;
  /** Already passed. In-progress work counts, since a plan starts after it. */
  completed: ReadonlySet<string>;
  graph: Graph;
  credits: (code: string) => number;
  /** Whether a course is taught in a season, as far as we have seen. */
  offeredIn: (code: string, slot: TermSlot) => boolean;
  /** Codes that count as a given course, for transcripts from older catalogs. */
  aliases?: (code: string) => string[];
  /**
   * Keep every semester at or above its minimum: hold work back from a summer
   * that would strand one, and move courses between terms when that is what it
   * takes. On by default. A part-time semester costs a student their status,
   * their aid and often their insurance, where an even spread costs nothing at
   * all. Turn it off to fill every term as early as it fits.
   */
  keepSemestersFull?: boolean;
  slots: TermSlot[];
}

export interface PlannedCourse {
  code: string;
  credits: number;
  /** Named prerequisites we could not verify; shown rather than assumed away. */
  caution?: string;
}

export interface PlannedTerm {
  slot: TermSlot;
  courses: PlannedCourse[];
  credits: number;
  /**
   * Below the slot's minimum, so the student would be part time. Reported
   * rather than avoided: a light term is fixed by adding a course, and
   * rearranging the degree around it costs a great deal more.
   */
  short?: boolean;
}

export interface Plan {
  terms: PlannedTerm[];
  /** The last term with anything in it, or null when nothing was scheduled. */
  finishes: string | null;
  totalCredits: number;
  /** Never placed: no season fits, or the slots ran out. */
  unscheduled: { code: string; why: string }[];
}

/**
 * Earliest-fit, prerequisites first.
 *
 * Within a term, courses are ordered by how much they unlock, so the things
 * that gate other things get taken early. That is the whole reason a greedy
 * pass is good enough here: the binding constraint is nearly always the
 * longest chain, and putting gates first is exactly how you shorten it.
 */
export function projectPlan(request: PlanRequest): Plan {
  const { graph, credits, offeredIn, slots, aliases, keepSemestersFull = true } = request;
  const taken = new Set(request.completed);
  // Callers assemble `need` from requirement pools, which happily list work
  // already done; scheduling it again would invent terms out of nothing.
  const remaining = new Set([...request.need].filter((code) => !taken.has(code)));

  // How many courses sit behind this one. Precomputed; the graph is static.
  const leverage = new Map<string, number>();
  for (const code of remaining) leverage.set(code, countDownstream(graph, code));

  const terms: PlannedTerm[] = [];

  for (const [at, slot] of slots.entries()) {
    if (remaining.size === 0) break;

    const courses: PlannedCourse[] = [];
    let used = 0;

    // What this summer may take out of the semester behind it, if anything.
    const ration =
      keepSemestersFull && slot.season === "summer"
        ? summerRation(
            slot,
            slots.slice(at + 1).find((s) => s.minimum !== undefined),
            remaining,
            credits,
            offeredIn,
          )
        : null;
    let rationed = 0;

    const candidates = [...remaining]
      .filter((code) => offeredIn(code, slot))
      .sort((a, b) => (leverage.get(b) ?? 0) - (leverage.get(a) ?? 0) || a.localeCompare(b));

    for (const code of candidates) {
      const price = credits(code);
      if (used + price > slot.capacity) continue;

      // A course that gates another belongs as early as it fits, whatever it
      // costs the term after; only the leaves are held back.
      if (ration?.contested.has(code) && (leverage.get(code) ?? 0) === 0) {
        if (rationed + price > ration.allowance) continue;
        rationed += price;
      }

      const node = graph.courses.get(code) ?? { code, title: "", requisites: [] };
      // Courses chosen earlier this term satisfy a corequisite but not a
      // prerequisite, which `eligibility` already distinguishes.
      // The graph knows every course the catalog lists, so it is also the
      // authority on which requisite references have gone stale.
      const verdict = eligibility(node, taken, new Set(courses.map((c) => c.code)), {
        exists: (c) => graph.courses.has(c),
        ...(aliases ? { aliases } : {}),
      });

      // A named-but-unverifiable prerequisite is still a prerequisite. Reading
      // only `state` here once let a four-course Bible chain collapse into one
      // term, because its text carries a minimum-grade clause we cannot parse.
      if (verdict.blockedBy.length > 0) continue;

      courses.push({
        code,
        credits: price,
        ...(verdict.state === "unknown" ? { caution: verdict.why.join(" ") } : {}),
      });
      used += price;
    }

    // A term below full time is worth flagging, not worth refusing. Deferring
    // the work to protect the student's status pushes the degree out a term,
    // when the real remedy is cheaper: add a course. Say which terms are light
    // and let them decide.
    const short = slot.minimum !== undefined && used > 0 && used < slot.minimum;

    for (const c of courses) {
      taken.add(c.code);
      remaining.delete(c.code);
    }
    terms.push({ slot, courses, credits: used, ...(short ? { short: true } : {}) });
  }

  // The greedy pass is right term by term and can still be wrong across them,
  // leaving a semester below full time behind three at their cap.
  if (keepSemestersFull) redistribute(terms, graph, offeredIn);

  const unscheduled = [...remaining].map((code) => ({
    code,
    // A course no slot would accept was never schedulable; one every slot
    // would accept simply never came up.
    why: slots.some((slot) => offeredIn(code, slot))
      ? "ran out of terms"
      : "not taught in any term this plan covers",
  }));

  const lastWithWork = [...terms].reverse().find((t) => t.courses.length);
  return {
    terms: terms.filter((t) => t.courses.length),
    finishes: lastWithWork?.slot.name ?? null,
    totalCredits: terms.reduce((n, t) => n + t.credits, 0),
    unscheduled,
  };
}

/**
 * What a summer may take out of the semester behind it.
 *
 * A summer filled to the brim can leave the semester after it half empty, and
 * the two are not equally cheap: a light summer costs nothing, where a part
 * time semester costs a student their status and their aid. So the summer may
 * take everything the semester cannot use, plus whatever the semester can
 * spare above its minimum, and no more.
 *
 * Null means take what you like: either there is no semester to protect, or
 * the work all fits in this summer and the degree ends here.
 */
function summerRation(
  slot: TermSlot,
  next: TermSlot | undefined,
  remaining: ReadonlySet<string>,
  credits: (code: string) => number,
  offeredIn: PlanRequest["offeredIn"],
): { allowance: number; contested: Set<string> } | null {
  if (!next?.minimum) return null;

  const left = [...remaining].reduce((n, code) => n + credits(code), 0);
  if (left <= slot.capacity) return null;

  // Only work the next semester could actually take is contested; a course
  // taught in summer alone is nobody else's to lose.
  const contested = new Set<string>();
  let available = 0;
  for (const code of remaining) {
    if (!offeredIn(code, next)) continue;
    contested.add(code);
    available += credits(code);
  }
  return { allowance: Math.max(0, available - next.minimum), contested };
}

/**
 * Fills a part-time semester out of the terms before it.
 *
 * Packing each term to its cap in turn is right until it leaves one semester
 * at nine credits behind three at sixteen. The cap is a budget and the minimum
 * is a cliff, so a student would rather carry thirteen twice than be part time
 * once — and the same courses in a different order costs nothing.
 *
 * Only whole moves count. A semester lifted from nine to eleven is still part
 * time, so a redistribution that cannot reach the minimum is not made at all;
 * shuffling a plan to no end is worse than leaving it legible.
 */
function redistribute(
  terms: PlannedTerm[],
  graph: Graph,
  offeredIn: PlanRequest["offeredIn"],
): void {
  const where = new Map<string, number>();
  terms.forEach((term, at) => {
    for (const c of term.courses) where.set(c.code, at);
  });

  for (const [at, term] of terms.entries()) {
    const minimum = term.slot.minimum;
    if (minimum === undefined || term.courses.length === 0 || term.credits >= minimum) continue;

    const lent = new Map<number, number>();
    const moving: { from: number; course: PlannedCourse }[] = [];
    let held = term.credits;

    while (held < minimum) {
      const room = term.slot.capacity - held;
      let best: { from: number; course: PlannedCourse } | null = null;

      for (const [from, source] of terms.slice(0, at).entries()) {
        const after = source.credits - (lent.get(from) ?? 0);
        for (const course of source.courses) {
          if (course.credits > room) continue;
          if (moving.some((m) => m.course === course)) continue;
          // A term may empty entirely, but it may not go part time to spare
          // another one: that trades the problem rather than solving it.
          const left = after - course.credits;
          if (left > 0 && left < (source.slot.minimum ?? 0)) continue;
          if (!offeredIn(course.code, term.slot)) continue;
          // Whatever waits on this course must still wait on it.
          const waiting = graph.unlocks.get(course.code) ?? [];
          if ([...waiting].some((d) => (where.get(d) ?? Number.POSITIVE_INFINITY) <= at)) continue;
          // Nearest term first, then the biggest course in it: a plan the
          // student may already have in mind should change as little as it can,
          // and borrowing from next autumn beats borrowing from two years ago.
          const better =
            best === null ||
            from > best.from ||
            (from === best.from && course.credits > best.course.credits);
          if (better) best = { from, course };
        }
      }

      if (!best) break;
      moving.push(best);
      lent.set(best.from, (lent.get(best.from) ?? 0) + best.course.credits);
      held += best.course.credits;
    }

    if (held < minimum) continue;

    for (const { from, course } of moving) {
      const source = terms[from] as PlannedTerm;
      source.courses = source.courses.filter((c) => c !== course);
      source.credits -= course.credits;
      term.courses.push(course);
      term.credits += course.credits;
      where.set(course.code, at);
    }
  }

  for (const term of terms) {
    if (term.slot.minimum !== undefined && term.credits > 0 && term.credits < term.slot.minimum) {
      term.short = true;
    } else {
      delete term.short;
    }
  }
}

function countDownstream(graph: Graph, code: string): number {
  const seen = new Set<string>();
  const queue = [code];
  while (queue.length) {
    for (const next of graph.unlocks.get(queue.pop()!) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen.size;
}

/**
 * A run of terms starting after the one in progress. Summers carry less
 * because they are shorter, not because anyone chooses to go easy.
 */
export function termsFrom(
  start: { year: number; season: "spring" | "fall" },
  count: number,
  options: {
    capacity?: number;
    summerCapacity?: number;
    /**
     * How many summers to open, earliest first. Zero plans none. A student
     * willing to give up one summer is not thereby willing to give up five,
     * and the difference is a year of their life either way.
     */
    summers?: number;
    /** Applied to autumn and spring only; a summer is part time by nature. */
    minimum?: number;
  } = {},
): TermSlot[] {
  const {
    capacity = 18,
    summerCapacity = 7,
    summers = Number.POSITIVE_INFINITY,
    minimum,
  } = options;
  const slots: TermSlot[] = [];
  let opened = 0;
  let { year, season } = start;

  while (slots.length < count) {
    const yy = String(year).slice(2);
    slots.push({
      name: `${season === "spring" ? "SP" : "FA"}${yy}`,
      season,
      year,
      capacity,
      ...(minimum ? { minimum } : {}),
    });
    if (season === "spring") {
      if (opened < summers) {
        opened++;
        slots.push({
          name: `SU${yy}`,
          season: "summer",
          year,
          capacity: summerCapacity,
        });
      }
      season = "fall";
    } else {
      season = "spring";
      year++;
    }
  }
  return slots;
}

/** The longest prerequisite chain still ahead, which is the floor on terms. */
export function criticalPath(graph: Graph, need: Iterable<string>, completed: ReadonlySet<string>) {
  let longest: string[] = [];

  const walk = (code: string, seen: Set<string>): string[] => {
    if (completed.has(code) || seen.has(code)) return [];
    const node = graph.courses.get(code);
    if (!node) return [code];

    let best: string[] = [];
    for (const requisite of node.requisites) {
      if (!requisite.required) continue;
      for (const prereq of requisite.courses) {
        const chain = walk(prereq, new Set([...seen, code]));
        if (chain.length > best.length) best = chain;
      }
    }
    return [...best, code];
  };

  for (const code of need) {
    const chain = walk(code, new Set());
    if (chain.length > longest.length) longest = chain;
  }
  return longest;
}
