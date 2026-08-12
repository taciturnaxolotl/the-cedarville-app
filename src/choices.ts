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

import { type Plan, type PlanRequest, projectPlan, type Season, type TermSlot } from "./planner";
import { type Graph, prerequisitesOf } from "./prereqs";
import {
  type BranchOption,
  coursesNeededAcross,
  groupKey,
  type NeedOptions,
  type ProgramTree,
  type Shortfall,
  type Unenumerable,
} from "./requirements";

export interface Candidate {
  code: string;
  credits: number;
  /**
   * Terms this choice adds to the finish date, against the current plan.
   * Zero means free: taking it costs nothing you were not already paying.
   * Negative means it would bring the date in — which happens once something
   * dearer has been pinned and this is the way back.
   *
   * Null is the narrow case of a course that cannot be scheduled at all —
   * itself or its chain stranded, or something else pushed off the end by
   * taking it. It is not a way of saying "we are unsure".
   */
  addedTerms: number | null;
  /** Credits it adds beyond the baseline plan. Zero when already required. */
  addedCredits: number;
  /** Prerequisites this choice drags in, which are part of its price. */
  requires: string[];
  /**
   * The term the projection puts this course in, when it fits. "SP28" answers
   * "when would I actually take this", which a credit count never does.
   */
  lands?: string;
  /**
   * Seasons the course has been seen taught in. Empty means every listing we
   * hold is silent about it, which is not the same as never — Colleague
   * publishes a term or two ahead, so an unread season proves nothing.
   */
  offered: Season[];
  /**
   * What taking this pushes off the end of the plan. The reason a choice will
   * not schedule is nearly always something else it displaces, and naming that
   * is the difference between a refusal and an explanation.
   */
  displaces: string[];
  /** Requirements it would satisfy, across every program selected. */
  satisfies: { program: string; text: string }[];
  /**
   * Required outright by some other part of the degree, so choosing it here
   * costs nothing and settles this requirement. Not the same as "the cheapest
   * solution happens to buy it": a course the cover picked *for this group*
   * cannot then be said to have settled it.
   */
  forced: boolean;
  /** The cheapest solution picks this, though nothing forces it. */
  chosen: boolean;
}

export interface RankedChoice {
  program: string;
  text: string;
  /** Credits the group still wants. */
  credits: number;
  ids: Unenumerable["ids"];
  /**
   * Set when the group's text names the course this combination of programs
   * must take, so the pool below is one course by rule rather than by choice.
   */
  mandated?: string;
  /**
   * Courses in this pool the student has already passed or is taking. They
   * never appear as candidates — there is nothing to decide about a course you
   * have done — but they are why a requirement can be met with an empty-looking
   * list of options.
   */
  satisfiedBy: { code: string; credits: number }[];
  /** Cheapest first, then fewest added credits, then alphabetical. */
  candidates: Candidate[];
}

/** One way of satisfying a track or concentration, priced like a course. */
export interface RankedBranchOption extends BranchOption {
  addedTerms: number | null;
  addedCredits: number;
  /** Whether this is the option the current solve took. */
  taken: boolean;
}

export interface RankedBranch {
  program: string;
  key: string;
  text: string;
  pick: number;
  options: RankedBranchOption[];
}

export interface Ranking {
  /**
   * Tracks and concentrations, priced. These come first in the interface for
   * the same reason they come first here: choosing the AI track over technical
   * electives moves more than any single elective inside it.
   */
  branches: RankedBranch[];
  choices: RankedChoice[];
  /** The plan with nothing pinned beyond what the caller already pinned. */
  baseline: Plan;
  /** Groups still not expandable, carried through so nothing is hidden. */
  unenumerable: Unenumerable[];
  /** Courses counting toward more than one selected program. */
  shared: { code: string; programs: string[] }[];
  /** Requirements the courses on offer cannot close, usually a repeated course. */
  shortfalls: Shortfall[];
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

/**
 * Where a term falls in the run of slots.
 *
 * Always a number. An earlier version returned null when the plan left
 * anything unplaced, which sounds careful and is not: one stranded course in
 * the baseline then made every candidate in every pool report "does not fit",
 * because the comparison was against nothing.
 */
function finishIndex(plan: Plan, slots: readonly TermSlot[]): number {
  if (!plan.finishes) return slots.length;
  const at = slots.findIndex((s) => s.name === plan.finishes);
  return at < 0 ? slots.length : at;
}

/**
 * A course set closed over its prerequisites.
 *
 * A requirement pool lists what satisfies it, never what that costs to reach.
 * `LIT-2090` closes the literature slot and needs `LIT-1990` first, which no
 * requirement asks for — so the projection took `LIT-2090`, found it blocked
 * every term, and reported it unplaceable. The chain is part of the purchase.
 */
function closure(need: Iterable<string>, options: RankOptions): Set<string> {
  const all = new Set(need);
  // The plan itself is passed as `planned`, so a requisite offering a choice
  // reaches for a course already being taken before inventing a new chain.
  for (const code of [...all]) {
    for (const required of prerequisitesOf(options.graph, code, options.have, all)) {
      all.add(required);
    }
  }
  return all;
}

function planFor(need: Iterable<string>, options: RankOptions): Plan {
  return projectPlan({
    need: closure(need, options),
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
  // The cover chooses between courses; a course behind a language sequence is
  // not the bargain its own credit count suggests.
  const chained = (code: string) =>
    options.credits(code) +
    [...prerequisitesOf(options.graph, code, options.have)].reduce(
      (n, c) => n + options.credits(c),
      0,
    );
  options = { cost: chained, ...options };

  const solved = coursesNeededAcross(trees, options);
  const baseline = planFor(solved.courses, options);
  const baseAt = finishIndex(baseline, options.slots);
  const baseCredits = baseline.totalCredits;
  const baseUnplaced = baseline.unscheduled.length;

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

  // Memoised per pool: within a requirement, picking one course means not
  // picking another, so the same course can cost differently in two pools.
  const SEASONS: Season[] = ["fall", "spring", "summer"];
  // Reporting which seasons a course runs in is a question about the course,
  // not about any particular term, so it is asked of a representative slot.
  const seasonSlot = (season: Season): TermSlot =>
    options.slots.find((s) => s.season === season) ?? {
      name: season,
      season,
      year: new Date().getFullYear(),
      capacity: 0,
    };
  const baseStranded = new Set(baseline.unscheduled.map((u) => u.code));

  type Price = {
    addedTerms: number | null;
    addedCredits: number;
    requires: string[];
    lands?: string;
    offered: Season[];
    displaces: string[];
  };
  const priced = new Map<string, Price>();
  const price = (code: string, pool: readonly string[]): Price => {
    // Keyed by pool as well as course: a swap inside one requirement is a
    // different question from the same swap inside another.
    const key = `${pool.join(",")}|${code}`;
    const cached = priced.get(key);
    if (cached) return cached;

    // Choosing a course chooses its prerequisites too, and they cost real
    // terms. Pinning the course alone would leave it unschedulable and report
    // the choice as impossible rather than merely expensive.
    const requires = [...prerequisitesOf(options.graph, code, options.have, solved.courses)];
    // Within a requirement this is a swap, not an addition: picking one course
    // from a pool means not picking another. Adding it on top would price the
    // cheap alternative to an expensive pin as though you would take both, and
    // a student looking to undo a costly choice would be told it costs more.
    const kept = [...(options.pinned ?? [])].filter((c) => c === code || !pool.includes(c));
    const pinned = new Set([...kept, code, ...requires]);
    const withIt = coursesNeededAcross(trees, { ...options, pinned });
    const plan = planFor(withIt.courses, options);

    // Unschedulable means *this* course could not be placed, or taking it
    // stranded something that fitted before. A course stranded in the
    // baseline for its own reasons is not this candidate's fault.
    const stranded = new Set(plan.unscheduled.map((u) => u.code));
    const blocked =
      stranded.has(code) ||
      requires.some((r) => stranded.has(r)) ||
      plan.unscheduled.length > baseUnplaced;

    // Not clamped at zero. Once something expensive is pinned, the cheaper
    // alternatives genuinely shorten the plan, and a saving reported as "free"
    // is the one number a student most wants to see.
    const lands = plan.terms.find((t) => t.courses.some((c) => c.code === code))?.slot.name;
    const result: Price = {
      addedTerms: blocked ? null : finishIndex(plan, options.slots) - baseAt,
      addedCredits: plan.totalCredits - baseCredits,
      requires,
      ...(lands ? { lands } : {}),
      offered: SEASONS.filter((season) => options.offeredIn(code, seasonSlot(season))),
      displaces: plan.unscheduled.map((u) => u.code).filter((c) => !baseStranded.has(c)),
    };
    priced.set(key, result);
    return result;
  };

  // Price each way of satisfying a track by forcing it and re-solving, the
  // same trick used for courses one level down. Deduped first: the general
  // education requirements arrive once per program, and the student decides
  // their global-awareness route once, not once per major.
  const branches: RankedBranch[] = dedupeBy(solved.branches, (b) => b.key).map((branch) => ({
    program: branch.program,
    key: branch.key,
    text: branch.text,
    pick: branch.pick,
    options: branch.options.map((option) => {
      const taken = branch.chosen.includes(option.id);
      if (taken) {
        return { ...option, taken, addedTerms: 0, addedCredits: 0 };
      }
      const tracks = new Map(options.tracks ?? []);
      tracks.set(branch.key, [option.id]);
      const withIt = coursesNeededAcross(trees, { ...options, tracks });
      const plan = planFor(withIt.courses, options);
      return {
        ...option,
        taken,
        // Unclamped, like a course candidate: once a dearer track is chosen,
        // the other route is a saving, and saying "free" hides the number a
        // student is looking for.
        addedTerms:
          plan.unscheduled.length > baseUnplaced ? null : finishIndex(plan, options.slots) - baseAt,
        addedCredits: plan.totalCredits - baseCredits,
      };
    }),
  }));

  const choices: RankedChoice[] = [];
  for (const choice of solved.choices) {
    // Anything the baseline already buys is free by construction, so it is
    // priced without a re-solve and always sorts first.
    const free: Candidate[] = [];
    const rest: string[] = [];
    const satisfiedBy: { code: string; credits: number }[] = [];
    for (const code of choice.pool) {
      if (options.have.has(code)) {
        satisfiedBy.push({ code, credits: options.credits(code) });
        continue;
      }
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
        offered: SEASONS.filter((season) => options.offeredIn(code, seasonSlot(season))),
        displaces: [],
        ...(baseline.terms.find((t) => t.courses.some((c) => c.code === code))?.slot.name
          ? { lands: baseline.terms.find((t) => t.courses.some((c) => c.code === code))!.slot.name }
          : {}),
        satisfies: wanted.get(code) ?? [],
        forced: solved.required.has(code),
        chosen: true,
      });
    }

    const budget = Math.max(0, (options.limit ?? 40) - free.length);
    const ranked = rest.slice(0, budget).map((code) => ({
      code,
      credits: options.credits(code),
      ...price(code, choice.pool),
      satisfies: wanted.get(code) ?? [],
      forced: false,
      chosen: false,
    }));

    choices.push({
      program: choice.program,
      text: choice.text,
      credits: choice.credits,
      ids: choice.ids,
      ...(choice.mandated ? { mandated: choice.mandated } : {}),
      satisfiedBy,
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
    branches,
    choices: dedupe(choices),
    baseline,
    unenumerable: solved.unenumerable,
    shortfalls: solved.shortfalls,
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
/**
 * Keeps the first of each key, folding later programs into its label.
 *
 * Two majors in the same school carry the identical requirement, and the
 * student makes that decision once.
 */
function dedupeBy<T extends { key: string; program: string }>(
  items: readonly T[],
  key: (item: T) => string,
): T[] {
  const seen = new Map<string, T>();
  for (const item of items) {
    const already = seen.get(key(item));
    if (!already) {
      seen.set(key(item), { ...item });
      continue;
    }
    if (!already.program.includes(item.program)) {
      already.program = `${already.program} + ${item.program}`;
    }
  }
  return [...seen.values()];
}

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
