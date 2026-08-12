import { describe, expect, test } from "bun:test";
import { rankChoices } from "./choices";
import { termsFrom } from "./planner";
import { buildGraph, type CourseNode, parseRequisite } from "./prereqs";
import { normalize } from "./requirements";
import type { CourseRef, EvaluationResponse, RawGroup } from "./types";

const course = (id: string, subject: string, num: string): CourseRef => ({
  Id: id,
  SubjectCode: subject,
  Number: num,
  Title: `${subject}-${num}`,
  CourseName: `${subject}-${num}`,
  EquatedCourseIds: [],
  IsPseudoCourse: false,
});

const group = (over: Partial<RawGroup>): RawGroup => ({
  Id: over.Id ?? "g",
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

/** Every course is offered every season unless a test says otherwise. */
const base = (nodes: CourseNode[] = []) => ({
  credits: () => 3,
  have: new Set<string>(),
  graph: buildGraph(nodes),
  offeredIn: () => true,
  slots: termsFrom({ year: 2027, season: "spring" as const }, 8, { capacity: 6 }),
});

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

describe("pricing a choice", () => {
  test("a course the plan already buys is free and marked forced", () => {
    // The major requires CS-1210 outright; the minor's elective accepts it.
    const major = normalize(program("MAJ", [group({ Courses: [course("1", "CS", "1210")] })]));
    const minor = normalize(
      program("MIN", [
        group({
          DisplayText: "One computing elective",
          FromCourses: [course("1", "CS", "1210"), course("2", "ART", "1100")],
          MinCredits: 3,
        }),
      ]),
    );

    const ranking = rankChoices([major, minor], base([node("CS-1210"), node("ART-1100")]));
    const [choice] = ranking.choices;
    expect(choice!.candidates[0]).toMatchObject({
      code: "CS-1210",
      forced: true,
      addedTerms: 0,
      addedCredits: 0,
    });
    // The alternative costs real credits, so it must not sort first.
    expect(choice!.candidates.find((c) => c.code === "ART-1100")?.addedCredits).toBe(3);
  });

  test("a course behind a prerequisite chain costs terms", () => {
    // ART-1100 is takeable now; DEEP-4000 sits behind two prerequisites, so
    // choosing it pushes the finish date out.
    const tree = normalize(
      program("A", [
        group({
          DisplayText: "One elective",
          FromCourses: [course("1", "ART", "1100"), course("9", "DEEP", "4000")],
          MinCredits: 3,
        }),
      ]),
    );
    const graph = [
      node("ART-1100"),
      node("DEEP-4000", ["DEEP-3000"]),
      node("DEEP-3000", ["DEEP-2000"]),
      node("DEEP-2000"),
    ];

    const ranking = rankChoices([tree], base(graph));
    const [choice] = ranking.choices;
    expect(choice!.candidates[0]!.code).toBe("ART-1100");

    // Two prerequisites, so two extra terms and six extra credits — the price
    // of the choice is the chain, not the course.
    const deep = choice!.candidates.find((c) => c.code === "DEEP-4000")!;
    expect(deep).toMatchObject({ addedTerms: 2, addedCredits: 6 });
    expect(deep.requires.sort()).toEqual(["DEEP-2000", "DEEP-3000"]);
  });

  test("a candidate whose chain outruns the horizon is unpriced, not cheap", () => {
    // Two slots, and DEEP-4000's chain needs four. Reporting a small number
    // here would sort an impossible choice above a merely costly one.
    const tree = normalize(
      program("A", [
        group({
          DisplayText: "one elective",
          FromCourses: [course("1", "ART", "1100"), course("9", "DEEP", "4000")],
          MinCredits: 3,
        }),
      ]),
    );
    const ranking = rankChoices([tree], {
      ...base([
        node("ART-1100"),
        node("DEEP-4000", ["DEEP-3000"]),
        node("DEEP-3000", ["DEEP-2000"]),
        node("DEEP-2000", ["DEEP-1000"]),
        node("DEEP-1000"),
      ]),
      slots: termsFrom({ year: 2027, season: "spring" }, 2, { capacity: 6, includeSummers: false }),
    });
    const deep = ranking.choices[0]!.candidates.find((c) => c.code === "DEEP-4000")!;
    expect(deep.addedTerms).toBeNull();
    // And it sorts behind the one that is merely free.
    expect(ranking.choices[0]!.candidates[0]!.code).toBe("ART-1100");
  });

  test("reports which programs a candidate pays into", () => {
    const shared = course("1", "GBIO", "1000");
    const a = normalize(
      program("A", [group({ DisplayText: "lab", FromCourses: [shared], MinCredits: 3 })]),
    );
    const b = normalize(
      program("B", [
        group({ Id: "h", DisplayText: "science", FromCourses: [shared], MinCredits: 3 }),
      ]),
    );

    const ranking = rankChoices([a, b], base([node("GBIO-1000")]));
    const candidate = ranking.choices
      .flatMap((c) => c.candidates)
      .find((c) => c.code === "GBIO-1000");
    expect(candidate!.satisfies.map((s) => s.program).sort()).toEqual(["A", "B"]);
    expect(ranking.shared).toEqual([{ code: "GBIO-1000", programs: ["A", "B"] }]);
  });
});

describe("presenting the choices", () => {
  test("collapses the same requirement reached from two programs", () => {
    // Both programs carry the identical general-education group. A student
    // makes that decision once, not twice.
    const shared = group({
      Id: "gened-lit",
      DisplayText: "2000-level literature",
      FromCourses: [course("1", "LIT", "2090")],
      MinCredits: 3,
    });
    const a = normalize(program("A", [shared]));
    const b = normalize(program("B", [shared]));

    const ranking = rankChoices([a, b], base([node("LIT-2090")]));
    expect(ranking.choices).toHaveLength(1);
    expect(ranking.choices[0]!.program).toBe("A + B");
  });

  test("respects the pricing limit but never at the cost of the free ones", () => {
    const pool = Array.from({ length: 30 }, (_, i) => course(`${i}`, "ART", `1${100 + i}`));
    const tree = normalize(
      program("A", [group({ DisplayText: "art", FromCourses: pool, MinCredits: 3 })]),
    );
    const ranking = rankChoices([tree], { ...base(pool.map((c) => node(c.CourseName))), limit: 5 });
    expect(ranking.choices[0]!.candidates.length).toBeLessThanOrEqual(6);
    // Whatever the cover already bought is present regardless of the limit.
    expect(ranking.choices[0]!.candidates.some((c) => c.forced)).toBe(true);
  });

  test("keeps a baseline plan alongside the choices", () => {
    const tree = normalize(program("A", [group({ Courses: [course("1", "CS", "1210")] })]));
    const ranking = rankChoices([tree], base([node("CS-1210")]));
    expect(ranking.baseline.finishes).toBe("SP27");
    expect(ranking.baseline.totalCredits).toBe(3);
  });
});
