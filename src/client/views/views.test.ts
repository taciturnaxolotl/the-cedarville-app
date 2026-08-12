/*
 * Smoke tests for the two views. They assert very little about appearance and
 * a lot about not throwing, because the failure mode for framework-free DOM
 * code is a blank page and a console error nobody reads. Typecheck cannot
 * catch a null child or a missing element; running the render can.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { normalize, type ProgramTree } from "../../requirements";
import type { EvaluationResponse, RawGroup } from "../../types";
import type { Ctx } from "../ctx";
import * as overlap from "./overlap";
import * as schedule from "./schedule";
import * as tree from "./tree";

const window = new Window();
// The views call document.createElement, and the schedule view persists picks.
// Without localStorage here its try/catch would hide a real failure.
Object.assign(globalThis, {
  document: window.document,
  window,
  localStorage: window.localStorage,
});

const course = (id: string, subject: string, num: string) => ({
  Id: id,
  SubjectCode: subject,
  Number: num,
  Title: `${subject}-${num}`,
  CourseName: `${subject}-${num}`,
  EquatedCourseIds: [],
  IsPseudoCourse: false,
});

const group = (over: Partial<RawGroup>): RawGroup =>
  ({
    Id: "g",
    Code: "Group 1",
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
  }) as RawGroup;

const program = (code: string, groups: RawGroup[]): EvaluationResponse =>
  ({
    StudentId: "1",
    Program: {
      Code: code,
      Title: `${code} program`,
      Catalog: "2026",
      Degree: "BS",
      MinimumCredits: 128,
      CompletedCredits: 39,
      InProgressCredits: 16,
      PlannedCredits: 0,
      RequiredRequirementCount: 1,
      CompletedRequirementCount: 0,
      Requirements: [
        {
          Id: "r",
          Code: "r",
          Description: `${code} core`,
          CompletionStatus: "PartiallyCompleted",
          PlanningStatus: "PartiallyPlanned",
          MinSubrequirements: null,
          MinGpa: null,
          Subrequirements: [
            {
              Id: "s",
              Code: "s",
              DisplayText: "Requirements",
              CompletionStatus: "NotStarted",
              PlanningStatus: "NotPlanned",
              MinGroups: 1,
              MinGpa: null,
              MinInstitutionalCredits: null,
              Groups: groups,
            },
          ],
        },
      ],
    },
  }) as EvaluationResponse;

/** One of each constraint kind, so every branch of renderGroup executes. */
const everyKind: RawGroup[] = [
  group({ Courses: [course("1", "CS", "1210")], DisplayText: "Take this" }),
  group({ FromCourses: [course("2", "MATH", "2740")], MinCourses: 1, MinCredits: 3 }),
  group({ FromSubjects: [{ Code: "LIT", Description: "Lit" }], FromLevels: ["200"] }),
  group({
    FromDepartments: [{ Code: "EG", Description: "Engineering" }],
    FromLevels: ["300"],
    MinCredits: 3,
  }),
  group({ DisplayText: "One lab from the biological sciences", MinCredits: 3.5, HasRules: true }),
  group({ DisplayText: "Live abroad for a year." }),
  // Half done with the remainder on the degree plan: the state that must read
  // differently from both "finished" and "gap".
  group({
    Courses: [course("4", "PEF", "1990")],
    DisplayText: "Physical Education",
    CompletionStatus: "PartiallyCompleted",
    PlanningStatus: "CompletelyPlanned",
  }),
  group({
    Courses: [course("3", "BTGE", "1725")],
    CompletionStatus: "Completed",
    PlanningStatus: "CompletelyPlanned",
    AppliedAcademicCredits: [
      {
        Id: "a1",
        CourseId: "3",
        CourseName: "BTGE-1725",
        Title: "Bible",
        Credit: 3,
        VerifiedGrade: "A",
        Term: "24/FA",
        IsCompletedCredit: true,
        IsTransferCourse: false,
        IsWithdrawn: false,
        IsExtraCourse: false,
        AllowedByOverride: false,
        ReplacedStatus: "NotReplaced",
        ReplacementStatus: "NotReplacement",
      },
    ],
  }),
];

let root: HTMLElement;
beforeEach(() => {
  window.document.body.innerHTML = "<main id='outlet'></main>";
  root = window.document.getElementById("outlet") as unknown as HTMLElement;
});

const treeOf = (code: string, groups = everyKind): ProgramTree => normalize(program(code, groups));

describe("tree view", () => {
  test("renders every constraint kind without throwing", () => {
    const view = tree.mount(root, { trees: [treeOf("BS.CYOPR")] });
    expect(root.querySelectorAll(".group")).toHaveLength(everyKind.length);
    expect(root.textContent).toContain("BS.CYOPR");
    view.destroy();
    expect(root.children).toHaveLength(0);
  });

  test("shows a rule-based group as advisory rather than hiding it", () => {
    tree.mount(root, { trees: [treeOf("BS.CYOPR")] });
    expect(root.textContent).toContain("One lab from the biological sciences");
    expect(root.textContent).toContain("check with advisor");
  });

  test("carries completion on the dot and planning on a tag", () => {
    tree.mount(root, { trees: [treeOf("BS.CYOPR")] });
    expect(root.querySelector(".dot.Completed")).toBeTruthy();
    expect(root.querySelector(".dot.NotStarted")).toBeTruthy();
    expect(root.textContent).toContain("on your plan");
  });

  test("renders applied credits with their grade", () => {
    tree.mount(root, { trees: [treeOf("BS.CYOPR")] });
    expect(root.textContent).toContain("done: BTGE-1725 A");
  });
});

describe("overlap view", () => {
  test("asks for a second major when given one tree", () => {
    overlap.mount(root, { trees: [treeOf("BS.CYOPR")] });
    expect(root.textContent).toContain("capture a second major");
  });

  test("renders shared pools and the unresolved list", () => {
    overlap.mount(root, { trees: [treeOf("BS.CYOPR"), treeOf("BS.CMPEG")] });
    expect(root.textContent).toContain("BS.CYOPR + BS.CMPEG");
    // MATH-2740 sits in a choose-from pool on both sides.
    expect(root.querySelectorAll(".pool").length).toBeGreaterThan(0);
    expect(root.textContent).toContain("MATH-2740");
    // The rule and department groups must be named, not silently dropped.
    expect(root.textContent).toContain("cannot be checked automatically");
    expect(root.textContent).toContain("Colleague rule");
    expect(root.textContent).toContain("department");
  });

  test("destroy clears the outlet", () => {
    overlap.mount(root, { trees: [treeOf("A"), treeOf("B")] }).destroy();
    expect(root.children).toHaveLength(0);
  });
});

describe("schedule view", () => {
  const withSections = (): Ctx => {
    const structured = {
      Days: ["Monday", "Wednesday"],
      StartTime: "2026-08-24T08:00:00",
      EndTime: "2026-08-24T09:00:00",
      StartDate: "2026-08-24T00:00:00",
      EndDate: "2026-12-11T00:00:00",
      Room: "234",
      Frequency: "W",
      IsOnline: false,
      InstructionalMethodCode: "LEC",
    };
    const section = (id: string, name: string, start: string, end: string) => ({
      Section: {
        Id: id,
        CourseId: "1",
        CourseName: name,
        Number: "01",
        Title: name,
        Synonym: id,
        TermId: "26/FA",
        MinimumCredits: 3,
        MaximumCredits: null,
        Capacity: 30,
        Enrolled: 30,
        Available: 0,
        Waitlisted: 2,
        AvailabilityStatus: "Waitlisted",
        IsNonStandardDates: false,
        StartDate: "2026-08-24T00:00:00",
        EndDate: "2026-12-11T00:00:00",
        Meetings: [{ ...structured, StartTime: start, EndTime: end }],
        FormattedMeetingTimes: [],
      },
      FacultyDisplay: "Dr Who",
      InstructorDetails: [{ FacultyId: "1", FacultyName: "Dr Who" }],
    });

    return {
      // Course id "1" is CS-1210 in the take-all group of everyKind.
      trees: [treeOf("BS.CYOPR")],
      sections: {
        capturedAt: "2026-08-12T00:00:00Z",
        term: "26/FA",
        requested: 4,
        notOffered: [],
        sections: {
          "1": {
            SectionsRetrieved: {
              Course: {},
              TermsAndSections: [
                {
                  Term: { Code: "26/FA", Description: "Fall 2026" },
                  Sections: [
                    section("s1", "CS-1210", "2026-08-24T08:00:00", "2026-08-24T09:00:00"),
                  ],
                },
              ],
            },
          },
        },
      },
    } as unknown as Ctx;
  };

  test("asks for sections before it can build anything", () => {
    schedule.mount(root, { trees: [treeOf("BS.CYOPR")] });
    expect(root.textContent).toContain("load sections");
  });

  test("lists a section under the requirement it would close", () => {
    schedule.mount(root, withSections());
    expect(root.querySelectorAll("details.req").length).toBeGreaterThan(0);
    expect(root.textContent).toContain("CS-1210");
    expect(root.textContent).toContain("MonWed 8:00am–9:00am");
    expect(root.textContent).toContain("Dr Who");
  });

  test("shows a full section as full rather than hiding it", () => {
    schedule.mount(root, withSections());
    expect(root.querySelector(".tag.full")).toBeTruthy();
    expect(root.textContent).toContain("0 of 30 open");
  });

  test("starts with an empty week", () => {
    schedule.mount(root, withSections());
    expect(root.textContent).toContain("nothing picked yet");
  });

  test("destroy clears the outlet", () => {
    schedule.mount(root, withSections()).destroy();
    expect(root.children).toHaveLength(0);
  });
});
