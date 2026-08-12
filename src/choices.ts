/**
 * What each remaining choice actually costs.
 *
 * A degree audit shows a student a pool — "one laboratory course from the
 * biological sciences", forty-one qualifying courses — and leaves them to it.
 * That framing hides the only thing that matters, which is that the courses in
 * a pool are not interchangeable. One of them is already required by the minor
 * and costs nothing. One has a two-term prerequisite chain and moves
 * graduation a year. The pool says neither.
 *
 * So every candidate is priced the honest way: solve the whole plan without
 * it, solve it again with that course pinned, and report the difference in
 * finish term and in credits. Expensive, and worth it — the answer is the
 * question the student is actually asking.
 */

import { type Plan, type PlanRequest, projectPlan, type TermSlot } from "./planner";
import { type Graph, prerequisitesOf } from "./prereqs";
import {
  coursesNeededAcross,
  groupKey,
  type NeedOptions,
  type OpenChoice,
  type ProgramTree,
  type Unenumerable,
} from "./requirements";

export interface Candidate {
  code: string;
  credits: number;
  /**
   * Terms this choice adds to the finish date, against the cheapest plan.
   * Zero means free: taking it costs nothing you were not already paying.
   * Null means the plan no longer finishes inside the horizon at all.
   */
  addedTerms: number | null;
  /** Credits it adds beyond the baseline plan. Zero when already required. */
  addedCredits: number;
  /** Prerequisites this choice drags in, which are part of its price. */
  requires: string[];
  /** Requirements it would satisfy, across every program selected. */
  satisfies: { program: string; text: string }[];
  /** Already required outright, so there is nothing here to decide. */
  forced: boolean;
}

export interface RankedChoice {
  program: string;
  text: string;
  /** Credits the group still wants. */
  credits: number;
  ids: Unenumerable["ids"];
  /** Cheapest first, then fewest added credits, then alphabetical. */
  candidates: Candidate[];
}

export interface Ranking {
  choices: RankedChoice[];
  /** The plan with nothing pinned beyond what the caller already pinned. */
  baseline: Plan;
  /** Groups still not expandable, carried through so nothing is hidden. */
  unenumerable: Unenumerable[];
  /** Courses counting toward more than one selected program. */
  shared: { code: string; programs: string[] }[];
}

export interface RankOptions extends NeedOptions {
  graph: Graph;
  offeredIn: PlanRequest["offeredIn"];
  slots: TermSlot[];
  aliases?: PlanRequest["aliases"];
  /**
   * Cap on how many courses in a pool get priced. Pools run to 168 courses and
   * each price is a full re-solve, so the long tail is trimmed — but only
   * after the free ones are found, which is where the answer usually is.
   */
  limit?: number;
}

/** Where a term falls in the run of slots, or null if the plan never lands. */
function finishIndex(plan: Plan, slots: readonly TermSlot[]): number | null {
  if (!plan.finishes || plan.unscheduled.length) return null;
  const at = slots.findIndex((s) => s.name === plan.finishes);
  return at < 0 ? null : at;
}

function planFor(need: Iterable<string>, options: RankOptions): Plan {
  return projectPlan({
    need,
    completed: options.have,
    graph: options.graph,
    credits: options.credits,
    offeredIn: options.offeredIn,
    slots: options.slots,
    ...(options.aliases ? { aliases: options.aliases } : {}),
  });
}

/**
 * Price every open choice across a set of programs.
 *
 * The baseline is solved once. Each candidate is then solved with that one
 * course pinned, which is what makes "free" mean something precise: the plan
 * with it finishes no later than the plan without it.
 */
export function rankChoices(trees: readonly ProgramTree[], options: RankOptions): Ranking {
  const solved = coursesNeededAcross(trees, options);
  const baseline = planFor(solved.courses, options);
  const baseAt = finishIndex(baseline, options.slots);
  const baseCredits = baseline.totalCredits;

  // Which programs want a course, gathered before ranking so a candidate can
  // say "this one counts toward both your major and your minor".
  const wanted = new Map<string, { program: string; text: string }[]>();
  for (const choice of solved.choices) {
    for (const code of choice.pool) {
      wanted.set(code, [
        ...(wanted.get(code) ?? []),
        { program: choice.program, text: choice.text },
      ]);
    }
  }

  // One price per course, not per course per group: the same course costs the
  // same whichever pool it was reached from, and pools overlap heavily.
  type Price = { addedTerms: number | null; addedCredits: number; requires: string[] };
  const priced = new Map<string, Price>();
  const price = (code: string): Price => {
    const cached = priced.get(code);
    if (cached) return cached;

    // Choosing a course chooses its prerequisites too, and they cost real
    // terms. Pinning the course alone would leave it unschedulable and report
    // the choice as impossible rather than merely expensive.
    const requires = [...prerequisitesOf(options.graph, code, options.have)];
    const pinned = new Set([...(options.pinned ?? []), code, ...requires]);
    const withIt = coursesNeededAcross(trees, { ...options, pinned });
    const plan = planFor(withIt.courses, options);
    const at = finishIndex(plan, options.slots);

    const result: Price = {
      addedTerms: at === null || baseAt === null ? null : Math.max(0, at - baseAt),
      addedCredits: Math.max(0, plan.totalCredits - baseCredits),
      requires,
    };
    priced.set(code, result);
    return result;
  };

  const choices: RankedChoice[] = [];
  for (const choice of solved.choices) {
    // Anything the baseline already buys is free by construction, so it is
    // priced without a re-solve and always sorts first.
    const free: Candidate[] = [];
    const rest: string[] = [];
    for (const code of choice.pool) {
      if (options.have.has(code)) continue;
      if (!solved.courses.has(code)) {
        rest.push(code);
        continue;
      }
      free.push({
        code,
        credits: options.credits(code),
        addedTerms: 0,
        addedCredits: 0,
        requires: [],
        satisfies: wanted.get(code) ?? [],
        forced: true,
      });
    }

    const budget = Math.max(0, (options.limit ?? 40) - free.length);
    const ranked = rest.slice(0, budget).map((code) => ({
      code,
      credits: options.credits(code),
      ...price(code),
      satisfies: wanted.get(code) ?? [],
      forced: false,
    }));

    choices.push({
      program: choice.program,
      text: choice.text,
      credits: choice.credits,
      ids: choice.ids,
      // Cheapest in terms first; anything that does not finish at all sorts
      // last, however few credits it looks like.
      candidates: [...free, ...ranked].sort(
        (a, b) =>
          (a.addedTerms ?? Number.POSITIVE_INFINITY) - (b.addedTerms ?? Number.POSITIVE_INFINITY) ||
          a.addedCredits - b.addedCredits ||
          b.satisfies.length - a.satisfies.length ||
          a.code.localeCompare(b.code),
      ),
    });
  }

  // Courses paying into more than one program: the reason to double major.
  const shared: { code: string; programs: string[] }[] = [];
  for (const code of solved.courses) {
    const programs = [...new Set((wanted.get(code) ?? []).map((w) => w.program))];
    if (programs.length > 1) shared.push({ code, programs });
  }

  return {
    choices: dedupe(choices),
    baseline,
    unenumerable: solved.unenumerable,
    shared: shared.sort((a, b) => a.code.localeCompare(b.code)),
  };
}

/**
 * Collapses groups that are the same requirement seen from two programs.
 *
 * A major and a minor in the same school both carry the general-education
 * literature slot, with the same id and the same pool. Showing it twice asks
 * the student to make one decision two times.
 */
function dedupe(choices: RankedChoice[]): RankedChoice[] {
  const seen = new Map<string, RankedChoice>();
  for (const choice of choices) {
    const key = groupKey(choice.ids);
    const already = seen.get(key);
    if (!already) {
      seen.set(key, choice);
      continue;
    }
    if (!already.program.includes(choice.program)) {
      already.program = `${already.program} + ${choice.program}`;
    }
  }
  return [...seen.values()];
}
