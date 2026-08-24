import { describe, expect, test } from "bun:test";
import { type PlannedCourse, type Sitting, describe as say, syncPlan } from "./sync";

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
  from = "2026FA",
  addable = ADDABLE,
) => syncPlan({ wanted, planned, terms: TERMS, addable, from });

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

  test("carries a planned course to the term this plan puts it in", () => {
    const { changes } = run([want("CS-3310", "101", "2028SP")], [have("101", "2027FA")]);
    expect(changes).toEqual([
      { kind: "move", code: "CS-3310", courseId: "101", from: "2027FA", to: "2028SP" },
    ]);
  });

  /*
   * The two lines this module is written around. A section means the student
   * has chosen when they are sitting in a room, which is a registration
   * decision rather than a plan, and a term already under way is history
   * however the plan stores it. Everything else is arrangement.
   */
  test("will not touch a course that carries a section", () => {
    const { changes, skipped } = run(
      [want("CS-3310", "101", "2028SP")],
      [have("101", "2027FA", { sectionId: "55" })],
    );
    expect(changes).toEqual([]);
    expect(skipped[0]?.why).toContain("section");
  });

  test("leaves the term under way and everything behind it alone", () => {
    // A course in progress sits on the degree plan too, and a projection that
    // starts next spring never mentions it. Withdrawing it would be vandalism.
    const { changes } = run([], [have("101", "2026FA"), have("202", "2027FA")], "2027SP");
    expect(changes).toEqual([
      { kind: "remove", code: "202", courseId: "202", termId: "2027FA", sectionId: null },
    ]);
  });

  test("withdraws what the plan no longer calls for, and never a registered course", () => {
    const { changes } = run(
      [],
      [have("101", "2027FA"), have("202", "2027FA"), have("303", "2027FA", { sectionId: "7" })],
    );
    expect(changes.map((c) => "courseId" in c && c.courseId)).toEqual(["101", "202"]);
    expect(changes.every((c) => c.kind === "remove")).toBe(true);
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
    const { changes } = run([want("CS-1210", "101", "2027SU")], [have("202", "2027FA")]);
    expect(changes.map((c) => c.kind)).toEqual(["term", "add", "remove"]);
  });

  test("says what it is about to do in words", () => {
    expect(say({ kind: "term", termId: "2027SU" })).toBe("open 2027SU on your plan");
    expect(
      say({ kind: "move", code: "CS-3310", courseId: "1", from: "2027FA", to: "2028SP" }),
    ).toBe("move CS-3310 from 2027FA to 2028SP");
  });
});
