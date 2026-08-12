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
  /** Credits allowed. Block tuition usually caps the regular terms. */
  capacity: number;
}

export interface PlanRequest {
  /** Course codes still required. */
  need: Iterable<string>;
  /** Already passed. In-progress work counts, since a plan starts after it. */
  completed: ReadonlySet<string>;
  graph: Graph;
  credits: (code: string) => number;
  /** Whether a course is taught in a season, as far as we have seen. */
  offeredIn: (code: string, season: Season) => boolean;
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
  const { graph, credits, offeredIn, slots } = request;
  const taken = new Set(request.completed);
  // Callers assemble `need` from requirement pools, which happily list work
  // already done; scheduling it again would invent terms out of nothing.
  const remaining = new Set([...request.need].filter((code) => !taken.has(code)));

  // How many courses sit behind this one. Precomputed; the graph is static.
  const leverage = new Map<string, number>();
  for (const code of remaining) leverage.set(code, countDownstream(graph, code));

  const terms: PlannedTerm[] = [];

  for (const slot of slots) {
    if (remaining.size === 0) break;

    const courses: PlannedCourse[] = [];
    let used = 0;

    const candidates = [...remaining]
      .filter((code) => offeredIn(code, slot.season))
      .sort((a, b) => (leverage.get(b) ?? 0) - (leverage.get(a) ?? 0) || a.localeCompare(b));

    for (const code of candidates) {
      const price = credits(code);
      if (used + price > slot.capacity) continue;

      const node = graph.courses.get(code) ?? { code, title: "", requisites: [] };
      // Courses chosen earlier this term satisfy a corequisite but not a
      // prerequisite, which `eligibility` already distinguishes.
      const verdict = eligibility(node, taken, new Set(courses.map((c) => c.code)));

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

    for (const c of courses) {
      taken.add(c.code);
      remaining.delete(c.code);
    }
    terms.push({ slot, courses, credits: used });
  }

  const unscheduled = [...remaining].map((code) => ({
    code,
    why: (["fall", "spring", "summer"] as Season[]).some((s) => offeredIn(code, s))
      ? "ran out of terms"
      : "never observed in any term we have data for",
  }));

  const lastWithWork = [...terms].reverse().find((t) => t.courses.length);
  return {
    terms: terms.filter((t) => t.courses.length),
    finishes: lastWithWork?.slot.name ?? null,
    totalCredits: terms.reduce((n, t) => n + t.credits, 0),
    unscheduled,
  };
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
  options: { capacity?: number; summerCapacity?: number; includeSummers?: boolean } = {},
): TermSlot[] {
  const { capacity = 18, summerCapacity = 7, includeSummers = true } = options;
  const slots: TermSlot[] = [];
  let { year, season } = start;

  while (slots.length < count) {
    const yy = String(year).slice(2);
    slots.push({
      name: `${season === "spring" ? "SP" : "FA"}${yy}`,
      season,
      capacity,
    });
    if (season === "spring") {
      if (includeSummers) {
        slots.push({ name: `SU${yy}`, season: "summer", capacity: summerCapacity });
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
