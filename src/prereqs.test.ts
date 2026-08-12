import { describe, expect, test } from "bun:test";
import {
  buildGraph,
  type CourseNode,
  depth,
  downstream,
  eligibility,
  parseRequisite,
} from "./prereqs";

const BEFORE = "- Must be completed prior to taking this course.";
const BEFORE_OR_WITH = "- Must be taken either prior to or at the same time as this course.";
const WITH = "- Must be taken at the same time as this course.";
const SUGGESTED = "- Recommended prior to taking this course, but is not required.";

const req = (DisplayText: string, DisplayTextExtension = BEFORE, IsRequired = true) =>
  parseRequisite({ DisplayText, DisplayTextExtension, IsRequired });

describe("parsing requisite text", () => {
  // Every shape below was observed in the Fall 2026 catalog.
  test("a single course", () => {
    expect(req("Take CS-1210")).toMatchObject({
      courses: ["CS-1210"],
      mode: "all",
      timing: "before",
      required: true,
      understood: true,
    });
  });

  test("space-separated courses are a conjunction", () => {
    expect(req("Take CS-3220 CS-3610")).toMatchObject({
      courses: ["CS-3220", "CS-3610"],
      mode: "all",
      understood: true,
    });
  });

  test("an explicit or is a disjunction", () => {
    expect(req("Take BIO-1000 or BIO-1050")).toMatchObject({
      courses: ["BIO-1000", "BIO-1050"],
      mode: "any",
      understood: true,
    });
  });

  test("trailing punctuation and separators do not defeat it", () => {
    expect(req("Take CS-1210.")).toMatchObject({ courses: ["CS-1210"], understood: true });
    expect(req("Take CS-1210, CS-1220")).toMatchObject({ mode: "all", understood: true });
    expect(req("Take CS-1210 and CS-1220")).toMatchObject({ mode: "all", understood: true });
    expect(req("# Take CS-1210;")).toMatchObject({ courses: ["CS-1210"], understood: true });
  });

  test("the three timings come from the extension line", () => {
    expect(req("Take MATH-2520", BEFORE).timing).toBe("before");
    expect(req("Take MATH-2520", BEFORE_OR_WITH).timing).toBe("before-or-with");
    expect(req("Take MATH-2520", WITH).timing).toBe("with");
  });

  test("a recommendation is not a requirement", () => {
    expect(req("Take CS-1210", SUGGESTED).required).toBe(false);
    expect(req("Take CS-1210", BEFORE, false).required).toBe(false);
  });

  // The important half: refusing to claim we understood prose.
  test("prose conditions are kept but not treated as parsed", () => {
    const prose = req(
      "Acceptance into the PA program. Successful completion of preceding courses.",
    );
    expect(prose.understood).toBe(false);
    expect(prose.courses).toEqual([]);

    const mixed = req("Take CS-3310, junior status, and permission of instructor.");
    expect(mixed.courses).toEqual(["CS-3310"]);
    expect(mixed.understood).toBe(false);
    expect(mixed.text).toContain("permission of instructor");
  });

  test("a catalog-year condition is not a plain prerequisite", () => {
    expect(req("MATH-1710 is required for students following the 2024 catalog.").understood).toBe(
      false,
    );
  });

  test("a subject-count rule is not something we can check", () => {
    expect(req("Take 1 course; from subject BIO").understood).toBe(false);
  });
});

// A slice of the real CS chain.
const nodes: CourseNode[] = [
  { code: "CS-1210", title: "Intro", requisites: [] },
  { code: "CS-1220", title: "OOD", requisites: [req("Take CS-1210")] },
  { code: "CS-2210", title: "Data Structures", requisites: [req("Take CS-1220")] },
  { code: "CS-3310", title: "Operating Systems", requisites: [req("Take CS-1220")] },
  {
    code: "CS-3410",
    title: "Algorithms",
    requisites: [req("Take CS-2210"), req("Take MATH-2520", BEFORE_OR_WITH)],
  },
  { code: "MATH-2520", title: "Discrete", requisites: [] },
  {
    code: "CS-4810",
    title: "Software Engr I",
    requisites: [req("Take CS-3220 CS-3610"), req("Take CS-3410", BEFORE_OR_WITH)],
  },
  { code: "CS-3220", title: "Databases", requisites: [] },
  { code: "CS-3610", title: "Networks", requisites: [] },
];
const graph = buildGraph(nodes);

describe("the graph", () => {
  test("knows what a course unlocks directly", () => {
    expect([...(graph.unlocks.get("CS-1220") ?? [])].sort()).toEqual(["CS-2210", "CS-3310"]);
  });

  test("counts everything downstream, transitively", () => {
    expect([...downstream(graph, "CS-1210")].sort()).toEqual([
      "CS-1220",
      "CS-2210",
      "CS-3310",
      "CS-3410",
      "CS-4810",
    ]);
    expect(downstream(graph, "CS-4810").size).toBe(0);
  });

  test("depth is the longest chain, so it is a floor on terms", () => {
    expect(depth(graph, "CS-1210")).toBe(0);
    expect(depth(graph, "CS-1220")).toBe(1);
    expect(depth(graph, "CS-2210")).toBe(2);
    expect(depth(graph, "CS-3410")).toBe(3);
    expect(depth(graph, "CS-4810")).toBe(4);
  });

  // Subject codes are 2-5 letters at Cedarville; all 168 of them match, and
  // so do all 943 course names. A one-letter subject is not a real code.
  test("a cycle in the catalog does not hang the walk", () => {
    const cyclic = buildGraph([
      { code: "AA-1000", title: "A", requisites: [req("Take BB-1000")] },
      { code: "BB-1000", title: "B", requisites: [req("Take AA-1000")] },
    ]);
    expect(depth(cyclic, "AA-1000")).toBeLessThan(5);
    expect(downstream(cyclic, "AA-1000").size).toBe(2);
  });

  test("every real course name is recognised", () => {
    for (const name of ["CS-1210", "MATH-2740", "BTGE-1725", "EGCP-3010", "PEF-1990"]) {
      expect(req(`Take ${name}`).courses).toEqual([name]);
    }
  });
});

describe("eligibility", () => {
  const node = (code: string) => graph.courses.get(code)!;

  test("open when nothing is required", () => {
    expect(eligibility(node("CS-1210"), new Set())).toMatchObject({ state: "open" });
  });

  test("blocked names the missing course, not just a boolean", () => {
    expect(eligibility(node("CS-2210"), new Set())).toEqual({
      state: "blocked",
      blockedBy: ["CS-1220"],
    });
  });

  test("open once the prerequisite is completed", () => {
    expect(eligibility(node("CS-2210"), new Set(["CS-1220"]))).toMatchObject({ state: "open" });
  });

  // The distinction that matters when planning a single term.
  test("a corequisite may be taken now; a prerequisite may not", () => {
    const completed = new Set(["CS-2210"]);
    // MATH-2520 is before-or-with, so enrolling in it now is enough.
    expect(eligibility(node("CS-3410"), completed, new Set(["MATH-2520"]))).toMatchObject({
      state: "open",
    });
    expect(eligibility(node("CS-3410"), completed)).toEqual({
      state: "blocked",
      blockedBy: ["MATH-2520"],
    });
    // CS-2210 is a hard prerequisite; taking it concurrently does not count.
    expect(eligibility(node("CS-3410"), new Set(["MATH-2520"]), new Set(["CS-2210"]))).toEqual({
      state: "blocked",
      blockedBy: ["CS-2210"],
    });
  });

  test("a conjunction needs all of them", () => {
    const partly = eligibility(node("CS-4810"), new Set(["CS-3220", "CS-3410"]));
    expect(partly).toEqual({ state: "blocked", blockedBy: ["CS-3610"] });
  });

  test("a disjunction needs only one", () => {
    const either: CourseNode = {
      code: "X-1000",
      title: "X",
      requisites: [req("Take BIO-1000 or BIO-1050")],
    };
    expect(eligibility(either, new Set(["BIO-1050"]))).toMatchObject({ state: "open" });
    expect(eligibility(either, new Set())).toMatchObject({ state: "blocked" });
  });

  // The doubt does not erase the courses the text names. Reporting no
  // blockers at all reads as "nothing in the way", which is the opposite.
  test("an unparseable condition still names the courses it mentions", () => {
    const mixed: CourseNode = {
      code: "Z-1000",
      title: "Z",
      requisites: [req("Take CS-3310, junior status, and permission of instructor.")],
    };
    const verdict = eligibility(mixed, new Set());
    expect(verdict.state).toBe("unknown");
    expect(verdict.blockedBy).toEqual(["CS-3310"]);

    // And once that course is done, only the human condition remains.
    expect(eligibility(mixed, new Set(["CS-3310"]))).toMatchObject({
      state: "unknown",
      blockedBy: [],
    });
  });

  test("an unparseable condition reports unknown, never open", () => {
    const gated: CourseNode = {
      code: "PA-5000",
      title: "PA",
      requisites: [req("Acceptance into the PA program.")],
    };
    const verdict = eligibility(gated, new Set());
    expect(verdict.state).toBe("unknown");
    if (verdict.state === "unknown") expect(verdict.why[0]).toContain("PA program");
  });

  test("recommendations never block", () => {
    const suggested: CourseNode = {
      code: "Y-1000",
      title: "Y",
      requisites: [req("Take CS-1210", SUGGESTED)],
    };
    expect(eligibility(suggested, new Set())).toMatchObject({ state: "open" });
  });
});

describe("stale requisite references", () => {
  /**
   * Cedarville renumbered Calculus II from MATH-1720 to MATH-1715 without
   * updating the courses that name it, and a few entries carry transposed
   * subject codes. EGEE-2110 requires MATH-1720, so treating it as a hard
   * blocker marks the course permanently unreachable.
   */
  const exists = (code: string) => ["MATH-1715", "CS-1210"].includes(code);

  test("a prerequisite that is not in the catalog reports unknown, not blocked", () => {
    const node: CourseNode = {
      code: "EGEE-2110",
      title: "x",
      requisites: [req("Take MATH-1720")],
    };
    expect(eligibility(node, new Set())).toMatchObject({
      state: "blocked",
      blockedBy: ["MATH-1720"],
    });

    const verdict = eligibility(node, new Set(), new Set(), { exists });
    expect(verdict.state).toBe("unknown");
    expect(verdict.blockedBy).toEqual([]);
    if (verdict.state === "unknown") expect(verdict.why[0]).toContain("renumbered");
  });

  test("a real missing prerequisite still blocks", () => {
    const node: CourseNode = { code: "X-1000", title: "x", requisites: [req("Take CS-1210")] };
    expect(eligibility(node, new Set(), new Set(), { exists })).toMatchObject({
      state: "blocked",
      blockedBy: ["CS-1210"],
    });
  });

  test("a mix of real and phantom still blocks on the real one", () => {
    const node: CourseNode = {
      code: "X-2000",
      title: "x",
      requisites: [req("Take CS-1210 MATH-1720")],
    };
    const verdict = eligibility(node, new Set(), new Set(), { exists });
    expect(verdict.state).toBe("blocked");
    expect(verdict.blockedBy).toContain("CS-1210");
  });

  test("without an exists check, nothing changes", () => {
    const node: CourseNode = { code: "X-3000", title: "x", requisites: [req("Take GONE-9999")] };
    expect(eligibility(node, new Set())).toMatchObject({ state: "blocked" });
  });
});
