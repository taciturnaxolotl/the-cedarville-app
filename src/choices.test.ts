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
      slots: termsFrom({ year: 2027, season: "spring" }, 2, { capacity: 6, summers: 0 }),
    });
    const deep = ranking.choices[0]!.candidates.find((c) => c.code === "DEEP-4000")!;
    expect(deep.addedTerms).toBeNull();
    // And it sorts behind the one that is merely free.
    expect(ranking.choices[0]!.candidates[0]!.code).toBe("ART-1100");
  });

  test("buys the prerequisites of what the cover picks", () => {
    // LIT-2090 closes the literature slot and needs LIT-1990 first, which no
    // requirement asks for. Without the chain the projection strands it.
    const tree = normalize(
      program("A", [
        group({
          DisplayText: "literature",
          FromCourses: [course("1", "LIT", "2090")],
          MinCredits: 3,
        }),
      ]),
    );
    const ranking = rankChoices([tree], base([node("LIT-2090", ["LIT-1990"]), node("LIT-1990")]));
    expect(ranking.baseline.unscheduled).toEqual([]);
    expect(ranking.baseline.totalCredits).toBe(6);
  });

  test("one stranded course in the baseline does not poison every candidate", () => {
    // NEVER-4000 is required and taught in no season we model, so it can never
    // be placed. That is its problem, not the elective pool's — and reporting
    // it as everyone's problem made every course in every pool read the same.
    const tree = normalize(
      program("A", [
        group({ Courses: [course("8", "NEVER", "4000")] }),
        group({
          Id: "e",
          DisplayText: "one elective",
          FromCourses: [course("1", "ART", "1100"), course("2", "ART", "1200")],
          MinCredits: 3,
        }),
      ]),
    );
    const ranking = rankChoices([tree], {
      ...base([node("NEVER-4000"), node("ART-1100"), node("ART-1200")]),
      offeredIn: (code: string) => code !== "NEVER-4000",
    });

    expect(ranking.baseline.unscheduled.map((u) => u.code)).toEqual(["NEVER-4000"]);
    const priced = ranking.choices.flatMap((c) => c.candidates).filter((c) => !c.forced);
    expect(priced.length).toBeGreaterThan(0);
    expect(priced.every((c) => c.addedTerms !== null)).toBe(true);
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
    expect(ranking.choices[0]!.candidates.some((c) => c.chosen)).toBe(true);
  });

  test("keeps a baseline plan alongside the choices", () => {
    const tree = normalize(program("A", [group({ Courses: [course("1", "CS", "1210")] })]));
    const ranking = rankChoices([tree], base([node("CS-1210")]));
    expect(ranking.baseline.finishes).toBe("SP27");
    expect(ranking.baseline.totalCredits).toBe(3);
  });
});

describe("tracks and concentrations", () => {
  /** "Take the AI track, or six credits of technical electives." */
  const withTrack = () =>
    normalize({
      StudentId: "1",
      Program: {
        Code: "A",
        Title: "A",
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
            Id: "r",
            Code: "r",
            Description: "core",
            CompletionStatus: "NotStarted",
            PlanningStatus: "NotPlanned",
            MinSubrequirements: null,
            MinGpa: null,
            Subrequirements: [
              {
                Id: "s",
                Code: "s",
                DisplayText: "Technical electives or the AI track",
                CompletionStatus: "NotStarted",
                PlanningStatus: "NotPlanned",
                MinGroups: 1,
                MinGpa: null,
                MinInstitutionalCredits: null,
                Groups: [
                  group({
                    Id: "tech",
                    DisplayText: "Technical electives (3 credit hours)",
                    FromCourses: [course("1", "CS", "3220")],
                    MinCredits: 3,
                  }),
                  group({
                    Id: "ai",
                    DisplayText: "Artificial Intelligence Track (9 credit hours)",
                    FromCourses: [
                      course("2", "DSAI", "2110"),
                      course("3", "DSAI", "3110"),
                      course("4", "DSAI", "3510"),
                    ],
                    MinCredits: 9,
                  }),
                ],
              },
            ],
          },
        ],
      },
    } as EvaluationResponse);

  const graph = [node("CS-3220"), node("DSAI-2110"), node("DSAI-3110"), node("DSAI-3510")];

  test("surfaces the decision instead of making it silently", () => {
    const ranking = rankChoices([withTrack()], base(graph));
    expect(ranking.branches).toHaveLength(1);
    const [branch] = ranking.branches;
    expect(branch!.text).toBe("Technical electives or the AI track");
    expect(branch!.pick).toBe(1);
    expect(branch!.options.map((o) => o.id)).toEqual(["tech", "ai"]);
  });

  test("prices the road not taken", () => {
    const [branch] = rankChoices([withTrack()], base(graph)).branches;
    const tech = branch!.options.find((o) => o.id === "tech")!;
    const ai = branch!.options.find((o) => o.id === "ai")!;
    expect(tech).toMatchObject({ taken: true, addedTerms: 0, addedCredits: 0 });
    // Nine credits of AI against three of electives, so six more.
    expect(ai.taken).toBe(false);
    expect(ai.addedCredits).toBe(6);
  });

  test("honours a track the student has chosen over the cheapest", () => {
    const ranking = rankChoices([withTrack()], {
      ...base(graph),
      tracks: new Map([["r/s", ["ai"]]]),
    });
    expect(ranking.branches[0]!.options.find((o) => o.id === "ai")?.taken).toBe(true);
    expect([...ranking.baseline.terms.flatMap((t) => t.courses.map((c) => c.code))].sort()).toEqual(
      ["DSAI-2110", "DSAI-3110", "DSAI-3510"],
    );
  });

  test("a requirement with no alternatives is not a decision", () => {
    const tree = normalize(program("A", [group({ Courses: [course("1", "CS", "1210")] })]));
    expect(rankChoices([tree], base([node("CS-1210")])).branches).toEqual([]);
  });
});

describe("required outright versus merely chosen", () => {
  const pool = [course("1", "CS", "1210"), course("9", "ART", "1100")];

  test("a course another requirement forces is marked forced", () => {
    const major = normalize(program("MAJ", [group({ Courses: [course("1", "CS", "1210")] })]));
    const minor = normalize(
      program("MIN", [
        group({ Id: "e", DisplayText: "elective", FromCourses: pool, MinCredits: 3 }),
      ]),
    );
    const ranking = rankChoices([major, minor], base([node("CS-1210"), node("ART-1100")]));
    const cs = ranking.choices[0]!.candidates.find((c) => c.code === "CS-1210")!;
    expect(cs).toMatchObject({ forced: true, chosen: true });
  });

  test("a course the cover bought for this very group is chosen, not forced", () => {
    // Nothing else in the degree wants either course. The cover picks one to
    // close the group — which must not then read as though the group were
    // settled by some other requirement.
    const tree = normalize(
      program("A", [group({ DisplayText: "elective", FromCourses: pool, MinCredits: 3 })]),
    );
    const ranking = rankChoices([tree], base([node("CS-1210"), node("ART-1100")]));
    const picked = ranking.choices[0]!.candidates.filter((c) => c.chosen);
    expect(picked).toHaveLength(1);
    expect(picked[0]!.forced).toBe(false);
  });
});

describe("switching away from a dearer track", () => {
  const twoRoutes = () =>
    normalize({
      StudentId: "1",
      Program: {
        Code: "A",
        Title: "A",
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
            Id: "r",
            Code: "r",
            Description: "core",
            CompletionStatus: "NotStarted",
            PlanningStatus: "NotPlanned",
            MinSubrequirements: null,
            MinGpa: null,
            Subrequirements: [
              {
                Id: "s",
                Code: "s",
                DisplayText: "Electives or the AI track",
                CompletionStatus: "NotStarted",
                PlanningStatus: "NotPlanned",
                MinGroups: 1,
                MinGpa: null,
                MinInstitutionalCredits: null,
                Groups: [
                  group({
                    Id: "tech",
                    DisplayText: "Technical electives",
                    FromCourses: [course("1", "CS", "3220")],
                    MinCredits: 3,
                  }),
                  group({
                    Id: "ai",
                    DisplayText: "AI Track",
                    FromCourses: [course("2", "DSAI", "2110"), course("3", "DSAI", "3110")],
                    MinCredits: 6,
                  }),
                ],
              },
            ],
          },
        ],
      },
    } as EvaluationResponse);

  const graph = [node("CS-3220"), node("DSAI-2110"), node("DSAI-3110")];

  test("the cheaper route reads as a saving once the dearer one is chosen", () => {
    const ranking = rankChoices([twoRoutes()], {
      ...base(graph),
      tracks: new Map([["r/s", ["ai"]]]),
    });
    const [branch] = ranking.branches;
    const tech = branch!.options.find((o) => o.id === "tech")!;
    expect(tech.taken).toBe(false);
    // Three credits against six: switching back gives three back, and saying
    // "free" would hide the only number worth showing.
    expect(tech.addedCredits).toBe(-3);
  });
});

describe("when a course would actually be taken", () => {
  const pool = [course("1", "ART", "1100"), course("9", "DEEP", "4000")];
  const tree = () =>
    normalize(
      program("A", [group({ DisplayText: "one elective", FromCourses: pool, MinCredits: 3 })]),
    );
  const graph = [node("ART-1100"), node("DEEP-4000", ["DEEP-3000"]), node("DEEP-3000")];

  test("reports the term the projection puts it in", () => {
    const ranking = rankChoices([tree()], base(graph));
    const art = ranking.choices[0]!.candidates.find((c) => c.code === "ART-1100")!;
    expect(art.lands).toBe("SP27");
    // A four-course chain lands later than a course with none.
    const deep = ranking.choices[0]!.candidates.find((c) => c.code === "DEEP-4000")!;
    expect(deep.lands).not.toBe("SP27");
  });

  test("reports the seasons a course has been seen taught in", () => {
    const ranking = rankChoices([tree()], {
      ...base(graph),
      offeredIn: (code: string, slot) => code !== "DEEP-4000" || slot.season === "spring",
    });
    const deep = ranking.choices[0]!.candidates.find((c) => c.code === "DEEP-4000")!;
    expect(deep.offered).toEqual(["spring"]);
  });

  test("names what a choice pushes off the end", () => {
    // Two slots and a required course that only runs in summer, which the
    // horizon does not reach once the chain is bought.
    const crowded = normalize(
      program("A", [
        group({ Courses: [course("8", "LATE", "4000")] }),
        group({ Id: "e", DisplayText: "one elective", FromCourses: pool, MinCredits: 3 }),
      ]),
    );
    const ranking = rankChoices([crowded], {
      ...base([...graph, node("LATE-4000")]),
      slots: termsFrom({ year: 2027, season: "spring" }, 2, { capacity: 3, summers: 0 }),
    });
    const deep = ranking.choices.flatMap((c) => c.candidates).find((c) => c.code === "DEEP-4000")!;
    expect(deep.addedTerms).toBeNull();
    expect(deep.displaces.length).toBeGreaterThan(0);
  });
});
