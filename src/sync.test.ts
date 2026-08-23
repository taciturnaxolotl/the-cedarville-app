import { describe, expect, test } from "bun:test";
import { mark, type PlannedCourse, type Sitting, describe as say, syncPlan } from "./sync";

const TERMS = ["2026FA", "2027SP", "2027FA", "2028SP"];
const ADDABLE = ["2027SU", "2028SU"];

const want = (code: string, courseId: string, termId: string, credits = 3): Sitting => ({
  code,
  courseId,
  termId,
  credits,
});

const have = (
  courseId: string,
  termId: string,
  over: Partial<PlannedCourse> = {},
): PlannedCourse => ({
  courseId,
  termId,
  credits: 3,
  sectionId: null,
  ...over,
});

const run = (
  wanted: Sitting[],
  planned: PlannedCourse[] = [],
  ours: string[] = [],
  addable = ADDABLE,
) => syncPlan({ wanted, planned, terms: TERMS, addable, ours: new Set(ours) });

describe("syncing the plan into Colleague", () => {
  test("adds what the projection wants and Colleague has not got", () => {
    const { changes, skipped } = run([want("CS-3310", "101", "2027FA")]);
    expect(changes).toEqual([
      { kind: "add", code: "CS-3310", courseId: "101", termId: "2027FA", credits: 3 },
    ]);
    expect(skipped).toEqual([]);
  });

  test("leaves a course already planned in the right term alone", () => {
    const { changes } = run([want("CS-3310", "101", "2027FA")], [have("101", "2027FA")]);
    expect(changes).toEqual([]);
  });

  test("moves a course it planned itself", () => {
    const { changes } = run(
      [want("CS-3310", "101", "2028SP")],
      [have("101", "2027FA")],
      [mark("101", "2027FA")],
    );
    expect(changes).toEqual([
      { kind: "move", code: "CS-3310", courseId: "101", from: "2027FA", to: "2028SP" },
    ]);
  });

  /*
   * The line this whole module is written around. A student who put a course
   * in the spring on purpose has said something, and a planner that quietly
   * drags it to the autumn because its own arithmetic prefers that is not a
   * tool anybody should install.
   */
  test("will not move a course the student planned by hand", () => {
    const { changes, skipped } = run([want("CS-3310", "101", "2028SP")], [have("101", "2027FA")]);
    expect(changes).toEqual([]);
    expect(skipped[0]?.why).toContain("2027FA");
    expect(skipped[0]?.why).toContain("left where you put it");
  });

  test("will not touch a course that carries a section", () => {
    const { changes, skipped } = run(
      [want("CS-3310", "101", "2028SP")],
      [have("101", "2027FA", { sectionId: "55" })],
      [mark("101", "2027FA")],
    );
    expect(changes).toEqual([]);
    expect(skipped[0]?.why).toContain("section");
  });

  test("withdraws only what it put there, and never a registered course", () => {
    const { changes } = run(
      [],
      [have("101", "2027FA"), have("202", "2027FA"), have("303", "2027FA", { sectionId: "7" })],
      [mark("101", "2027FA"), mark("303", "2027FA")],
    );
    expect(changes).toEqual([
      { kind: "remove", code: "101", courseId: "101", termId: "2027FA", sectionId: null },
    ]);
  });

  test("opens a summer before planning into it, once", () => {
    const { changes } = run([want("CS-1210", "101", "2027SU"), want("CS-1220", "202", "2027SU")]);
    expect(changes[0]).toEqual({ kind: "term", termId: "2027SU" });
    expect(changes.filter((c) => c.kind === "term")).toHaveLength(1);
    expect(changes.slice(1).every((c) => c.kind === "add")).toBe(true);
  });

  test("says so when Colleague has no such term rather than inventing one", () => {
    const { changes, skipped } = run([want("CS-1210", "101", "2031SP")]);
    expect(changes).toEqual([]);
    expect(skipped[0]?.why).toContain("no 2031SP");
  });

  /* A second sitting is another term's worth of the same course. */
  test("plans two sittings as two entries in different terms", () => {
    const { changes } = run([
      want("HON-3020", "1266", "2027FA", 2),
      want("HON-3020", "1266", "2028SP", 2),
    ]);
    expect(changes).toEqual([
      { kind: "add", code: "HON-3020", courseId: "1266", termId: "2027FA", credits: 2 },
      { kind: "add", code: "HON-3020", courseId: "1266", termId: "2028SP", credits: 2 },
    ]);
  });

  test("and reports the one Colleague cannot hold", () => {
    const { changes, skipped } = run([
      want("HON-3020", "1266", "2027FA", 2),
      want("HON-3020", "1266", "2027FA", 2),
    ]);
    expect(changes).toHaveLength(1);
    expect(skipped[0]?.why).toContain("once per term");
  });

  test("matches a second sitting against a second entry rather than the first", () => {
    const { changes } = run(
      [want("HON-3020", "1266", "2027FA", 2), want("HON-3020", "1266", "2028SP", 2)],
      [have("1266", "2027FA", { credits: 2 }), have("1266", "2028SP", { credits: 2 })],
    );
    expect(changes).toEqual([]);
  });

  test("orders terms first and removals last", () => {
    const { changes } = run(
      [want("CS-1210", "101", "2027SU")],
      [have("202", "2027FA")],
      [mark("202", "2027FA")],
    );
    expect(changes.map((c) => c.kind)).toEqual(["term", "add", "remove"]);
  });

  test("says what it is about to do in words", () => {
    expect(say({ kind: "term", termId: "2027SU" })).toBe("open 2027SU on your plan");
    expect(
      say({ kind: "move", code: "CS-3310", courseId: "1", from: "2027FA", to: "2028SP" }),
    ).toBe("move CS-3310 from 2027FA to 2028SP");
  });
});
