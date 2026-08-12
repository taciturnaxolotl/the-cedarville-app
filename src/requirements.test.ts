import { describe, expect, test } from "bun:test";
import { merge, type Significance } from "./merge";
import {
  absorbInto,
  accepts,
  coursesNeeded,
  coursesNeededAcross,
  creditOverflow,
  enumeratedCourseIds,
  gaps,
  groupCoverage,
  groupKey,
  levelOf,
  normalize,
  openGroups,
  sharedCredits,
  walkGroups,
} from "./requirements";
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

const sub = (code: string, groups: RawGroup[]) => ({
  Id: code,
  Code: code,
  DisplayText: "",
  CompletionStatus: "NotStarted",
  PlanningStatus: "NotPlanned",
  MinGroups: null,
  MinGpa: null,
  MinInstitutionalCredits: null,
  Groups: groups,
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

describe("what a student still owes", () => {
  const credits = (c: string) => (c.endsWith("0000") ? 4 : 3);
  const need = (tree: ReturnType<typeof normalize>, have: string[] = []) =>
    coursesNeeded(tree, { credits, have: new Set(have) });

  /**
   * Colleague encodes tracks, concentrations and "any one of six ways" with
   * MinSubrequirements and MinGroups. Ignoring them makes every alternative
   * look mandatory — which is how a plan ends up demanding Greek and Spanish
   * at once, and why filtering by track name ever seemed necessary.
   */
  test("a requirement offering six ways picks only the cheapest one", () => {
    const raw = program("A", []);
    raw.Program.Requirements = [
      {
        Id: "r",
        Code: "GLOBAL",
        Description: "Global Awareness",
        CompletionStatus: "NotStarted",
        PlanningStatus: "NotPlanned",
        MinSubrequirements: 1,
        MinGpa: null,
        Subrequirements: [
          sub("expensive", [
            group({ Courses: [course("1", "SPAN", "2710"), course("2", "SPAN", "2720")] }),
          ]),
          sub("cheap", [group({ Courses: [course("3", "ANTH", "1800")] })]),
        ],
      },
    ] as never;

    const { courses } = need(normalize(raw));
    expect([...courses]).toEqual(["ANTH-1800"]);
  });

  test("a subrequirement offering two tracks picks one", () => {
    const raw = program("A", []);
    raw.Program.Requirements = [
      {
        Id: "r",
        Code: "MAJOR",
        Description: "Major",
        CompletionStatus: "NotStarted",
        PlanningStatus: "NotPlanned",
        MinSubrequirements: null,
        MinGpa: null,
        Subrequirements: [
          {
            ...sub("tracks", [
              group({ Courses: [course("1", "DSAI", "2110"), course("2", "DSAI", "3110")] }),
              group({ Courses: [course("3", "EGCP", "3010")] }),
            ]),
            MinGroups: 1,
          },
        ],
      },
    ] as never;

    expect([...need(normalize(raw)).courses]).toEqual(["EGCP-3010"]);
  });

  test("without a minimum, everything is required", () => {
    const raw = program("A", []);
    raw.Program.Requirements = [
      {
        Id: "r",
        Code: "CORE",
        Description: "Core",
        CompletionStatus: "NotStarted",
        PlanningStatus: "NotPlanned",
        MinSubrequirements: null,
        MinGpa: null,
        Subrequirements: [
          sub("a", [group({ Courses: [course("1", "CS", "1210")] })]),
          sub("b", [group({ Courses: [course("2", "CS", "1220")] })]),
        ],
      },
    ] as never;
    expect([...need(normalize(raw)).courses].sort()).toEqual(["CS-1210", "CS-1220"]);
  });

  test("a choose-from pool is filled to its credit minimum, cheapest first", () => {
    const tree = normalize(
      program("A", [
        group({
          FromCourses: [
            course("1", "AA", "1000"),
            course("2", "BB", "0000"),
            course("3", "CC", "1000"),
          ],
          MinCredits: 6,
        }),
      ]),
    );
    // 3cr courses before the 4cr one, and only enough to reach six.
    expect([...need(tree).courses]).toEqual(["AA-1000", "CC-1000"]);
  });

  test("work already done is not owed again", () => {
    const tree = normalize(
      program("A", [group({ Courses: [course("1", "CS", "1210"), course("2", "CS", "1220")] })]),
    );
    expect([...need(tree, ["CS-1210"]).courses]).toEqual(["CS-1220"]);
  });

  test("rules and filters are reported, never silently dropped", () => {
    const tree = normalize(
      program("A", [
        group({ DisplayText: "One laboratory course", MinCredits: 3.5, HasRules: true }),
        group({ FromSubjects: [{ Code: "LIT", Description: "Lit" }], MinCredits: 3 }),
      ]),
    );
    const { courses, unenumerable } = need(tree);
    expect(courses.size).toBe(0);
    expect(unenumerable).toHaveLength(2);
    // Order follows cost, so match on content rather than position.
    const lab = unenumerable.find((u) => u.text.includes("laboratory"));
    expect(lab?.credits).toBe(3.5);
  });

  test("a completed group costs nothing and is preferred when choosing", () => {
    const raw = program("A", []);
    raw.Program.Requirements = [
      {
        Id: "r",
        Code: "PICK",
        Description: "Pick one",
        CompletionStatus: "NotStarted",
        PlanningStatus: "NotPlanned",
        MinSubrequirements: 1,
        MinGpa: null,
        Subrequirements: [
          sub("unstarted", [group({ Courses: [course("9", "ZZ", "1000")] })]),
          {
            ...sub("finished", [
              group({ Courses: [course("8", "YY", "1000")], CompletionStatus: "Completed" }),
            ]),
            CompletionStatus: "Completed",
          },
        ],
      },
    ] as never;
    expect([...need(normalize(raw)).courses]).toEqual([]);
  });
});

describe("expandable requirements", () => {
  const credits = () => 3;
  const need = (tree: ReturnType<typeof normalize>) =>
    coursesNeeded(tree, { credits, have: new Set<string>() });

  test("a rule-based group carries the ids needed to resolve it", () => {
    const tree = normalize(
      program("A", [
        group({
          Id: "33964",
          RequirementCode: "UG.GENED.BS.2026",
          SubrequirementId: "33963",
          DisplayText: "One laboratory course from the biological sciences",
          MinCredits: 3.5,
          HasRules: true,
        }),
      ]),
    );
    const [u] = need(tree).unenumerable;
    expect(u!.ids).toEqual({
      requirement: "UG.GENED.BS.2026",
      subrequirement: "33963",
      group: "33964",
    });
    expect(u!.bucket).toBe(false);
  });

  /**
   * "32 hours of upper-division work" names no subject or department, so
   * nearly the whole catalog qualifies. Expanding it and filling cheapest-
   * first yields thirty-two 1-credit independent studies: arithmetically
   * valid, obvious nonsense.
   */
  test("a filter with no subject or department is a bucket", () => {
    const tree = normalize(
      program("A", [group({ FromLevels: ["300", "400"], MinCredits: 32, DisplayText: "" })]),
    );
    const [u] = need(tree).unenumerable;
    expect(u!.bucket).toBe(true);
    // An empty DisplayText falls back to something a student can read.
    expect(u!.text).not.toBe("G");
  });

  test("a filter naming a subject is a real requirement, not a bucket", () => {
    const tree = normalize(
      program("A", [
        group({
          FromSubjects: [{ Code: "LIT", Description: "Literature" }],
          FromLevels: ["200"],
          MinCredits: 3,
          DisplayText: "2000-level Literature course",
        }),
      ]),
    );
    expect(need(tree).unenumerable[0]!.bucket).toBe(false);
  });
});

describe("covering a requirement with what is already planned", () => {
  const price = (c: string) => (c === "HON-1020" ? 5 : 3);

  /**
   * The history elective accepts 46 courses, two of which are already on the
   * plan for other reasons. Picking a fresh one because it is cheaper in
   * isolation buys nothing, and enough of those push a graduation date out.
   */
  test("prefers a course already on the plan over a cheaper new one", () => {
    const need = new Set(["HIST-3080"]);
    const left = absorbInto(need, ["GEO-3040", "HIST-3080", "HIST-1110"], 3, price);

    expect(left).toBe(0);
    expect([...need]).toEqual(["HIST-3080"]);
  });

  test("adds the cheapest new course when nothing planned fits", () => {
    const need = new Set(["CS-1210"]);
    absorbInto(need, ["HON-1020", "GEO-3040"], 3, price);
    expect(need.has("GEO-3040")).toBe(true);
    expect(need.has("HON-1020")).toBe(false);
  });

  test("keeps adding until the credit minimum is met", () => {
    const need = new Set<string>();
    expect(absorbInto(need, ["AA-1000", "BB-1000", "CC-1000"], 6, price)).toBe(0);
    expect(need.size).toBe(2);
  });

  test("reports what it could not cover", () => {
    const need = new Set<string>();
    expect(absorbInto(need, ["AA-1000"], 9, price)).toBe(6);
  });

  test("an already-planned course counts toward a larger minimum", () => {
    const need = new Set(["HON-1020"]);
    absorbInto(need, ["HON-1020", "AA-1000", "BB-1000"], 6, price);
    // HON-1020 covers 5 of the 6; one more 3-credit course finishes it.
    expect(need.size).toBe(2);
  });
});

describe("covering several choices at once", () => {
  const credits = (c: string) => (c.endsWith("-4000") ? 4 : 3);
  const withGroups = (groups: RawGroup[][]) => {
    const raw = program("A", []);
    raw.Program.Requirements = [
      {
        Id: "r",
        Code: "R",
        Description: "R",
        CompletionStatus: "NotStarted",
        PlanningStatus: "NotPlanned",
        MinSubrequirements: null,
        MinGpa: null,
        Subrequirements: groups.map((g, i) => sub(`s${i}`, g)),
      },
    ] as never;
    return normalize(raw);
  };

  /**
   * Colleague lets one course count toward several requirements at once —
   * MATH-1705 satisfies the general-education quantitative slot and the
   * major's cognates together. Solving each group alone buys a second course
   * for a requirement that is already met.
   */
  test("one course satisfies two overlapping choices", () => {
    const tree = withGroups([
      [
        group({
          FromCourses: [course("1", "AA", "1000"), course("2", "BB", "1000")],
          MinCredits: 3,
        }),
      ],
      [
        group({
          FromCourses: [course("1", "AA", "1000"), course("3", "CC", "1000")],
          MinCredits: 3,
        }),
      ],
    ]);
    const { courses } = coursesNeeded(tree, { credits, have: new Set() });
    // AA-1000 is in both pools, so it should be the only pick.
    expect([...courses]).toEqual(["AA-1000"]);
  });

  test("disjoint choices still need one course each", () => {
    const tree = withGroups([
      [group({ FromCourses: [course("1", "AA", "1000")], MinCredits: 3 })],
      [group({ FromCourses: [course("2", "BB", "1000")], MinCredits: 3 })],
    ]);
    expect(coursesNeeded(tree, { credits, have: new Set() }).courses.size).toBe(2);
  });

  test("a required course already covers a choice that accepts it", () => {
    const tree = withGroups([
      [group({ Courses: [course("1", "AA", "1000")] })],
      [
        group({
          FromCourses: [course("1", "AA", "1000"), course("2", "BB", "1000")],
          MinCredits: 3,
        }),
      ],
    ]);
    // AA-1000 is mandatory anyway, so the choice costs nothing extra.
    expect([...coursesNeeded(tree, { credits, have: new Set() }).courses]).toEqual(["AA-1000"]);
  });

  test("completed work satisfies a choice for free", () => {
    const tree = withGroups([
      [
        group({
          FromCourses: [course("1", "AA", "1000"), course("2", "BB", "1000")],
          MinCredits: 3,
        }),
      ],
    ]);
    expect(coursesNeeded(tree, { credits, have: new Set(["BB-1000"]) }).courses.size).toBe(0);
  });

  test("a larger requirement takes more than one course", () => {
    const tree = withGroups([
      [
        group({
          FromCourses: [
            course("1", "AA", "1000"),
            course("2", "BB", "1000"),
            course("3", "CC", "1000"),
          ],
          MinCredits: 6,
        }),
      ],
    ]);
    expect(coursesNeeded(tree, { credits, have: new Set() }).courses.size).toBe(2);
  });

  test("value is credit actually closed, not credit offered", () => {
    // A 4-credit course against a 3-credit requirement closes three, so it
    // must not out-rank a 3-credit course that closes the same three.
    const tree = withGroups([
      [
        group({
          FromCourses: [course("1", "AA", "4000"), course("2", "BB", "1000")],
          MinCredits: 3,
        }),
      ],
    ]);
    expect([...coursesNeeded(tree, { credits, have: new Set() }).courses]).toEqual(["BB-1000"]);
  });
});

describe("rule groups joining the cover", () => {
  const credits = () => 3;
  const ruleGroup = (id: string) =>
    group({
      Id: id,
      RequirementCode: "R",
      SubrequirementId: "S",
      DisplayText: "One approved course",
      MinCredits: 3,
      HasRules: true,
    });

  test("an unresolved rule group is reported, not scheduled", () => {
    const tree = normalize(program("A", [ruleGroup("g1")]));
    const { courses, unenumerable } = coursesNeeded(tree, { credits, have: new Set() });
    expect(courses.size).toBe(0);
    expect(unenumerable).toHaveLength(1);
    expect(groupKey(unenumerable[0]!.ids)).toBe("R/S/g1");
  });

  /**
   * Once Colleague says what qualifies, the group is just another choice —
   * and a course already required for something else can pay for it.
   */
  test("a resolved rule group is covered by a course already required", () => {
    const tree = normalize(
      program("A", [group({ Courses: [course("1", "HON", "1020")] }), ruleGroup("g1")]),
    );
    const resolved = new Map([["R/S/g1", ["GEO-3040", "HON-1020"]]]);
    const { courses, unenumerable } = coursesNeeded(tree, {
      credits,
      have: new Set(),
      resolved,
    });

    expect([...courses]).toEqual(["HON-1020"]);
    expect(unenumerable).toHaveLength(0);
  });

  test("and buys a course when nothing required fits", () => {
    const tree = normalize(program("A", [ruleGroup("g1")]));
    const resolved = new Map([["R/S/g1", ["GEO-3040", "HIST-1110"]]]);
    const { courses } = coursesNeeded(tree, { credits, have: new Set(), resolved });
    expect(courses.size).toBe(1);
  });

  test("a bucket is never resolved into the cover", () => {
    const tree = normalize(
      program("A", [
        group({
          Id: "g2",
          RequirementCode: "R",
          SubrequirementId: "S",
          FromLevels: ["300"],
          MinCredits: 32,
        }),
      ]),
    );
    // Even handed a pool, a catch-all stays out: it is satisfied incidentally.
    const resolved = new Map([["R/S/g2", ["AA-3000", "BB-3000"]]]);
    const { courses, unenumerable } = coursesNeeded(tree, { credits, have: new Set(), resolved });
    expect(courses.size).toBe(0);
    expect(unenumerable[0]!.bucket).toBe(true);
  });
});

describe("credits earned past the size of the slot", () => {
  const applied = (name: string, credit: number) => ({
    Id: name,
    CourseId: name,
    CourseName: name,
    Title: name,
    Credit: credit,
    VerifiedGrade: "A",
    Term: "2025FA",
    IsCompletedCredit: true,
    IsTransferCourse: false,
    IsWithdrawn: false,
    IsExtraCourse: false,
    AllowedByOverride: false,
    ReplacedStatus: "NotReplaced",
    ReplacementStatus: "NotReplacement",
  });

  test("counts the excess, not the course", () => {
    // "One approved quantitative course (3 credit hours)" filled with a
    // four-credit calculus course is one credit the catalog never budgeted.
    const tree = normalize(
      program("A", [
        group({ MinCredits: 3, AppliedAcademicCredits: [applied("MATH-1705", 4)] }),
        group({ MinCredits: 3, AppliedAcademicCredits: [applied("HON-1010", 5)] }),
      ]),
    );
    expect(creditOverflow(tree)).toBe(3);
  });

  test("a slot filled exactly, or under, contributes nothing", () => {
    const tree = normalize(
      program("A", [
        group({ MinCredits: 3, AppliedAcademicCredits: [applied("ENG-1400", 3)] }),
        group({ MinCredits: 6, AppliedAcademicCredits: [applied("GMTH-1020", 3)] }),
      ]),
    );
    expect(creditOverflow(tree)).toBe(0);
  });

  test("a withdrawn course never counts", () => {
    const tree = normalize(
      program("A", [
        group({
          MinCredits: 3,
          AppliedAcademicCredits: [{ ...applied("CS-1210", 9), IsWithdrawn: true }],
        }),
      ]),
    );
    expect(creditOverflow(tree)).toBe(0);
  });

  test("a group stating no credit minimum cannot overflow", () => {
    // Take-all groups size themselves by their course list, so there is no
    // slot to exceed and no excess to claim.
    const tree = normalize(
      program("A", [
        group({
          Courses: [course("1", "CS", "1210")],
          AppliedAcademicCredits: [applied("CS-1210", 4)],
        }),
      ]),
    );
    expect(creditOverflow(tree)).toBe(0);
  });
});

describe("courses Colleague already counts twice", () => {
  const applied = (name: string, credit: number) => ({
    Id: name,
    CourseId: name,
    CourseName: name,
    Title: name,
    Credit: credit,
    VerifiedGrade: "A",
    Term: "2025FA",
    IsCompletedCredit: true,
    IsTransferCourse: false,
    IsWithdrawn: false,
    IsExtraCourse: false,
    AllowedByOverride: false,
    ReplacedStatus: "NotReplaced",
    ReplacementStatus: "NotReplacement",
  });

  /** Two requirements, so the same course can appear under both. */
  const twoRequirements = (groupsA: RawGroup[], groupsB: RawGroup[]): EvaluationResponse => {
    const base = program("A", groupsA);
    const [first] = base.Program.Requirements;
    return {
      ...base,
      Program: {
        ...base.Program,
        Requirements: [
          first!,
          {
            ...first!,
            Id: "GENED",
            Code: "GENED",
            Subrequirements: [{ ...first!.Subrequirements[0]!, Groups: groupsB }],
          },
        ],
      },
    };
  };

  test("reports a course applied under two requirements", () => {
    const tree = normalize(
      twoRequirements(
        [group({ AppliedAcademicCredits: [applied("PHYS-2110", 4)] })],
        [group({ AppliedAcademicCredits: [applied("PHYS-2110", 4)] })],
      ),
    );
    expect(sharedCredits(tree)).toEqual([
      { course: "PHYS-2110", credits: 4, requirements: ["A-r", "GENED"] },
    ]);
  });

  test("a course in one requirement twice is not shared", () => {
    // The same requirement listing it under two groups is bookkeeping, not
    // a credit counted toward two different things.
    const tree = normalize(
      program("A", [
        group({ AppliedAcademicCredits: [applied("CS-1210", 3)] }),
        group({ AppliedAcademicCredits: [applied("CS-1210", 3)] }),
      ]),
    );
    expect(sharedCredits(tree)).toEqual([]);
  });

  test("a withdrawn course never counts as shared", () => {
    const tree = normalize(
      twoRequirements(
        [group({ AppliedAcademicCredits: [applied("PHYS-2110", 4)] })],
        [group({ AppliedAcademicCredits: [{ ...applied("PHYS-2110", 4), IsWithdrawn: true }] })],
      ),
    );
    expect(sharedCredits(tree)).toEqual([]);
  });
});

describe("crediting a bucket with coursework taken anyway", () => {
  const cat = (subject: string, num: string): CourseRef => course("x", subject, num);

  test("counts what a level filter certainly accepts", () => {
    const tree = normalize(program("A", [group({ FromLevels: ["300", "400"], MinCredits: 32 })]));
    const [g] = [...walkGroups(tree)];
    const cover = groupCoverage(
      g!.group,
      [cat("CS", "3410"), cat("EGCP", "4310"), cat("CS", "1210")],
      () => 3,
    );
    // The 1000-level course is not upper division and must not be counted.
    expect(cover).toEqual({ credits: 6, unsure: 0, courses: ["CS-3410", "EGCP-4310"] });
  });

  test("keeps maybes apart from certainties", () => {
    // A rule attached to the group means Colleague narrows it in ways we
    // cannot see, so nothing can be claimed outright.
    const tree = normalize(
      program("A", [group({ FromLevels: ["300"], MinCredits: 6, HasRules: true })]),
    );
    const [g] = [...walkGroups(tree)];
    const cover = groupCoverage(g!.group, [cat("CS", "3410")], () => 3);
    expect(cover).toEqual({ credits: 0, unsure: 3, courses: [] });
  });
});

describe("choosing a branch by what it adds", () => {
  const pick1 = (groups: RawGroup[]): EvaluationResponse => {
    const base = program("A", groups);
    const [first] = base.Program.Requirements;
    return {
      ...base,
      Program: {
        ...base.Program,
        Requirements: [
          {
            ...first!,
            Subrequirements: first!.Subrequirements.map((s) => ({ ...s, MinGroups: 1 })),
          },
          // An unconditional requirement, so its take-all courses are owed
          // whichever branch above wins.
          {
            ...first!,
            Id: "CORE",
            Code: "CORE",
            Subrequirements: [
              {
                ...first!.Subrequirements[0]!,
                Id: "core-s",
                Groups: [group({ Courses: [course("1", "EGCP", "3010")] })],
              },
            ],
          },
        ],
      },
    };
  };

  test("prefers the branch whose courses the plan already owes", () => {
    // Two 3-credit branches. One is satisfied by EGCP-3010, which the core
    // requires anyway; the other needs a course nothing else wants. Priced by
    // their stated sizes these tie, and the tie breaks arbitrarily.
    const tree = normalize(
      pick1([
        group({ FromCourses: [course("9", "DSAI", "3110")], MinCredits: 3 }),
        group({ FromCourses: [course("1", "EGCP", "3010")], MinCredits: 3 }),
      ]),
    );
    const { courses } = coursesNeeded(tree, { credits: () => 3, have: new Set() });
    expect([...courses]).toEqual(["EGCP-3010"]);
  });

  test("a branch inside another choice is not treated as owed", () => {
    // EGCP-3010 here sits behind its own MinGroups choice, so it is not
    // certain, and must not make a rival branch look free.
    const tree = normalize(
      program("A", [
        group({ FromCourses: [course("9", "DSAI", "3110")], MinCredits: 3 }),
        group({ FromCourses: [course("1", "EGCP", "3010")], MinCredits: 3 }),
      ]),
    );
    const { courses } = coursesNeeded(tree, { credits: () => 3, have: new Set() });
    expect(courses.size).toBe(2);
  });
});

describe("solving several programs against one cover", () => {
  /** Two programs, each asking for one lab science from an overlapping pool. */
  const labScience = (code: string, pool: CourseRef[]) =>
    normalize(program(code, [group({ FromCourses: pool, MinCredits: 3 })]));

  const bio = course("1", "GBIO", "1000");
  const chem = course("2", "CHEM", "1110");

  test("buys a shared requirement once, not once per program", () => {
    const a = labScience("A", [bio, chem]);
    const b = labScience("B", [bio, chem]);
    const options = { credits: () => 3, have: new Set<string>() };

    // Solved separately the union is still one course only by luck of both
    // covers picking the same one; solved together it is one by construction.
    const together = coursesNeededAcross([a, b], options);
    expect(together.courses.size).toBe(1);
    // Both programs' choices are on the table.
    expect(together.choices).toHaveLength(2);
    expect(together.choices.map((c) => c.program).sort()).toEqual(["A", "B"]);
  });

  test("a program needing something the other does not still pays for it", () => {
    const a = labScience("A", [bio]);
    const b = labScience("B", [chem]);
    const { courses } = coursesNeededAcross([a, b], { credits: () => 3, have: new Set() });
    expect([...courses].sort()).toEqual(["CHEM-1110", "GBIO-1000"]);
  });

  test("carries the wording and ids a caller needs to explain a choice", () => {
    const a = normalize(
      program("A", [
        group({ DisplayText: "One laboratory science", FromCourses: [bio, chem], MinCredits: 3 }),
      ]),
    );
    const [choice] = coursesNeededAcross([a], { credits: () => 3, have: new Set() }).choices;
    expect(choice).toMatchObject({ program: "A", text: "One laboratory science", credits: 3 });
    expect(choice!.pool).toEqual(["GBIO-1000", "CHEM-1110"]);
    expect(choice!.ids).toBeDefined();
  });
});

describe("pinning a course", () => {
  test("makes everything it satisfies free", () => {
    const tree = normalize(
      program("A", [
        group({
          FromCourses: [course("1", "GBIO", "1000"), course("2", "CHEM", "1110")],
          MinCredits: 3,
        }),
      ]),
    );
    const options = { credits: () => 3, have: new Set<string>() };
    const pinned = coursesNeededAcross([tree], {
      ...options,
      pinned: new Set(["CHEM-1110"]),
    });
    // The cover must not buy a second lab science on top of the pinned one.
    expect([...pinned.courses]).toEqual(["CHEM-1110"]);
  });

  test("a pin nothing wants is still owed", () => {
    const tree = normalize(program("A", [group({ Courses: [course("1", "CS", "1210")] })]));
    const { courses } = coursesNeededAcross([tree], {
      credits: () => 3,
      have: new Set(),
      pinned: new Set(["ART-1100"]),
    });
    expect([...courses].sort()).toEqual(["ART-1100", "CS-1210"]);
  });
});
