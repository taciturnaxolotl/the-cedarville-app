import { describe, expect, test } from "bun:test";
import { buildMap } from "./map";
import type { Plan } from "./planner";
import { buildGraph, type CourseNode, parseRequisite } from "./prereqs";

const node = (code: string, requires: string[] = []): CourseNode => ({
  code,
  title: code,
  requisites: requires.map((r) =>
    parseRequisite({
      DisplayText: `Take ${r}`,
      DisplayTextExtension: "- Must be completed prior to taking this course.",
      IsRequired: true,
    }),
  ),
});

/** A plan is only ever read here, so a literal is clearer than projecting one. */
const plan = (terms: [string, string[]][]): Plan => ({
  terms: terms.map(([name, courses]) => ({
    slot: { name, season: name.startsWith("SP") ? "spring" : "fall", capacity: 15 },
    courses: courses.map((code) => ({ code, credits: 3 })),
    credits: courses.length * 3,
  })),
  finishes: terms.at(-1)?.[0] ?? null,
  totalCredits: terms.reduce((n, [, c]) => n + c.length * 3, 0),
  unscheduled: [],
});

const chain = buildGraph([
  node("CS-1210"),
  node("CS-1220", ["CS-1210"]),
  node("CS-2210", ["CS-1220"]),
  node("ART-1100"),
]);

describe("laying a plan out as a graph", () => {
  const map = buildMap(
    plan([
      ["SP27", ["CS-1210", "ART-1100"]],
      ["FA27", ["CS-1220"]],
      ["SP28", ["CS-2210"]],
    ]),
    { graph: chain, have: new Set() },
  );

  test("one column per term, in order", () => {
    expect(map.terms.map((t) => t.name)).toEqual(["SP27", "FA27", "SP28"]);
    const xs = map.terms.map((t) => t.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(new Set(xs).size).toBe(3);
  });

  test("courses in a term share a column and stack down it", () => {
    const first = map.nodes.filter((n) => n.termName === "SP27");
    expect(new Set(first.map((n) => n.x)).size).toBe(1);
    expect(new Set(first.map((n) => n.y)).size).toBe(2);
  });

  test("draws an edge only between two courses that are both on the plan", () => {
    expect(map.edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual([
      "CS-1210->CS-1220",
      "CS-1220->CS-2210",
    ]);
  });

  test("counts how many later courses wait on each one", () => {
    const by = new Map(map.nodes.map((n) => [n.code, n.unlocks]));
    expect(by.get("CS-1210")).toBe(2);
    expect(by.get("CS-1220")).toBe(1);
    expect(by.get("ART-1100")).toBe(0);
  });

  test("marks the longest chain, which is what sets the finish date", () => {
    const critical = map.nodes.filter((n) => n.critical).map((n) => n.code);
    expect(critical.sort()).toEqual(["CS-1210", "CS-1220", "CS-2210"]);
    expect(map.edges.every((e) => e.critical)).toBe(true);
  });

  test("sizes the canvas to hold every column and row", () => {
    const right = Math.max(...map.nodes.map((n) => n.x));
    const bottom = Math.max(...map.nodes.map((n) => n.y));
    expect(map.width).toBeGreaterThan(right);
    expect(map.height).toBeGreaterThan(bottom);
  });

  test("edges run left to right between the boxes they join", () => {
    for (const edge of map.edges) {
      const from = map.nodes.find((n) => n.code === edge.from)!;
      const to = map.nodes.find((n) => n.code === edge.to)!;
      expect(edge.path).toStartWith(`M ${from.x + 168}`);
      expect(edge.path).toEndWith(`${to.x} ${to.y + 16}`);
    }
  });
});

describe("what the graph leaves out", () => {
  test("a prerequisite already passed draws nothing", () => {
    // The graph is about the work ahead, not a history of the degree.
    const map = buildMap(plan([["SP27", ["CS-1220"]]]), {
      graph: chain,
      have: new Set(["CS-1210"]),
    });
    expect(map.edges).toEqual([]);
    expect(map.nodes).toHaveLength(1);
  });

  test("a plan with no chain has no critical path to point at", () => {
    const map = buildMap(plan([["SP27", ["ART-1100"]]]), { graph: chain, have: new Set() });
    expect(map.nodes.every((n) => !n.critical)).toBe(true);
  });

  test("an empty plan lays out without throwing", () => {
    const map = buildMap(plan([]), { graph: chain, have: new Set() });
    expect(map.nodes).toEqual([]);
    expect(map.width).toBeGreaterThan(0);
  });

  test("a cycle in the catalog terminates", () => {
    const loop = buildGraph([node("LOOP-1000", ["LOOP-2000"]), node("LOOP-2000", ["LOOP-1000"])]);
    const map = buildMap(plan([["SP27", ["LOOP-1000", "LOOP-2000"]]]), {
      graph: loop,
      have: new Set(),
    });
    expect(map.nodes).toHaveLength(2);
  });
});

describe("drawing the degree so far", () => {
  test("puts the transcript in columns before the plan", () => {
    const map = buildMap(plan([["SP27", ["CS-2210"]]]), {
      graph: chain,
      have: new Set(["CS-1210", "CS-1220"]),
      history: [
        { name: "FA25", courses: [{ code: "CS-1210", credits: 3, done: true }] },
        { name: "SP26", courses: [{ code: "CS-1220", credits: 3, done: true }] },
      ],
    });
    expect(map.terms.map((t) => t.name)).toEqual(["FA25", "SP26", "SP27"]);
    expect(map.terms.filter((t) => t.past)).toHaveLength(2);
    // Left to right, oldest first.
    expect(map.nodes.find((n) => n.code === "CS-1210")!.x).toBeLessThan(
      map.nodes.find((n) => n.code === "CS-2210")!.x,
    );
  });

  test("draws the edges a met prerequisite would otherwise hide", () => {
    // The whole reason to show history: without it CS-2210 waits on nothing
    // visible and the chain appears to start in the middle.
    const map = buildMap(plan([["SP27", ["CS-2210"]]]), {
      graph: chain,
      have: new Set(["CS-1210", "CS-1220"]),
      history: [
        {
          name: "FA25",
          courses: [
            { code: "CS-1210", credits: 3, done: true },
            { code: "CS-1220", credits: 3, done: true },
          ],
        },
      ],
    });
    expect(map.edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual([
      "CS-1210->CS-1220",
      "CS-1220->CS-2210",
    ]);
  });

  test("marks what is finished apart from what is under way", () => {
    const map = buildMap(plan([]), {
      graph: chain,
      have: new Set(["CS-1210", "CS-1220"]),
      history: [
        {
          name: "FA26",
          courses: [
            { code: "CS-1210", credits: 3, done: true },
            { code: "CS-1220", credits: 3, done: false },
          ],
        },
      ],
    });
    expect(map.nodes.find((n) => n.code === "CS-1210")?.past).toBe("done");
    expect(map.nodes.find((n) => n.code === "CS-1220")?.past).toBe("running");
  });

  test("counts a finished course's leverage over the work ahead", () => {
    const map = buildMap(
      plan([
        ["SP27", ["CS-1220"]],
        ["FA27", ["CS-2210"]],
      ]),
      {
        graph: chain,
        have: new Set(["CS-1210"]),
        history: [{ name: "FA25", courses: [{ code: "CS-1210", credits: 3, done: true }] }],
      },
    );
    expect(map.nodes.find((n) => n.code === "CS-1210")?.unlocks).toBe(2);
  });
});
