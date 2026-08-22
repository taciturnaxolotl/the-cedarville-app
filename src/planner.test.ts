import { describe, expect, test } from "bun:test";
import { criticalPath, projectPlan, type TermSlot, termsFrom } from "./planner";
import { buildGraph, type CourseNode, parseRequisite } from "./prereqs";

const BEFORE = "- Must be completed prior to taking this course.";
const req = (text: string, ext = BEFORE) =>
  parseRequisite({ DisplayText: text, DisplayTextExtension: ext, IsRequired: true });

const node = (code: string, ...texts: string[]): CourseNode => ({
  code,
  title: code,
  requisites: texts.map((t) => req(t)),
});

const CHAIN = [
  node("AA-1000"),
  node("AA-2000", "Take AA-1000"),
  node("AA-3000", "Take AA-2000"),
  node("AA-4000", "Take AA-3000"),
  node("BB-1000"),
  node("BB-1010"),
  node("BB-1020"),
];
const graph = buildGraph(CHAIN);

const plan = (
  need: string[],
  slots = termsFrom({ year: 2027, season: "spring" }, 6, { summers: 0 }),
  everywhere = true,
) =>
  projectPlan({
    need,
    completed: new Set(),
    graph,
    credits: () => 3,
    offeredIn: (code, slot) => everywhere || slot.season !== "summer" || code.startsWith("BB"),
    slots,
  });

describe("projecting terms", () => {
  test("independent courses share a term up to the cap", () => {
    const p = plan(["BB-1000", "BB-1010", "BB-1020"]);
    expect(p.terms).toHaveLength(1);
    expect(p.finishes).toBe("SP27");
    expect(p.terms[0]!.credits).toBe(9);
  });

  test("a chain takes one term per link, no matter the cap", () => {
    const p = plan(["AA-1000", "AA-2000", "AA-3000", "AA-4000"]);
    expect(p.terms.map((t) => t.courses.map((c) => c.code))).toEqual([
      ["AA-1000"],
      ["AA-2000"],
      ["AA-3000"],
      ["AA-4000"],
    ]);
    expect(p.finishes).toBe("FA28");
  });

  /**
   * Regression: BTGE-2740's prerequisite reads "Take BTGE-1725 and BTGE-2730
   * with a minimum grade of D-". The grade clause makes it unparseable, so
   * eligibility reports `unknown` — and an earlier planner that only skipped
   * `blocked` put the whole four-course chain in one term.
   */
  test("an unparseable prerequisite still orders the chain", () => {
    const messy = buildGraph([
      node("CC-1000"),
      node("CC-2000", "Take CC-1000 with a minimum grade of D-."),
    ]);
    const p = projectPlan({
      need: ["CC-1000", "CC-2000"],
      completed: new Set(),
      graph: messy,
      credits: () => 3,
      offeredIn: () => true,
      slots: termsFrom({ year: 2027, season: "spring" }, 4, { summers: 0 }),
    });
    expect(p.terms.map((t) => t.courses.map((c) => c.code))).toEqual([["CC-1000"], ["CC-2000"]]);
    // And the doubt is carried through rather than silently dropped.
    expect(p.terms[1]!.courses[0]!.caution).toContain("minimum grade");
  });

  test("gates go first, so a chain is not left until last", () => {
    const p = projectPlan({
      need: ["BB-1000", "AA-1000", "BB-1010"],
      completed: new Set(),
      graph,
      credits: () => 3,
      offeredIn: () => true,
      slots: [{ name: "SP27", season: "spring", year: 2027, capacity: 3 }],
    });
    // AA-1000 unlocks three; the BB courses unlock nothing.
    expect(p.terms[0]!.courses[0]!.code).toBe("AA-1000");
  });

  test("completed work is not scheduled again", () => {
    const p = projectPlan({
      need: ["AA-1000", "AA-2000"],
      completed: new Set(["AA-1000"]),
      graph,
      credits: () => 3,
      offeredIn: () => true,
      slots: termsFrom({ year: 2027, season: "spring" }, 3, { summers: 0 }),
    });
    expect(p.terms).toHaveLength(1);
    expect(p.terms[0]!.courses.map((c) => c.code)).toEqual(["AA-2000"]);
  });

  test("a course taught in no season we know is reported, not dropped", () => {
    const p = projectPlan({
      need: ["BB-1000"],
      completed: new Set(),
      graph,
      credits: () => 3,
      offeredIn: () => false,
      slots: termsFrom({ year: 2027, season: "spring" }, 4),
    });
    expect(p.terms).toHaveLength(0);
    expect(p.unscheduled[0]).toMatchObject({ code: "BB-1000" });
    expect(p.unscheduled[0]!.why).toContain("not taught in any term");
  });

  test("running out of terms is a different complaint", () => {
    const p = projectPlan({
      need: ["AA-1000", "AA-2000", "AA-3000", "AA-4000"],
      completed: new Set(),
      graph,
      credits: () => 3,
      offeredIn: () => true,
      slots: termsFrom({ year: 2027, season: "spring" }, 2, { summers: 0 }),
    });
    expect(p.unscheduled.map((u) => u.code)).toEqual(["AA-3000", "AA-4000"]);
    expect(p.unscheduled[0]!.why).toBe("ran out of terms");
  });

  test("season limits push a course to the term that teaches it", () => {
    const springOnly = (_code: string, slot: TermSlot) => slot.season === "spring";
    const p = projectPlan({
      need: ["BB-1000"],
      completed: new Set(),
      graph,
      credits: () => 3,
      offeredIn: springOnly,
      slots: [
        { name: "SU27", season: "summer", year: 2027, capacity: 7 },
        { name: "FA27", season: "fall", year: 2027, capacity: 18 },
        { name: "SP28", season: "spring", year: 2028, capacity: 18 },
      ],
    });
    expect(p.finishes).toBe("SP28");
  });
});

describe("term sequences", () => {
  test("alternates and inserts summers after spring", () => {
    expect(termsFrom({ year: 2027, season: "spring" }, 4).map((s) => s.name)).toEqual([
      "SP27",
      "SU27",
      "FA27",
      "SP28",
      "SU28",
    ]);
  });

  test("summers can be left out, and carry a smaller load", () => {
    expect(
      termsFrom({ year: 2027, season: "spring" }, 3, { summers: 0 }).map((s) => s.name),
    ).toEqual(["SP27", "FA27", "SP28"]);
    const withSummer = termsFrom({ year: 2027, season: "spring" }, 2);
    expect(withSummer.find((s) => s.season === "summer")?.capacity).toBe(7);
  });

  test("opens as many summers as asked for, earliest first", () => {
    // A student willing to give up one summer has not agreed to give up four.
    expect(
      termsFrom({ year: 2027, season: "spring" }, 8, { summers: 1 }).map((s) => s.name),
    ).toEqual(["SP27", "SU27", "FA27", "SP28", "FA28", "SP29", "FA29", "SP30"]);
  });
});

describe("critical path", () => {
  test("finds the longest chain, which is the floor on terms", () => {
    expect(criticalPath(graph, ["AA-4000", "BB-1000"], new Set())).toEqual([
      "AA-1000",
      "AA-2000",
      "AA-3000",
      "AA-4000",
    ]);
  });

  test("completed prerequisites shorten it", () => {
    expect(criticalPath(graph, ["AA-4000"], new Set(["AA-2000"]))).toEqual(["AA-3000", "AA-4000"]);
  });

  test("a cycle does not hang the walk", () => {
    const cyclic = buildGraph([node("XX-1000", "Take YY-1000"), node("YY-1000", "Take XX-1000")]);
    expect(criticalPath(cyclic, ["XX-1000"], new Set()).length).toBeLessThan(5);
  });
});

describe("a term below full time", () => {
  const two = buildGraph([
    { code: "AA-1000", title: "", requisites: [] },
    { code: "BB-1000", title: "", requisites: [] },
  ]);

  test("is flagged rather than avoided", () => {
    // Rearranging a degree around a light term costs a term; adding a course
    // costs a course. Say which terms are light and let the student decide.
    const p = projectPlan({
      need: ["AA-1000"],
      completed: new Set(),
      graph: two,
      credits: () => 3,
      offeredIn: () => true,
      slots: termsFrom({ year: 2027, season: "spring" }, 2, {
        capacity: 17,
        summers: 0,
        minimum: 12,
      }),
    });
    expect(p.terms[0]?.short).toBe(true);
    expect(p.unscheduled).toEqual([]);
  });

  test("a full term is not flagged", () => {
    const p = projectPlan({
      need: ["AA-1000", "BB-1000"],
      completed: new Set(),
      graph: two,
      credits: () => 6,
      offeredIn: () => true,
      slots: termsFrom({ year: 2027, season: "spring" }, 2, {
        capacity: 17,
        summers: 0,
        minimum: 12,
      }),
    });
    expect(p.terms[0]?.short).toBeUndefined();
  });

  test("no minimum means nothing to flag", () => {
    const p = projectPlan({
      need: ["AA-1000"],
      completed: new Set(),
      graph: two,
      credits: () => 3,
      offeredIn: () => true,
      slots: termsFrom({ year: 2027, season: "spring" }, 2, {
        capacity: 17,
        summers: 0,
      }),
    });
    expect(p.terms[0]?.short).toBeUndefined();
  });
});

describe("keeping the semesters full", () => {
  const five = ["AA", "BB", "CC", "DD", "EE"].map((s) => `${s}-1000`);
  const flat = buildGraph(five.map((code) => ({ code, title: "", requisites: [] })));

  /** Fifteen credits left, a seven-credit summer, a twelve-credit semester. */
  const tail = (keepSemestersFull: boolean) =>
    projectPlan({
      need: five,
      completed: new Set(),
      graph: flat,
      credits: () => 3,
      offeredIn: () => true,
      keepSemestersFull,
      slots: [
        { name: "SU27", season: "summer", year: 2027, capacity: 7 },
        { name: "FA27", season: "fall", year: 2027, capacity: 18, minimum: 12 },
      ],
    });

  test("holds work back rather than leave the semester behind it part time", () => {
    const p = tail(true);
    expect(p.terms.map((t) => t.credits)).toEqual([3, 12]);
    expect(p.terms.some((t) => t.short)).toBe(false);
  });

  test("fills the summer first when told to", () => {
    const p = tail(false);
    expect(p.terms.map((t) => t.credits)).toEqual([6, 9]);
    expect(p.terms[1]?.short).toBe(true);
  });

  test("still takes a summer that finishes the degree outright", () => {
    // Holding work back to protect a semester that has no work left in it
    // would push the date out for nothing.
    const p = projectPlan({
      need: ["AA-1000"],
      completed: new Set(),
      graph: flat,
      credits: () => 3,
      offeredIn: () => true,
      slots: [
        { name: "SU27", season: "summer", year: 2027, capacity: 7 },
        { name: "FA27", season: "fall", year: 2027, capacity: 18, minimum: 12 },
      ],
    });
    expect(p.finishes).toBe("SU27");
  });
});

describe("filling a part-time semester from the terms before it", () => {
  const eight = ["AA", "BB", "CC", "DD", "EE", "FF", "GG", "HH"].map((s) => `${s}-1000`);
  const flat = buildGraph(eight.map((code) => ({ code, title: "", requisites: [] })));

  const two = (capacity: number, minimum = 12) => [
    { name: "FA27", season: "fall" as const, year: 2027, capacity, minimum },
    { name: "SP28", season: "spring" as const, year: 2028, capacity, minimum },
  ];

  const project = (over: Partial<Parameters<typeof projectPlan>[0]> = {}) =>
    projectPlan({
      need: eight,
      completed: new Set(),
      graph: flat,
      credits: () => 3,
      offeredIn: () => true,
      slots: two(18),
      ...over,
    });

  test("carries twelve twice rather than eighteen and then six", () => {
    expect(project({ keepSemestersFull: false }).terms.map((t) => t.credits)).toEqual([18, 6]);
    expect(project().terms.map((t) => t.credits)).toEqual([12, 12]);
    expect(project().terms.some((t) => t.short)).toBe(false);
  });

  test("leaves the plan alone when no move can clear the minimum", () => {
    // Five courses in twelve-credit terms: every redistribution still strands
    // one below full time, and a shuffle to no end is worse than a plan the
    // student can read.
    const p = projectPlan({
      need: eight.slice(0, 5),
      completed: new Set(),
      graph: flat,
      credits: () => 3,
      offeredIn: () => true,
      slots: two(12),
    });
    expect(p.terms.map((t) => t.credits)).toEqual([12, 3]);
    expect(p.terms[1]?.short).toBe(true);
  });

  test("never lends a course the later term does not run", () => {
    const p = project({
      offeredIn: (code, slot) => slot.season === "fall" || code === "AA-1000",
    });
    // One movable course cannot close a six-credit gap, so nothing moves.
    expect(p.terms[0]?.credits).toBe(18);
  });

  test("keeps a course ahead of whatever waits on it", () => {
    const chained = buildGraph([
      { code: "AA-1000", title: "", requisites: [] },
      { code: "BB-1000", title: "", requisites: [req("Take AA-1000")] },
      ...eight.slice(2).map((code) => ({ code, title: "", requisites: [] })),
    ]);
    const p = projectPlan({
      need: eight,
      completed: new Set(),
      graph: chained,
      credits: () => 3,
      offeredIn: () => true,
      slots: two(18),
    });
    // BB-1000 sits in the first term, so AA-1000 cannot follow it into the
    // second however much the second wants the credits.
    expect(p.terms[0]?.courses.map((c) => c.code)).toContain("AA-1000");
    expect(p.terms.map((t) => t.credits)).toEqual([12, 12]);
  });
});

describe("a course that wants class standing", () => {
  const seminar = buildGraph([
    { code: "AA-1000", title: "", requisites: [] },
    { code: "BB-1000", title: "", requisites: [] },
    { code: "DD-1000", title: "", requisites: [] },
    { code: "CC-4010", title: "", requisites: [], standing: "senior" as const },
  ]);

  const project = (earnedCredits: number) =>
    projectPlan({
      need: ["AA-1000", "BB-1000", "DD-1000", "CC-4010"],
      completed: new Set(),
      graph: seminar,
      credits: () => 15,
      offeredIn: () => true,
      earnedCredits,
      slots: termsFrom({ year: 2027, season: "spring" }, 6, { capacity: 15, summers: 0 }),
    });

  const at = (plan: ReturnType<typeof projectPlan>, code: string) =>
    plan.terms.find((t) => t.courses.some((c) => c.code === code))?.slot.name;

  test("waits for the credits that standing takes", () => {
    // The catalog makes a senior at 91 hours. Starting at 61, two fifteen
    // credit terms get there, and the third is the first that may have it.
    expect(at(project(61), "CC-4010")).toBe("SP28");
    // One credit short is short: the same plan waits another term.
    expect(at(project(60), "CC-4010")).toBe("FA28");
  });

  test("goes straight in when the student is already a senior", () => {
    const p = projectPlan({
      need: ["CC-4010"],
      completed: new Set(),
      graph: seminar,
      credits: () => 15,
      offeredIn: () => true,
      earnedCredits: 91,
      slots: termsFrom({ year: 2027, season: "spring" }, 6, { capacity: 15, summers: 0 }),
    });
    expect(at(p, "CC-4010")).toBe("SP27");
  });

  test("says so rather than blaming the horizon", () => {
    // Nothing else is left to earn credits with, so the standing never comes.
    // "Ran out of terms" would send a student looking for a longer plan.
    const p = projectPlan({
      need: ["CC-4010"],
      completed: new Set(),
      graph: seminar,
      credits: () => 15,
      offeredIn: () => true,
      earnedCredits: 60,
      slots: termsFrom({ year: 2027, season: "spring" }, 6, { capacity: 15, summers: 0 }),
    });
    expect(p.unscheduled).toEqual([
      { code: "CC-4010", why: "needs senior standing, which this plan never reaches" },
    ]);
  });

  test("thresholds are the caller's to set", () => {
    const p = projectPlan({
      need: ["CC-4010"],
      completed: new Set(),
      graph: seminar,
      credits: () => 15,
      offeredIn: () => true,
      earnedCredits: 0,
      standingCredits: { sophomore: 0, junior: 0, senior: 0 },
      slots: termsFrom({ year: 2027, season: "spring" }, 6, { capacity: 15, summers: 0 }),
    });
    expect(at(p, "CC-4010")).toBe("SP27");
  });
});

describe("a term the student chose", () => {
  const placed = (placements: Record<string, string>, need: string[], everywhere = true) =>
    projectPlan({
      need,
      completed: new Set(),
      graph,
      credits: () => 3,
      offeredIn: (code, slot) => everywhere || slot.season !== "summer" || code.startsWith("BB"),
      slots: termsFrom({ year: 2027, season: "spring" }, 6, { summers: 0 }),
      placements: new Map(Object.entries(placements)),
    });

  test("holds a course in the term it was moved to", () => {
    const p = placed({ "BB-1000": "SP28" }, ["BB-1000", "BB-1010"]);
    const term = p.terms.find((t) => t.slot.name === "SP28");
    expect(term?.courses.map((c) => c.code)).toEqual(["BB-1000"]);
    expect(term?.courses[0]?.moved).toBe(true);
    // And it does not get scheduled twice on the way there.
    expect(p.terms.filter((t) => t.courses.some((c) => c.code === "BB-1000"))).toHaveLength(1);
  });

  // The whole point of a pin: everything else arranges itself around it.
  test("lets the prerequisite chain reflow behind it", () => {
    const p = placed({ "AA-4000": "SP29" }, ["AA-1000", "AA-2000", "AA-3000", "AA-4000"]);
    expect(p.finishes).toBe("SP29");
    expect(p.terms.at(-1)!.courses.map((c) => c.code)).toEqual(["AA-4000"]);
  });

  test("says what a move breaks rather than refusing it", () => {
    const p = placed({ "AA-2000": "SP27" }, ["AA-1000", "AA-2000"]);
    const first = p.terms[0]!;
    expect(first.courses[0]!.code).toBe("AA-2000");
    expect(first.courses[0]!.conflict).toContain("AA-1000");
  });

  test("counts an overfull term rather than trimming it", () => {
    const p = projectPlan({
      need: ["BB-1000", "BB-1010", "BB-1020"],
      completed: new Set(),
      graph,
      credits: () => 3,
      offeredIn: () => true,
      slots: [{ name: "SP27", season: "spring", year: 2027, capacity: 4 }],
      placements: new Map([
        ["BB-1000", "SP27"],
        ["BB-1010", "SP27"],
      ]),
    });
    expect(p.terms[0]!.credits).toBe(6);
    expect(p.terms[0]!.courses[1]!.conflict).toContain("over its cap");
  });

  test("reports a term the plan no longer reaches", () => {
    const p = placed({ "BB-1000": "SU31" }, ["BB-1000"]);
    expect(p.unscheduled[0]!.why).toContain("no longer reaches");
  });

  test("is not undone by the pass that fills a light semester", () => {
    const slots: TermSlot[] = [
      { name: "SP27", season: "spring", year: 2027, capacity: 18, minimum: 12 },
      { name: "FA27", season: "fall", year: 2027, capacity: 18, minimum: 12 },
    ];
    const p = projectPlan({
      need: ["BB-1000", "BB-1010", "BB-1020"],
      completed: new Set(),
      graph,
      credits: () => 3,
      offeredIn: () => true,
      slots,
      placements: new Map([["BB-1000", "FA27"]]),
    });
    expect(p.terms.find((t) => t.slot.name === "FA27")?.courses.map((c) => c.code)).toEqual([
      "BB-1000",
    ]);
  });
});
