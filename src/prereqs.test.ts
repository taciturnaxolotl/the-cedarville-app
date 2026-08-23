import { describe, expect, test } from "bun:test";
import {
  buildGraph,
  type CourseNode,
  depth,
  downstream,
  eligibility,
  nodeOf,
  parseRequisite,
  prerequisitesOf,
  standingIn,
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

describe("requisites met by an equivalent course", () => {
  const aliases = (code: string) => (code === "EGCP-1010" ? ["EGCP-1010", "ENGR-1910"] : [code]);

  test("a prerequisite is satisfied by the course that replaced it", () => {
    const node: CourseNode = {
      code: "EGCP-2120",
      title: "Microcontrollers",
      requisites: [req("Take EGCP-1010")],
    };
    expect(eligibility(node, new Set(["ENGR-1910"]))).toMatchObject({ state: "blocked" });
    expect(eligibility(node, new Set(["ENGR-1910"]), new Set(), { aliases })).toMatchObject({
      state: "open",
    });
  });

  test("an equivalent completion also clears a phantom reference", () => {
    const node: CourseNode = { code: "X-1000", title: "x", requisites: [req("Take ENGR-1910")] };
    const verdict = eligibility(node, new Set(["EGCP-1010"]), new Set(), {
      aliases: (c) => (c === "ENGR-1910" ? ["ENGR-1910", "EGCP-1010"] : [c]),
      exists: () => false,
    });
    expect(verdict.state).toBe("open");
  });
});

describe("a requisite spanning a curriculum change", () => {
  /**
   * Cedarville cut Calculus I and II from 5 credits to 4 and split Calculus
   * III into IIIA and IIIB. Some requisites were updated to accept either
   * ("MATH-2705 or MATH-2710"); others still name only the retired course.
   */
  const exists = (c: string) => ["MATH-2705", "MATH-1715", "MATH-1990"].includes(c);

  test("an either/or naming one retired option blocks only on the live one", () => {
    const node: CourseNode = {
      code: "EGME-2050",
      title: "Computational Methods",
      requisites: [req("Take MATH-2705 or MATH-2710")],
    };
    const verdict = eligibility(node, new Set(), new Set(), { exists });
    // MATH-2710 cannot be enrolled in, so naming it as a blocker is noise.
    expect(verdict.blockedBy).toEqual(["MATH-2705"]);
    // And while MATH-2705 is genuinely outstanding, that is the useful answer.
    expect(verdict.state).toBe("blocked");
  });

  test("and the live option satisfies it outright", () => {
    const node: CourseNode = {
      code: "EGME-2050",
      title: "x",
      requisites: [req("Take MATH-2705 or MATH-2710")],
    };
    expect(eligibility(node, new Set(["MATH-2705"]), new Set(), { exists }).blockedBy).toEqual([]);
  });

  test("a requisite naming only the retired course does not block forever", () => {
    // MATH-2210 still reads "Take MATH-1720 MATH-1990" — a math-major core
    // course gated on calculus that no longer exists.
    const node: CourseNode = {
      code: "MATH-2210",
      title: "Logic & Meth of Proof",
      requisites: [req("Take MATH-1720 MATH-1990")],
    };
    const verdict = eligibility(node, new Set(["MATH-1990"]), new Set(), { exists });
    expect(verdict.state).toBe("unknown");
    expect(verdict.blockedBy).toEqual([]);
    if (verdict.state === "unknown") expect(verdict.why[0]).toContain("MATH-1720");
  });
});

describe("the chain behind a course", () => {
  const graph = buildGraph([
    { code: "DEEP-4000", title: "", requisites: [req("Take DEEP-3000")] },
    { code: "DEEP-3000", title: "", requisites: [req("Take DEEP-2000")] },
    { code: "DEEP-2000", title: "", requisites: [] },
    { code: "EITHER-3000", title: "", requisites: [req("Take DEEP-2000 or DEEP-3000")] },
    { code: "COREQ-3000", title: "", requisites: [req("Take DEEP-2000", WITH)] },
    { code: "LOOP-1000", title: "", requisites: [req("Take LOOP-2000")] },
    { code: "LOOP-2000", title: "", requisites: [req("Take LOOP-1000")] },
  ]);

  test("collects the whole transitive chain", () => {
    expect([...prerequisitesOf(graph, "DEEP-4000")].sort()).toEqual(["DEEP-2000", "DEEP-3000"]);
  });

  test("stops at what is already passed", () => {
    expect([...prerequisitesOf(graph, "DEEP-4000", new Set(["DEEP-3000"]))]).toEqual([]);
  });

  test("takes the shallowest branch when a requisite offers a choice", () => {
    // DEEP-2000 is takeable now; DEEP-3000 would drag its own chain along.
    expect([...prerequisitesOf(graph, "EITHER-3000")]).toEqual(["DEEP-2000"]);
  });

  test("a corequisite gates nothing", () => {
    expect([...prerequisitesOf(graph, "COREQ-3000")]).toEqual([]);
  });

  test("a cycle in the catalog terminates", () => {
    expect([...prerequisitesOf(graph, "LOOP-1000")].sort()).toEqual(["LOOP-1000", "LOOP-2000"]);
  });

  test("a course the catalog does not have contributes nothing", () => {
    expect([...prerequisitesOf(graph, "GHOST-1000")]).toEqual([]);
  });
});

describe("choosing between alternative prerequisites", () => {
  const graph = buildGraph([
    // "Take BUS-2150 GMTH-2110 MATH-2520 or MATH-3110" — five ways in, and
    // only one of them is a course the student was taking anyway.
    { code: "DSAI-3110", title: "", requisites: [req("Take GMTH-2110 MATH-2520 or MATH-3110")] },
    { code: "GMTH-2110", title: "", requisites: [req("Take BIO-1115")] },
    { code: "MATH-2520", title: "", requisites: [] },
    { code: "MATH-3110", title: "", requisites: [] },
    { code: "BIO-1115", title: "", requisites: [] },
  ]);

  test("reaches for a course the plan already holds", () => {
    // MATH-2520 and MATH-3110 are both one step away, so depth alone would
    // take whichever the text listed first. The plan breaks the tie.
    expect([...prerequisitesOf(graph, "DSAI-3110", new Set(), new Set(["MATH-3110"]))]).toEqual([
      "MATH-3110",
    ]);
    expect([...prerequisitesOf(graph, "DSAI-3110", new Set(), new Set(["MATH-2520"]))]).toEqual([
      "MATH-2520",
    ]);
  });

  test("falls back to the shallowest chain when the plan offers none", () => {
    // GMTH-2110 drags BIO-1115 along; the others stand alone.
    const picked = [...prerequisitesOf(graph, "DSAI-3110")];
    expect(picked).not.toContain("BIO-1115");
    expect(picked).toHaveLength(1);
  });

  test("an alternative already passed satisfies the requisite outright", () => {
    // Filtering the passed course out of the options and then picking one of
    // the rest buys a course for a requisite that is already met.
    expect([...prerequisitesOf(graph, "DSAI-3110", new Set(["MATH-3110"]))]).toEqual([]);
  });

  test("every course of an all-requisite is still needed when one is passed", () => {
    const both = buildGraph([
      { code: "CS-4000", title: "", requisites: [req("Take CS-1210 CS-1220")] },
      { code: "CS-1210", title: "", requisites: [] },
      { code: "CS-1220", title: "", requisites: [] },
    ]);
    expect([...prerequisitesOf(both, "CS-4000", new Set(["CS-1210"]))]).toEqual(["CS-1220"]);
  });
});

describe("class standing, which is prose and nowhere else", () => {
  test("reads the standing a description demands", () => {
    // EGGN-4010 Senior Seminar, verbatim. It carries no requisite record at
    // all, so this sentence is the whole of its condition.
    expect(standingIn("Required weekly meeting. Prerequisite: senior status in engineering")).toBe(
      "senior",
    );
    expect(standingIn("Take BIO-2600, junior status, and permission of instructor.")).toBe(
      "junior",
    );
    expect(standingIn("Open only to seniors in business administration.")).toBe("senior");
    expect(standingIn("An introduction to mathematical foundations.")).toBeNull();
  });

  test("a node carries it, from the description or the requisite text", () => {
    const node = nodeOf({
      Id: "1",
      SubjectCode: "EGGN",
      Number: "4010",
      Title: "Senior Seminar",
      Description: "Prerequisite: senior status in engineering",
    });
    expect(node).toMatchObject({ code: "EGGN-4010", standing: "senior", requisites: [] });

    const fromRequisite = nodeOf({
      Id: "2",
      SubjectCode: "BIO",
      Number: "4910",
      Title: "Research",
      CourseRequisites: [{ DisplayText: "Take BIO-2600, junior status.", IsRequired: true }],
    });
    expect(fromRequisite.standing).toBe("junior");
  });

  test("says nothing when the catalog says nothing", () => {
    expect(
      nodeOf({ Id: "3", SubjectCode: "CS", Number: "1210", Title: "Intro" }).standing,
    ).toBeUndefined();
  });
});

describe("a course whose title is the only thing that says when it is taken", () => {
  const record = (Title: string, over: Record<string, unknown> = {}) =>
    ({ SubjectCode: "HON", Number: "4910", Title, MinimumCredits: 1, ...over }) as never;

  test("reads senior standing out of the name", () => {
    // HON-4910 carries no description, no requisite and no rule. Read
    // literally it is open to a freshman.
    expect(nodeOf(record("Honors Sr Colloq I")).standing).toBe("senior");
    expect(nodeOf(record("Senior Theatre Project")).standing).toBe("senior");
  });

  test("and prose still wins where there is any", () => {
    const said = nodeOf(
      record("Design Project", { Description: "Prerequisite: junior status in engineering." }),
    );
    expect(said.standing).toBe("junior");
  });

  test("leaving ordinary titles alone", () => {
    expect(nodeOf(record("Data Structures")).standing).toBeUndefined();
  });
});
