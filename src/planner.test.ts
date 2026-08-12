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
  slots = termsFrom({ year: 2027, season: "spring" }, 6, { includeSummers: false }),
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
      slots: termsFrom({ year: 2027, season: "spring" }, 4, { includeSummers: false }),
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
      slots: termsFrom({ year: 2027, season: "spring" }, 3, { includeSummers: false }),
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
      slots: termsFrom({ year: 2027, season: "spring" }, 2, { includeSummers: false }),
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
      termsFrom({ year: 2027, season: "spring" }, 3, { includeSummers: false }).map((s) => s.name),
    ).toEqual(["SP27", "FA27", "SP28"]);
    const withSummer = termsFrom({ year: 2027, season: "spring" }, 2);
    expect(withSummer.find((s) => s.season === "summer")?.capacity).toBe(7);
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

describe("a term worth opening", () => {
  const three = buildGraph([
    { code: "AA-1000", title: "", requisites: [] },
    { code: "BB-1000", title: "", requisites: [] },
  ]);

  const plan = (minimum: number | undefined, capacity: number) =>
    projectPlan({
      need: ["AA-1000", "BB-1000"],
      completed: new Set(),
      graph: three,
      credits: () => 3,
      offeredIn: () => true,
      slots: termsFrom({ year: 2027, season: "spring" }, 4, {
        capacity,
        includeSummers: false,
        ...(minimum === undefined ? {} : { minimum }),
      }),
    });

  test("holds work back rather than enrolling a student part time", () => {
    // Three credits in a term of their own makes a student part time for a
    // semester. AA and BB gate nothing, so deferring one is free.
    const held = plan(6, 3);
    expect(held.terms.every((t) => t.credits >= 6 || t === held.terms.at(-1))).toBe(true);
  });

  test("takes a short term anyway when the work gates what follows", () => {
    // Deferring a course that unlocks others defers everything behind it.
    const chain = buildGraph([
      { code: "AA-1000", title: "", requisites: [] },
      { code: "ZZ-4000", title: "", requisites: [req("Take AA-1000")] },
    ]);
    const p = projectPlan({
      need: ["AA-1000", "ZZ-4000"],
      completed: new Set(),
      graph: chain,
      credits: () => 3,
      offeredIn: () => true,
      slots: termsFrom({ year: 2027, season: "spring" }, 4, {
        capacity: 3,
        includeSummers: false,
        minimum: 12,
      }),
    });
    expect(p.terms.map((t) => t.courses[0]?.code)).toEqual(["AA-1000", "ZZ-4000"]);
    expect(p.unscheduled).toEqual([]);
  });

  test("a light final term is simply how a degree ends", () => {
    // One course left and nothing to hold it back for.
    const p = projectPlan({
      need: ["AA-1000"],
      completed: new Set(),
      graph: three,
      credits: () => 3,
      offeredIn: () => true,
      slots: termsFrom({ year: 2027, season: "spring" }, 2, {
        capacity: 12,
        includeSummers: false,
        minimum: 12,
      }),
    });
    expect(p.terms).toHaveLength(1);
    expect(p.terms[0]?.credits).toBe(3);
  });

  test("without a minimum it opens whatever term it can", () => {
    expect(plan(undefined, 3).terms).toHaveLength(2);
  });
});
