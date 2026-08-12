import { describe, expect, test } from "bun:test";
import { merge, type Significance } from "./merge";
import { accepts, enumeratedCourseIds, gaps, levelOf, normalize, openGroups } from "./requirements";
import type { CourseRef, EvaluationResponse, RawGroup } from "./types";

const RANK: Record<Significance, number> = { guaranteed: 0, elective: 1, "catch-all": 2 };
const rank = (s: Significance) => RANK[s];

const course = (id: string, subject: string, num: string, equated: string[] = []): CourseRef => ({
  Id: id,
  SubjectCode: subject,
  Number: num,
  Title: `${subject}-${num}`,
  CourseName: `${subject}-${num}`,
  EquatedCourseIds: equated,
  IsPseudoCourse: false,
});

const group = (over: Partial<RawGroup>): RawGroup => ({
  Id: "g",
  Code: "G",
  DisplayText: "",
  CompletionStatus: "NotStarted",
  PlanningStatus: "NotPlanned",
  Courses: null,
  FromCourses: null,
  FromSubjects: null,
  FromDepartments: null,
  FromLevels: null,
  ButNotCourses: null,
  ButNotSubjects: null,
  ButNotCourseLevels: null,
  MinCourses: null,
  MinCredits: null,
  MinCreditsPerCourse: null,
  MinSubjects: null,
  MinDepartments: null,
  MaxCourses: null,
  MaxCredits: null,
  MaxCreditsPerCourse: null,
  AppliedAcademicCredits: null,
  CoursesThatNeedPlanned: null,
  AcademicCreditRules: null,
  HasRules: false,
  OnlyConveysPrintText: false,
  ...over,
});

const program = (code: string, groups: RawGroup[]): EvaluationResponse => ({
  StudentId: "1000000",
  Program: {
    Code: code,
    Title: code,
    Catalog: "2026",
    Degree: "BS",
    MinimumCredits: 120,
    CompletedCredits: 0,
    InProgressCredits: 0,
    PlannedCredits: 0,
    RequiredRequirementCount: 1,
    CompletedRequirementCount: 0,
    Requirements: [
      {
        Id: `${code}-r`,
        Code: `${code}-r`,
        Description: `${code} core`,
        CompletionStatus: "NotStarted",
        PlanningStatus: "NotPlanned",
        MinSubrequirements: null,
        MinGpa: null,
        Subrequirements: [
          {
            Id: `${code}-s`,
            Code: `${code}-s`,
            DisplayText: "",
            CompletionStatus: "NotStarted",
            PlanningStatus: "NotPlanned",
            MinGroups: null,
            MinGpa: null,
            MinInstitutionalCredits: null,
            Groups: groups,
          },
        ],
      },
    ],
  },
});

describe("constraint classification", () => {
  test("an enumerated course list is take-all", () => {
    const [g] = normalize(program("A", [group({ Courses: [course("1", "CS", "1210")] })]))
      .requirements[0]!.subrequirements[0]!.groups;
    expect(g!.constraint.kind).toBe("take-all");
  });

  test("a pool with a minimum is choose-from", () => {
    const [g] = normalize(
      program("A", [group({ FromCourses: [course("1", "CS", "3310")], MinCourses: 2 })]),
    ).requirements[0]!.subrequirements[0]!.groups;
    expect(g!.constraint.kind).toBe("choose-from");
    expect(g!.min.courses).toBe(2);
    // nulls must not survive into the thresholds object
    expect("credits" in g!.min).toBe(false);
  });

  test("attribute-only groups are filters", () => {
    const [g] = normalize(
      program("A", [
        group({ FromSubjects: [{ Code: "BTGE", Description: "Bible" }], MinCredits: 6 }),
      ]),
    ).requirements[0]!.subrequirements[0]!.groups;
    expect(g!.constraint).toMatchObject({ kind: "filter", subjects: ["BTGE"] });
    expect(g!.min.credits).toBe(6);
  });

  test("print-only headers are not planning work", () => {
    const tree = normalize(program("A", [group({ OnlyConveysPrintText: true })]));
    expect(openGroups(tree)).toHaveLength(0);
  });

  // Regression: real BS.CYOPR data. Six electives ("One laboratory course
  // from the biological sciences") enumerate nothing at all, and were being
  // classified print-only and dropped from the worklist entirely.
  test("a credit minimum with no enumerable courses is a rule, not prose", () => {
    const tree = normalize(
      program("A", [
        group({
          DisplayText: "One laboratory course from the biological sciences (3.5 credit hours)",
          MinCredits: 3.5,
          HasRules: true,
          PlanningStatus: "NotPlanned",
        }),
      ]),
    );
    const g = tree.requirements[0]!.subrequirements[0]!.groups[0]!;
    expect(g.constraint.kind).toBe("rule-based");
    expect(g.min.credits).toBe(3.5);
    expect(openGroups(tree)).toHaveLength(1);
    // Cannot enumerate it, so cannot rule any course out either.
    expect(accepts(g, course("7", "BIO", "1000"))).toBe("unknown");
  });

  test("a rule-shaped group with no credits or rules stays prose", () => {
    const tree = normalize(
      program("A", [
        group({ DisplayText: "Complete an approved intercultural experience of four weeks." }),
      ]),
    );
    expect(tree.requirements[0]!.subrequirements[0]!.groups[0]!.constraint.kind).toBe("print-only");
    expect(openGroups(tree)).toHaveLength(0);
  });

  test("completed groups drop off the worklist", () => {
    const tree = normalize(
      program("A", [
        group({ Courses: [course("1", "CS", "1210")], CompletionStatus: "Completed" }),
      ]),
    );
    expect(openGroups(tree)).toHaveLength(0);
  });
});

describe("progress", () => {
  const statusOf = (over: Partial<RawGroup>) =>
    normalize(program("A", [group({ Courses: [course("1", "CS", "1210")], ...over })]))
      .requirements[0]!.subrequirements[0]!.groups[0]!.status;

  // The three pairs Colleague actually emits, from real BS.CYOPR data.
  test("reads the observed enum pairs exactly", () => {
    expect(statusOf({ CompletionStatus: "NotStarted", PlanningStatus: "NotPlanned" })).toEqual({
      completion: "NotStarted",
      planning: "NotPlanned",
    });
    expect(
      statusOf({ CompletionStatus: "Completed", PlanningStatus: "CompletelyPlanned" }),
    ).toEqual({ completion: "Completed", planning: "CompletelyPlanned" });
    expect(
      statusOf({ CompletionStatus: "PartiallyCompleted", PlanningStatus: "PartiallyPlanned" }),
    ).toEqual({ completion: "PartiallyCompleted", planning: "PartiallyPlanned" });
  });

  // Regression: substring matching reported unfinished work as finished.
  test("PartiallyCompleted is not Completed and stays on the worklist", () => {
    const tree = normalize(
      program("A", [
        group({
          Courses: [course("1", "CS", "1210")],
          CompletionStatus: "PartiallyCompleted",
          PlanningStatus: "NotPlanned",
        }),
      ]),
    );
    expect(tree.requirements[0]!.subrequirements[0]!.groups[0]!.status.completion).toBe(
      "PartiallyCompleted",
    );
    expect(openGroups(tree)).toHaveLength(1);
    expect(gaps(tree)).toHaveLength(1);
  });

  // Regression: "NotPlanned" contains "Planned".
  test("NotPlanned is not planned", () => {
    expect(
      statusOf({ CompletionStatus: "NotStarted", PlanningStatus: "NotPlanned" }).planning,
    ).toBe("NotPlanned");
  });

  test("a partly-done requirement whose remainder is planned is not a gap", () => {
    const tree = normalize(
      program("A", [
        group({
          Courses: [course("1", "CS", "1210")],
          CompletionStatus: "PartiallyCompleted",
          PlanningStatus: "CompletelyPlanned",
        }),
      ]),
    );
    expect(openGroups(tree)).toHaveLength(1);
    expect(gaps(tree)).toHaveLength(0);
  });
});

describe("acceptance", () => {
  const g = normalize(
    program("A", [
      group({
        FromCourses: [course("1", "CS", "3310"), course("2", "CS", "3320")],
        ButNotCourses: [course("2", "CS", "3320")],
      }),
    ]),
  ).requirements[0]!.subrequirements[0]!.groups[0]!;

  test("excluded courses lose even when listed", () => {
    expect(accepts(g, course("2", "CS", "3320"))).toBe("no");
    expect(enumeratedCourseIds(g)?.has("2")).toBe(false);
  });

  test("equated courses substitute for the listed one", () => {
    expect(accepts(g, course("99", "CS", "3311", ["1"]))).toBe("yes");
  });

  test("course level comes from the course number", () => {
    const filter = normalize(
      program("A", [
        group({ FromSubjects: [{ Code: "CS", Description: "" }], FromLevels: ["300"] }),
      ]),
    ).requirements[0]!.subrequirements[0]!.groups[0]!;
    expect(accepts(filter, course("5", "CS", "3310"))).toBe("yes");
    expect(accepts(filter, course("6", "CS", "1210"))).toBe("no");
    expect(levelOf(course("5", "CS", "3310"))).toBe("300");
  });

  test("a course with no numeric level cannot be judged on level", () => {
    const filter = normalize(
      program("A", [
        group({ FromSubjects: [{ Code: "CS", Description: "" }], FromLevels: ["300"] }),
      ]),
    ).requirements[0]!.subrequirements[0]!.groups[0]!;
    // Real catalog entries: "PROF" and "HS02".
    expect(levelOf(course("7", "CS", "PROF"))).toBeUndefined();
    expect(accepts(filter, course("7", "CS", "PROF"))).toBe("unknown");
  });

  test("opaque Colleague rules downgrade a match to unknown", () => {
    const ruled = normalize(
      program("A", [group({ Courses: [course("1", "CS", "1210")], HasRules: true })]),
    ).requirements[0]!.subrequirements[0]!.groups[0]!;
    expect(ruled.unverifiable).toBe(true);
    expect(accepts(ruled, course("1", "CS", "1210"))).toBe("unknown");
  });
});

describe("dual-major merge", () => {
  test("pairs the two requirements drawing on a common course", () => {
    const cs = normalize(
      program("CS", [
        group({ FromCourses: [course("1", "MATH", "2740"), course("2", "CS", "3310")] }),
      ]),
    );
    const math = normalize(
      program("MATH", [
        group({ FromCourses: [course("1", "MATH", "2740"), course("3", "MATH", "3810")] }),
      ]),
    );

    const { shared } = merge(cs, math);
    expect(shared).toHaveLength(1);
    expect(shared[0]!.courses.map((c) => c.Id)).toEqual(["1"]);
  });

  test("reports one row per requirement pair, not per course", () => {
    const pool = [course("1", "A", "1"), course("2", "A", "2"), course("3", "A", "3")];
    const a = normalize(program("A", [group({ FromCourses: pool, MinCredits: 6 })]));
    const b = normalize(program("B", [group({ FromCourses: pool, MinCredits: 3 })]));

    const { shared } = merge(a, b);
    expect(shared).toHaveLength(1);
    expect(shared[0]!.courses).toHaveLength(3);
    expect(shared[0]!.credits).toEqual({ a: 6, b: 3 });
  });

  test("an enumerated pool tested against a filter still matches", () => {
    const cs = normalize(program("CS", [group({ FromCourses: [course("1", "MATH", "2740")] })]));
    const math = normalize(
      program("MATH", [group({ FromSubjects: [{ Code: "MATH", Description: "" }] })]),
    );
    expect(merge(cs, math).shared[0]!.courses.map((c) => c.Id)).toEqual(["1"]);
  });

  // Regression: real BS.CYOPR data. A rule-based group accepts every course
  // as "unknown", so pairing it produced Arabic satisfying a biology lab.
  test("rule-based requirements are set aside, never paired", () => {
    const a = normalize(
      program("A", [
        group({
          DisplayText: "One laboratory course from the biological sciences",
          MinCredits: 3.5,
        }),
      ]),
    );
    const b = normalize(
      program("B", [group({ FromCourses: [course("9", "ARBC", "1400")], MinCredits: 3 })]),
    );

    const result = merge(a, b);
    expect(result.shared).toHaveLength(0);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]!).toMatchObject({ reason: "rule", at: { program: "A" } });
  });

  // Regression: "Any 3XXX or 4XXX EG course" filters by department, which no
  // evaluation endpoint resolves, so every course matched it as "unknown"
  // and EDUC-3100 was reported as satisfying an engineering elective.
  test("a department filter is set aside rather than matched loosely", () => {
    const a = normalize(
      program("A", [
        group({
          DisplayText: "Any 3XXX or 4XXX EG course (3 credit hours)",
          FromDepartments: [{ Code: "EG", Description: "Engineering" }],
          FromLevels: ["300", "400"],
          MinCredits: 3,
        }),
      ]),
    );
    const b = normalize(program("B", [group({ FromCourses: [course("9", "EDUC", "3100")] })]));

    const result = merge(a, b);
    expect(result.shared).toHaveLength(0);
    expect(result.unresolved).toMatchObject([{ reason: "missing-attributes" }]);
  });

  // Real BS.CYOPR + BS.CMPEG: sorting by pool size alone put the 32-credit
  // "any 300/400-level course" bucket above the four required cognates that
  // are the actual reason to double major.
  test("ranks required-in-both above elective above catch-all", () => {
    const cognates = [course("1", "MATH", "1705"), course("2", "PHYS", "2110")];
    const a = normalize(
      program("A", [
        group({ FromLevels: ["300", "400"], MinCredits: 32, DisplayText: "Upper-Division" }),
        group({ Courses: cognates, DisplayText: "Required Cognates" }),
        group({ FromCourses: [...cognates, course("3", "LIT", "2300")] }),
      ]),
    );
    const b = normalize(
      program("B", [
        group({ Courses: cognates, DisplayText: "Required Cognates" }),
        // EGCP-3010 is upper division, so it also lands in A's level bucket.
        group({ FromCourses: [...cognates, course("4", "EGCP", "3010")] }),
      ]),
    );

    const order = merge(a, b).shared.map((s) => s.significance);
    expect(order[0]).toBe("guaranteed");
    expect(order).toEqual([...order].sort((x, y) => rank(x) - rank(y)));
    expect(order).toContain("catch-all");
  });

  test("a bare level filter is a catch-all; one naming a subject is not", () => {
    const bare = normalize(program("A", [group({ FromLevels: ["300"], MinCredits: 32 })]));
    const named = normalize(
      program("A", [
        group({ FromLevels: ["300"], FromSubjects: [{ Code: "LIT", Description: "" }] }),
      ]),
    );
    const other = normalize(program("B", [group({ FromCourses: [course("5", "LIT", "3400")] })]));

    expect(merge(bare, other).shared[0]!.significance).toBe("catch-all");
    expect(merge(named, other).shared[0]!.significance).toBe("elective");
  });

  test("the shared-credit cap the API never tells us about", () => {
    const pool = [course("1", "A", "1"), course("2", "A", "2"), course("3", "A", "3")];
    const a = normalize(program("A", [group({ FromCourses: pool })]));
    const b = normalize(program("B", [group({ FromCourses: pool })]));

    expect(merge(a, b, { sharedCreditCap: 2 }).exceedsCap).toBe(true);
    expect(merge(a, b, { sharedCreditCap: 5 }).exceedsCap).toBe(false);
    expect(merge(a, b).certainSharedCourses).toHaveLength(3);
  });
});
