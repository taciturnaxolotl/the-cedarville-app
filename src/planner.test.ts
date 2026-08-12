import { describe, expect, test } from "bun:test";
import { criticalPath, projectPlan, type Season, termsFrom } from "./planner";
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
    offeredIn: (code, season) => everywhere || season !== "summer" || code.startsWith("BB"),
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
      slots: [{ name: "SP27", season: "spring", capacity: 3 }],
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
    expect(p.unscheduled[0]!.why).toContain("never observed");
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
    const springOnly = (code: string, season: Season) =>
      code === "BB-1000" ? season === "spring" : true;
    const p = projectPlan({
      need: ["BB-1000"],
      completed: new Set(),
      graph,
      credits: () => 3,
      offeredIn: springOnly,
      slots: [
        { name: "SU27", season: "summer", capacity: 7 },
        { name: "FA27", season: "fall", capacity: 18 },
        { name: "SP28", season: "spring", capacity: 18 },
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
