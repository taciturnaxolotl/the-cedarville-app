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
import * as plan from "./plan";
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
    expect(root.textContent).toContain("no course list");
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
  const withSections = (): Ctx =>
    ({
      // Course id "1" is CS-1210 in the take-all group of everyKind.
      trees: [treeOf("BS.CYOPR")],
      sections: {
        term: "2026FA",
        fetchedAt: "2026-08-12T00:00:00.000Z",
        sections: [
          {
            Id: "s1",
            CourseId: "1",
            CourseName: "CS-1210",
            Number: "01",
            Title: "Intro",
            Synonym: "40123",
            TermId: "2026FA",
            MinimumCredits: 3,
            MaximumCredits: null,
            Capacity: 30,
            Enrolled: 30,
            Available: 0,
            Waitlisted: 2,
            AvailabilityStatus: "Waitlisted",
            IsNonStandardDates: false,
            StartDate: "2026-08-19T00:00:00-04:00",
            EndDate: "2026-12-11T00:00:00-05:00",
            FacultyDisplay: ["Dr Who"],
            Meetings: [
              {
                Days: [1, 3],
                // UTC, as Colleague really sends it: 13:00Z is 9am on campus.
                StartTime: "2026-08-11T13:00:00+00:00",
                EndTime: "2026-08-11T13:50:00+00:00",
                StartDate: "2026-08-19T00:00:00-04:00",
                EndDate: "2026-12-11T00:00:00-05:00",
                Room: "234",
                Frequency: "W",
                IsOnline: false,
                InstructionalMethodCode: "LEC",
              },
            ],
            FormattedMeetingTimes: [],
          },
        ],
      },
    }) as unknown as Ctx;

  test("asks for a term before it can build anything", () => {
    schedule.mount(root, { trees: [treeOf("BS.CYOPR")] });
    expect(root.textContent).toContain("pick a term");
  });

  test("groups sections under a course card inside its requirement", () => {
    schedule.mount(root, withSections());
    expect(root.querySelectorAll("details.req").length).toBeGreaterThan(0);
    expect(root.querySelectorAll("details.course").length).toBe(1);
    expect(root.textContent).toContain("CS-1210");
    expect(root.textContent).toContain("MonWed 9:00am\u20139:50am");
    expect(root.textContent).toContain("Dr Who");
  });

  test("shows a full section as full rather than hiding it", () => {
    schedule.mount(root, withSections());
    expect(root.querySelector(".tag.full")).toBeTruthy();
    expect(root.textContent).toContain("0/30");
    expect(root.querySelector(".tag.seats")?.getAttribute("title")).toContain("0 of 30 seats open");
  });

  // The point of the overhaul: a course says whether you can take it.
  test("a course with no requisites reads as ready", () => {
    schedule.mount(root, withSections());
    const card = root.querySelector("details.course") as HTMLElement;
    expect(card.dataset.state).toBe("open");
    expect(root.querySelector(".gate.open")?.textContent).toBe("ready");
  });

  test("starts with an empty week", () => {
    schedule.mount(root, withSections());
    expect(root.textContent).toContain("nothing picked yet");
  });

  test("destroy clears the outlet", () => {
    schedule.mount(root, withSections()).destroy();
    expect(root.children).toHaveLength(0);
  });

  /**
   * The whole reason for the overhaul: a course whose prerequisite the
   * student has not completed must say so, name the missing course, and not
   * simply look identical to one they can take.
   */
  const withPrereq = (): Ctx => {
    const ctx = withSections() as any;
    ctx.sections.courses = [
      // CS-1000 must exist in the catalog, or the requisite reads as a stale
      // reference and the course is reported unknown rather than blocked.
      { Id: "0", SubjectCode: "CS", Number: "1000", Title: "Prereq", MinimumCredits: 3 },
      {
        Id: "1",
        SubjectCode: "CS",
        Number: "1210",
        Title: "Intro",
        CourseRequisites: [
          {
            DisplayText: "Take CS-1000",
            DisplayTextExtension: "- Must be completed prior to taking this course.",
            IsRequired: true,
          },
        ],
      },
    ];
    return ctx as Ctx;
  };

  test("a blocked course names what it is waiting on", () => {
    localStorage.clear();
    schedule.mount(root, withPrereq());

    const card = root.querySelector("details.course") as HTMLElement;
    expect(card.dataset.state).toBe("blocked");
    expect(root.querySelector(".gate.blocked")?.textContent).toBe("blocked");
    expect(root.textContent).toContain("needs CS-1000");
  });

  test("hiding blocked courses removes them from view", () => {
    localStorage.clear();
    schedule.mount(root, withPrereq());
    const card = root.querySelector("details.course") as HTMLElement;
    expect(card.hidden).toBe(false);

    const filter = root.querySelector(".toggle input") as HTMLInputElement;
    filter.click();
    expect(card.hidden).toBe(true);

    filter.click();
    expect(card.hidden).toBe(false);
  });

  test("an unparseable condition reads as check, not as ready", () => {
    localStorage.clear();
    const ctx = withPrereq() as any;
    // Index 1 is CS-1210; index 0 is now the CS-1000 it depends on.
    ctx.sections.courses[1].CourseRequisites = [
      {
        DisplayText: "Permission of the instructor.",
        DisplayTextExtension: "- Must be completed prior to taking this course.",
        IsRequired: true,
      },
    ];
    schedule.mount(root, ctx as Ctx);

    const card = root.querySelector("details.course") as HTMLElement;
    expect(card.dataset.state).toBe("unknown");
    expect(root.textContent).toContain("Permission of the instructor");
  });

  // The refactor this replaced ran a full DOM sweep on every tick. These
  // assert the reactive path: an event sets state, state repaints the parts
  // that depend on it, and nothing else is touched.
  test("ticking a section updates the week without a manual sweep", () => {
    localStorage.clear();
    schedule.mount(root, withSections());
    expect(root.textContent).toContain("nothing picked yet");

    const box = root.querySelector("label.section input") as HTMLInputElement;
    box.click();

    expect(root.textContent).toContain("1 sections · 3 credits");
    expect(root.querySelector(".grid")).toBeTruthy();
    expect(root.textContent).toContain("Mon");
  });

  test("unticking puts the week back", () => {
    localStorage.clear();
    schedule.mount(root, withSections());
    const box = root.querySelector("label.section input") as HTMLInputElement;

    box.click();
    expect(root.querySelector(".grid")).toBeTruthy();

    box.click();
    expect(root.textContent).toContain("nothing picked yet");
    expect(root.querySelector(".grid")).toBeFalsy();
  });

  test("a pick survives a remount", () => {
    localStorage.clear();
    const first = schedule.mount(root, withSections());
    const box = root.querySelector("label.section input") as HTMLInputElement;
    box.click();
    first.destroy();

    schedule.mount(root, withSections());
    const restored = root.querySelector("label.section input") as HTMLInputElement;
    expect(restored.checked).toBe(true);
    expect(root.textContent).toContain("1 sections");
  });

  test("destroy detaches subscriptions so a stale view cannot repaint", () => {
    localStorage.clear();
    const view = schedule.mount(root, withSections());
    const box = root.querySelector("label.section input") as HTMLInputElement;
    view.destroy();

    // The node is detached; clicking it must not throw or resurrect anything.
    expect(() => box.click()).not.toThrow();
    expect(root.children).toHaveLength(0);
  });
});

describe("plan view", () => {
  /**
   * Its own tree as well as its own catalog. The shared fixture declares
   * MinGroups: 1 over eight groups, which `coursesNeeded` now honours — so it
   * correctly needs almost nothing, and a plan built from it is empty.
   */
  const planTree = () => {
    const raw = program("BS.CYOPR", [
      group({ Courses: [course("1", "CS", "1210")] }),
      group({ Courses: [course("2", "CS", "2210")] }),
    ]);
    raw.Program.Requirements[0]!.Subrequirements[0]!.MinGroups = null;
    return normalize(raw);
  };

  const ctxWith = (courses: unknown[]): Ctx =>
    ({
      trees: [planTree()],
      sections: {
        term: "2026FA",
        fetchedAt: "2026-08-12T00:00:00.000Z",
        sections: [],
        courses,
      },
    }) as unknown as Ctx;

  const CHAIN = [
    { Id: "1", SubjectCode: "CS", Number: "1210", Title: "Intro", MinimumCredits: 3 },
    {
      Id: "2",
      SubjectCode: "CS",
      Number: "2210",
      Title: "Data Structures",
      MinimumCredits: 3,
      CourseRequisites: [
        {
          DisplayText: "Take CS-1210",
          DisplayTextExtension: "- Must be completed prior to taking this course.",
          IsRequired: true,
        },
      ],
    },
  ];

  test("asks for data before projecting anything", () => {
    plan.mount(root, { trees: [] });
    expect(root.textContent).toContain("capture your requirements");
  });

  test("projects terms and shows the critical path", () => {
    plan.mount(root, ctxWith(CHAIN));
    expect(root.querySelector(".chain-node")).toBeTruthy();
    expect(root.textContent).toContain("critical path");
    expect(root.querySelectorAll(".term").length).toBeGreaterThan(0);
  });

  // A chain cannot be compressed by raising the credit cap, which is the
  // whole point of showing the critical path.
  test("the credit slider reprojects but cannot beat the chain", () => {
    plan.mount(root, ctxWith(CHAIN));
    const terms = () => root.querySelectorAll(".term:not(.unplaced)").length;
    const before = terms();

    const slider = root.querySelector("input[type=range]") as HTMLInputElement;
    slider.value = "21";
    // A range has no click() equivalent, and happy-dom's Event is structurally
    // different from the DOM one, so the cast is the honest way through.
    slider.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    expect(terms()).toBeGreaterThanOrEqual(before);
  });

  test("destroy clears the outlet", () => {
    plan.mount(root, ctxWith(CHAIN)).destroy();
    expect(root.children).toHaveLength(0);
  });
});
