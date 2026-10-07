/*
 * Smoke tests for the two views. They assert very little about appearance and
 * a lot about not throwing, because the failure mode for framework-free DOM
 * code is a blank page and a console error nobody reads. Typecheck cannot
 * catch a null child or a missing element; running the render can.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { nextPlannableTerm, shortTerm, termCodeOf } from "../../catalog";
import { termsFrom } from "../../planner";
import { normalize, type ProgramTree } from "../../requirements";
import type { EvaluationResponse, RawGroup } from "../../types";
import type { Ctx } from "../ctx";
import { SUMMERS } from "../load";
import * as build from "./build";
import * as plan from "./plan";
import * as record from "./record";
import * as semester from "./semester";

// The dev dump only fires on localhost, which is where the app runs.
const window = new Window({ url: "http://localhost:5173/" });
// The views call document.createElement, and the semester view persists picks.
// Without localStorage here its try/catch would hide a real failure.
Object.assign(globalThis, {
  document: window.document,
  window,
  localStorage: window.localStorage,
  location: window.location,
  navigator: window.navigator,
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

const program = (
  code: string,
  groups: RawGroup[],
  named: { Majors?: string[]; Minors?: string[] } = {},
): EvaluationResponse =>
  ({
    StudentId: "1",
    Program: {
      ...named,
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

describe("record view", () => {
  test("renders every constraint kind without throwing", () => {
    const view = record.mount(root, { trees: [treeOf("BS.CYOPR")] });
    expect(root.querySelectorAll(".group")).toHaveLength(everyKind.length);
    expect(root.textContent).toContain("BS.CYOPR");
    view.destroy();
    expect(root.children).toHaveLength(0);
  });

  test("shows a rule-based group as advisory rather than hiding it", () => {
    record.mount(root, { trees: [treeOf("BS.CYOPR")] });
    expect(root.textContent).toContain("One lab from the biological sciences");
    expect(root.textContent).toContain("no course list");
  });

  test("carries completion on the dot and planning on a tag", () => {
    record.mount(root, { trees: [treeOf("BS.CYOPR")] });
    expect(root.querySelector(".dot.Completed")).toBeTruthy();
    expect(root.querySelector(".dot.NotStarted")).toBeTruthy();
    expect(root.textContent).toContain("on your plan");
  });

  test("renders applied credits with their grade", () => {
    record.mount(root, { trees: [treeOf("BS.CYOPR")] });
    expect(root.textContent).toContain("done: BTGE-1725 A");
  });

  test("opens on what is unfinished", () => {
    // Six collapsed rows make a student click six times to learn they have
    // no gaps. A record is read for its gaps.
    record.mount(root, { trees: [treeOf("BS.CYOPR")] });
    const top = root.querySelector("details") as unknown as HTMLDetailsElement;
    expect(top.open).toBe(true);
  });

  test("says where the catalog puts you, and how far the next rung is", () => {
    record.mount(root, { trees: [treeOf("BS.CYOPR")] });
    expect(root.textContent).toMatch(/freshman|sophomore|junior|senior/);
    expect(root.textContent).toContain("credits to");
  });
});

/*
 * The semester view: one term, on the clock.
 *
 * These assert the three things the mode is for — the week is drawn before
 * anything is picked, a course holds one section, and choosing a seat tells
 * the plan which term the course is in — plus the gating the old builder had.
 */
/*
 * The semester view: the plan's term, laid out on the clock.
 *
 * What the mode promises is that the week arrives already arranged — one
 * section per planned course, nothing overlapping, nothing you cannot get
 * into — and that anything the student pins is kept while the rest moves
 * around it. Each test here is one of those promises.
 */
/*
 * The semester view: the plan's term, laid out on the clock.
 *
 * The mode promises three things. The week arrives already arranged — one
 * section per planned course, nothing overlapping, nothing you cannot get
 * into. The list beside it is one line per course, not a timetable written
 * out in prose. And changing it works the way the plan tab works: offer a
 * course up to the week, and every section it could sit in becomes somewhere
 * to put it.
 */
describe("semester view", () => {
  /** The first term a plan may use, so these never go stale with the year. */
  const TERM = termCodeOf(nextPlannableTerm(new Date()));
  const SLOT = shortTerm(TERM);

  let next = 0;

  /** A listing entry, meeting on the days and at the hour asked for. */
  const sectionOf = (over: Record<string, unknown> = {}, meets = "M, W", hour = "9:00 AM") =>
    ({
      Id: `s${next++}`,
      CourseId: "1",
      CourseName: "CS-1210",
      Number: "01",
      Title: "Intro",
      Synonym: "40123",
      TermId: TERM,
      MinimumCredits: 3,
      MaximumCredits: null,
      Capacity: 30,
      Enrolled: 20,
      Available: 10,
      Waitlisted: 0,
      AvailabilityStatus: "Open",
      IsNonStandardDates: false,
      StartDate: "2027-01-12T00:00:00-05:00",
      EndDate: "2027-04-30T00:00:00-04:00",
      FacultyDisplay: ["Dr Who"],
      Meetings: [],
      FormattedMeetingTimes: [
        {
          DaysOfWeekDisplay: meets,
          StartTimeDisplay: hour,
          EndTimeDisplay: hour.replace(":00", ":50"),
          BuildingDisplay: "ENS",
          Room: "234",
        },
      ],
      ...over,
    }) as unknown;

  /** The same section as Colleague really sends it: UTC, no display strings. */
  const inUtc = () =>
    sectionOf({
      FormattedMeetingTimes: [],
      Meetings: [
        {
          Days: [1, 3],
          // 14:00Z is 9am on campus, which is the whole point of the test.
          StartTime: "2027-01-12T14:00:00+00:00",
          EndTime: "2027-01-12T14:50:00+00:00",
          StartDate: "2027-01-12T00:00:00-05:00",
          EndDate: "2027-04-30T00:00:00-04:00",
          Room: "234",
          Frequency: "W",
          IsOnline: false,
          InstructionalMethodCode: "LEC",
        },
      ],
    });

  /** Take-all groups, so the projection actually owes these courses. */
  const treeNeeding = (courses: { id: string; subject: string; number: string }[]) => {
    const raw = program(
      "BS.CYOPR",
      courses.map((c) => group({ Courses: [course(c.id, c.subject, c.number)] })),
    );
    raw.Program.Requirements[0]!.Subrequirements[0]!.MinGroups = null;
    return normalize(raw);
  };

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

  /** Two courses with no requisites, so the plan puts both in the first term. */
  const PAIR = [
    { Id: "1", SubjectCode: "CS", Number: "1210", Title: "Intro", MinimumCredits: 3 },
    { Id: "9", SubjectCode: "MATH", Number: "1710", Title: "Calc", MinimumCredits: 4 },
  ];
  const pairTree = () => [
    treeNeeding([
      { id: "1", subject: "CS", number: "1210" },
      { id: "9", subject: "MATH", number: "1710" },
    ]),
  ];

  const ctxOf = (
    sections: unknown[],
    courses: unknown[] = CHAIN,
    trees = [
      treeNeeding([
        { id: "1", subject: "CS", number: "1210" },
        { id: "2", subject: "CS", number: "2210" },
      ]),
    ],
    over: Partial<Ctx> = {},
  ): Ctx =>
    ({
      trees,
      sections: { term: TERM, fetchedAt: "2027-01-02T00:00:00.000Z", sections, courses },
      ...over,
    }) as unknown as Ctx;

  const cards = () => Array.from(root.querySelectorAll("details.course")) as HTMLDetailsElement[];
  const codes = () => cards().map((c) => c.dataset.code);
  const cardFor = (code: string) =>
    root.querySelector(`details.course[data-code="${code}"]`) as HTMLDetailsElement;
  const headFor = (code: string) => cardFor(code).querySelector("summary") as HTMLElement;
  const slotOf = (code: string) => cardFor(code).querySelector(".slot")?.textContent ?? "";
  /** The radio group: one row per section, after the "whichever fits" row. */
  const options = (code: string) =>
    Array.from(cardFor(code).querySelectorAll(".option:not(.auto)")) as HTMLElement[];
  const radios = (code: string) =>
    options(code).map((o) => o.querySelector("input") as HTMLInputElement);
  const autoOf = (code: string) =>
    cardFor(code).querySelector(".option.auto input") as HTMLInputElement;
  const blocksOf = (kind: string) =>
    Array.from(root.querySelectorAll(`.block.${kind}`)) as HTMLElement[];
  const titlesOf = (kind: string) => blocksOf(kind).map((b) => b.getAttribute("title") ?? "");
  const moves = () => JSON.parse(localStorage.getItem("cedarville:moves") ?? "{}");
  const fire = (node: Element, type: string) =>
    node.dispatchEvent(new window.Event(type, { bubbles: true }) as unknown as Event);

  beforeEach(() => {
    localStorage.clear();
    next = 0;
  });

  test("asks for a term before it can lay anything out", () => {
    semester.mount(root, { trees: [treeOf("BS.CYOPR")] });
    expect(root.textContent).toContain("pick a term");
  });

  test("asks for a capture before it plans a semester", () => {
    semester.mount(root, { trees: [], sections: { term: TERM, fetchedAt: "", sections: [] } });
    expect(root.textContent).toContain("capture your requirements");
  });

  // The list is the plan's term, not a catalogue of everything a requirement
  // might one day accept.
  test("lists the courses the plan put in this term and no others", () => {
    semester.mount(
      root,
      ctxOf([
        inUtc(),
        sectionOf({ CourseId: "2", CourseName: "CS-2210", Title: "Data Structures" }),
      ]),
    );

    // CS-2210 waits on CS-1210, so the plan holds it for a later term.
    expect(codes()).toEqual(["CS-1210"]);
    expect(root.querySelector(".term-bar h2")?.textContent).toContain(SLOT);
    expect(root.textContent).toContain("cr planned");
  });

  // And it arrives arranged, which is the other half.
  /*
   * Everything on this screen is only as true as the crawl behind it, and
   * nothing else on the page said when that was: a section cancelled this
   * morning still draws, and the only tell was a seat count a student had no
   * reason to distrust.
   */
  test("says how long ago the timetable was read", () => {
    const hourAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const ctx = ctxOf([sectionOf()]) as unknown as { sections: { fetchedAt: string } };
    ctx.sections.fetchedAt = hourAgo;
    semester.mount(root, ctx as unknown as Ctx);

    const age = root.querySelector(".term-bar .tag") as HTMLElement;
    expect(age.textContent).toBe("read 2 hours ago");
    expect(age.className).toContain("rule");
    expect(age.title).toContain("re-crawls it whatever its age");
  });

  test("and marks it when it is old enough to be worth refreshing", () => {
    const ctx = ctxOf([sectionOf()]) as unknown as { sections: { fetchedAt: string } };
    ctx.sections.fetchedAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
    semester.mount(root, ctx as unknown as Ctx);

    const age = root.querySelector(".term-bar .tag") as HTMLElement;
    expect(age.textContent).toBe("read 3 days ago");
    expect(age.className).toContain("bad");
    expect(age.title).toContain("worth refreshing");
  });

  test("lays the term out without being asked", () => {
    semester.mount(root, ctxOf([inUtc()]));

    expect(blocksOf("suggested")).toHaveLength(2); // Monday and Wednesday
    expect(root.textContent).toContain("1 of 1 courses placed");
    expect(root.textContent).toContain("3 cr of sections");
    // One line, with the section it settled on spelled out and nothing else.
    expect(slotOf("CS-1210")).toBe("01 · MonWed 9:00am–9:50am");
  });

  test("a course is an accordion, shut until there is a choice to make", () => {
    semester.mount(root, ctxOf([sectionOf(), sectionOf({ Number: "02" }, "M, W", "11:00 AM")]));
    const card = cardFor("CS-1210");
    expect(card.open).toBe(false);
    // The detail is inside, ready to be opened rather than spread on the page.
    expect(options("CS-1210")).toHaveLength(2);
    expect(card.textContent).toContain("Dr Who");
    expect(card.textContent).toContain("ENS 234");
  });

  test("opens itself when the choice has gone wrong", () => {
    // No section at all is the case a student has to act on.
    semester.mount(root, ctxOf([sectionOf()], PAIR, pairTree()));
    expect(cardFor("MATH-1710").open).toBe(true);
    expect(cardFor("CS-1210").open).toBe(false);
  });

  test("chooses sections that do not collide", () => {
    // Both courses teach at nine on Monday; only one pairing works.
    semester.mount(
      root,
      ctxOf(
        [
          sectionOf(),
          sectionOf({ Number: "02" }, "M, W", "11:00 AM"),
          sectionOf({ CourseId: "9", CourseName: "MATH-1710", Title: "Calc", Number: "01" }),
        ],
        PAIR,
        pairTree(),
      ),
    );

    expect(root.querySelector(".clash")).toBeFalsy();
    expect(root.textContent).toContain("2 of 2 courses placed");
    expect(slotOf("CS-1210")).toContain("02");
    expect(slotOf("MATH-1710")).toContain("01");
  });

  /*
   * The gesture the plan tab taught: offer the thing up, and the places it
   * could go appear.
   */
  /*
   * The week is next to the list so that a row of times can be seen rather
   * than read. Hovering one draws it where it would fall.
   */
  test("hovering an option draws it on the week", () => {
    semester.mount(root, ctxOf([sectionOf(), sectionOf({ Number: "02" }, "M, W", "11:00 AM")]));
    expect(blocksOf("ghost")).toHaveLength(0);

    fire(options("CS-1210")[1]!, "mouseenter");
    expect(titlesOf("ghost").every((t) => t.includes("CS-1210 02"))).toBe(true);
    expect(blocksOf("ghost")).toHaveLength(2); // Monday and Wednesday

    fire(options("CS-1210")[1]!, "mouseleave");
    // Still the course's own sections, because the pointer is in its card.
    expect(titlesOf("ghost").every((t) => t.includes("CS-1210 02"))).toBe(true);
    fire(headFor("CS-1210"), "mouseleave");
    expect(blocksOf("ghost")).toHaveLength(0);
  });

  test("a hover says when taking it would cost something else its place", () => {
    semester.mount(
      root,
      ctxOf(
        [
          sectionOf(),
          sectionOf({ Number: "02" }, "M, W", "11:00 AM"),
          sectionOf({ CourseId: "9", CourseName: "MATH-1710", Title: "Calc", Number: "01" }),
        ],
        PAIR,
        pairTree(),
      ),
    );
    // MATH-1710 is at nine, so CS-1210 01 would collide with it.
    fire(options("CS-1210")[0]!, "mouseenter");
    expect(blocksOf("ghost").every((b) => b.classList.contains("clash"))).toBe(true);
    expect(options("CS-1210")[0]!.title).toContain("Overlaps MATH-1710");
  });

  test("the radio group chooses, and its first row hands the choice back", () => {
    semester.mount(root, ctxOf([sectionOf(), sectionOf({ Number: "02" }, "M, W", "11:00 AM")]));
    // Nothing taken yet, so the arranger holds the choice.
    expect(autoOf("CS-1210").checked).toBe(true);
    expect(radios("CS-1210").some((r) => r.checked)).toBe(false);
    expect(options("CS-1210")[0]!.querySelector(".mark")?.textContent).toBe("chosen for you");

    radios("CS-1210")[1]!.click();
    expect(radios("CS-1210")[1]!.checked).toBe(true);
    expect(autoOf("CS-1210").checked).toBe(false);
    expect(options("CS-1210")[1]!.querySelector(".mark")?.textContent).toBe("yours");
    expect(titlesOf("pinned").every((t) => t.includes("CS-1210 02"))).toBe(true);

    autoOf("CS-1210").click();
    expect(autoOf("CS-1210").checked).toBe(true);
    expect(blocksOf("pinned")).toHaveLength(0);
    expect(blocksOf("suggested")).toHaveLength(2);
  });

  test("clicking a block takes it, and clicking it again hands it back", () => {
    semester.mount(root, ctxOf([sectionOf(), sectionOf({ Number: "02" }, "M, W", "11:00 AM")]));
    blocksOf("suggested")[0]!.click();
    expect(blocksOf("pinned")).toHaveLength(2);
    expect(cardFor("CS-1210").classList.contains("mine")).toBe(true);

    blocksOf("pinned")[0]!.click();
    expect(blocksOf("pinned")).toHaveLength(0);
    expect(blocksOf("suggested")).toHaveLength(2);
  });

  test("a course holds one section, so taking a second lets the first go", () => {
    semester.mount(root, ctxOf([sectionOf(), sectionOf({ Number: "02" }, "M, W", "11:00 AM")]));
    radios("CS-1210")[0]!.click();
    expect(titlesOf("pinned").every((t) => t.includes("CS-1210 01"))).toBe(true);

    radios("CS-1210")[1]!.click();
    expect(titlesOf("pinned").every((t) => t.includes("CS-1210 02"))).toBe(true);
    expect(blocksOf("pinned")).toHaveLength(2);
    expect(options("CS-1210")[0]!.classList.contains("mine")).toBe(false);
    expect(options("CS-1210")[1]!.classList.contains("mine")).toBe(true);
  });

  test("a section kept is a section the rest of the week works around", () => {
    semester.mount(
      root,
      ctxOf(
        [
          sectionOf(),
          sectionOf({ Number: "02" }, "M, W", "11:00 AM"),
          sectionOf({ CourseId: "9", CourseName: "MATH-1710", Title: "Calc", Number: "01" }),
        ],
        PAIR,
        pairTree(),
      ),
    );
    // MATH-1710 only teaches at nine, which is where CS-1210 01 is.
    expect(slotOf("CS-1210")).toContain("02");

    radios("CS-1210")[0]!.click();
    expect(slotOf("CS-1210")).toContain("01");
    // Nothing is left for MATH-1710, and the view says so rather than
    // quietly dropping it.
    expect(slotOf("MATH-1710")).toBe("nowhere it fits");
    expect(root.querySelector(".clash")?.textContent).toContain("MATH-1710");
    expect(root.textContent).toContain("clashes with a section you pinned");
  });

  test("starting over hands every section back to the arranger", () => {
    semester.mount(root, ctxOf([sectionOf(), sectionOf({ Number: "02" }, "M, W", "11:00 AM")]));
    radios("CS-1210")[1]!.click();
    const over = root.querySelector(".regenerate") as HTMLButtonElement;
    expect(over.hidden).toBe(false);
    expect(over.textContent).toContain("1 chosen");

    over.click();
    expect(blocksOf("pinned")).toHaveLength(0);
    expect((root.querySelector(".regenerate") as HTMLButtonElement).hidden).toBe(true);
  });

  test("what to aim for picks a different week", () => {
    const choices = [
      sectionOf({ Number: "early" }, "M, W", "8:00 AM"),
      sectionOf({ Number: "late" }, "M, W", "4:00 PM"),
    ];
    semester.mount(root, ctxOf(choices));
    const aim = Array.from(root.querySelectorAll("select"))[1] as HTMLSelectElement;

    aim.value = "early";
    fire(aim, "change");
    expect(slotOf("CS-1210")).toContain("early");

    aim.value = "late";
    fire(aim, "change");
    expect(slotOf("CS-1210")).toContain("late");
  });

  test("prefers a section with seats left in it", () => {
    semester.mount(
      root,
      ctxOf([
        sectionOf({ Number: "full", Available: 0, Enrolled: 30, AvailabilityStatus: "Waitlisted" }),
        sectionOf({ Number: "open" }, "M, W", "11:00 AM"),
      ]),
    );
    expect(slotOf("CS-1210")).toContain("open");
    expect(cardFor("CS-1210").querySelector(".tag.seats.open")).toBeTruthy();
  });

  // Moving between terms is the shell's job, because the shell owns the one
  // copy of the catalog. The view only asks.
  test("offers the plan's other terms and asks the shell for one", () => {
    const asked: string[] = [];
    semester.mount(
      root,
      ctxOf([sectionOf()], CHAIN, undefined, { loadTerm: (t: string) => asked.push(t) }),
    );

    const terms = root.querySelector("select") as HTMLSelectElement;
    const offered = Array.from(terms.options).map((o) => o.value);
    expect(terms.value).toBe(TERM);
    expect(offered.length).toBeGreaterThan(1);

    const other = offered.find((code) => code !== TERM)!;
    terms.value = other;
    fire(terms, "change");
    expect(asked).toEqual([other]);
  });

  test("offers only terms the registrar has actually published", () => {
    const [, second] = termsFrom(nextPlannableTerm(new Date()), 2, { summers: SUMMERS });
    const soon = termCodeOf(second!);
    semester.mount(
      root,
      ctxOf([sectionOf()], CHAIN, undefined, { loadTerm: () => {}, terms: [TERM, soon] }),
    );

    const terms = root.querySelector("select") as HTMLSelectElement;
    expect(Array.from(terms.options).map((o) => o.value)).toEqual([TERM, soon]);
  });

  test("with nowhere else to go, the term control stays shut", () => {
    semester.mount(
      root,
      ctxOf([sectionOf()], CHAIN, undefined, { loadTerm: () => {}, terms: [TERM] }),
    );
    expect((root.querySelector("select") as HTMLSelectElement).disabled).toBe(true);
  });

  /*
   * The geometry, measured rather than eyeballed. A grid whose blocks are a
   * row out is not visibly broken, it is quietly wrong, and the only way to
   * know is to do the arithmetic: the day opens at eight, a row is half an
   * hour of twenty pixels, and the weekday heading takes the first 26.
   */
  test("a nine o'clock class lands two rows below the eight o'clock line", () => {
    semester.mount(root, ctxOf([sectionOf()]));
    const block = blocksOf("suggested")[0]!;
    expect(Number.parseFloat(block.style.top)).toBeCloseTo(66, 3);
    // Fifty minutes, which is five-sixths of two rows.
    expect(Number.parseFloat(block.style.height)).toBeCloseTo(33.333, 2);
  });

  test("two classes at the same hour sit side by side rather than on top", () => {
    // Keeping both halves of a clash is allowed: it is the student's call,
    // and the week has to show them what they have done.
    semester.mount(
      root,
      ctxOf(
        [sectionOf(), sectionOf({ CourseId: "9", CourseName: "MATH-1710", Title: "Calc" })],
        PAIR,
        pairTree(),
      ),
    );
    // One section each, both at nine on a Monday. Taking the second is the
    // student overruling the arranger, which it is allowed to do.
    radios("CS-1210")[0]!.click();
    radios("MATH-1710")[0]!.click();

    const monday = root.querySelectorAll(".day")[0] as HTMLElement;
    const sideBySide = Array.from(monday.querySelectorAll(".block")) as HTMLElement[];
    expect(sideBySide).toHaveLength(2);
    expect(sideBySide.map((b) => b.style.width)).toEqual(["50%", "50%"]);
    expect(sideBySide.map((b) => b.style.left)).toEqual(["0%", "50%"]);
    // Two courses, each meeting Monday and Wednesday.
    expect(blocksOf("clash")).toHaveLength(4);
    expect(root.querySelector(".clash")?.textContent).toContain("overlap Mon");
  });

  test("a course the plan wants and the term does not teach says so", () => {
    semester.mount(root, ctxOf([sectionOf()], PAIR, pairTree()));
    expect(root.textContent).toContain(`not taught in ${TERM}`);
    expect(root.textContent).toContain("no section is offered this term");
  });

  // A gate is only worth the words when it is shut.
  test("a course you are ready for says nothing about it", () => {
    semester.mount(root, ctxOf([sectionOf()]));
    expect(root.querySelector(".gate")).toBeFalsy();
  });

  /*
   * The plan only ever places a course it is ready for, so a blocked one in a
   * term means the student put it there — which is allowed, and has to be
   * said out loud rather than quietly corrected.
   */
  test("a course pinned into a term it is not ready for says what it needs", () => {
    localStorage.setItem("cedarville:moves", JSON.stringify({ "CS-2210": SLOT }));
    semester.mount(
      root,
      ctxOf([
        sectionOf(),
        sectionOf({ CourseId: "2", CourseName: "CS-2210", Title: "Data Structures" }, "T, R"),
      ]),
    );

    expect(cardFor("CS-2210").querySelector(".gate.blocked")?.textContent).toBe("needs CS-1210");

    // And the ⤺ hands it back to the projection.
    const back = cardFor("CS-2210").querySelector(".release") as HTMLButtonElement;
    expect(back.textContent).toBe("⤺");
    back.click();
    expect(moves()["CS-2210"]).toBeUndefined();
  });

  test("an unparseable condition reads as check, not as ready", () => {
    localStorage.setItem("cedarville:moves", JSON.stringify({ "CS-1210": SLOT }));
    const courses = [
      {
        Id: "1",
        SubjectCode: "CS",
        Number: "1210",
        Title: "Intro",
        MinimumCredits: 3,
        CourseRequisites: [
          {
            DisplayText: "Permission of the instructor.",
            DisplayTextExtension: "- Must be completed prior to taking this course.",
            IsRequired: true,
          },
        ],
      },
    ];
    semester.mount(
      root,
      ctxOf([sectionOf()], courses, [treeNeeding([{ id: "1", subject: "CS", number: "1210" }])]),
    );

    const gate = cardFor("CS-1210").querySelector(".gate.unknown") as HTMLElement;
    expect(gate.textContent).toBe("check");
    expect(gate.title).toContain("Permission of the instructor");
  });

  /*
   * A prerequisite the plan satisfies in an earlier term is not a blocker in
   * this one. Judging a future term against today's transcript alone reported
   * half a degree as blocked by courses the plan already had in hand.
   */
  test("a prerequisite met earlier in the plan is not a blocker", () => {
    const [, , third] = termsFrom(nextPlannableTerm(new Date()), 3, { summers: SUMMERS });
    const thirdTerm = termCodeOf(third!);

    const chain = [
      ...CHAIN,
      {
        Id: "3",
        SubjectCode: "CS",
        Number: "3310",
        Title: "Algorithms",
        MinimumCredits: 3,
        CourseRequisites: [
          {
            DisplayText: "Take CS-2210",
            DisplayTextExtension: "- Must be completed prior to taking this course.",
            IsRequired: true,
          },
        ],
      },
    ];
    const trees = [
      treeNeeding([
        { id: "1", subject: "CS", number: "1210" },
        { id: "2", subject: "CS", number: "2210" },
        { id: "3", subject: "CS", number: "3310" },
      ]),
    ];
    const ctx = ctxOf(
      [sectionOf({ CourseId: "3", CourseName: "CS-3310", Title: "Algorithms" })],
      chain,
      trees,
    ) as unknown as { sections: { term: string } };
    ctx.sections.term = thirdTerm;
    semester.mount(root, ctx as unknown as Ctx);

    expect(codes()).toEqual(["CS-3310"]);
    expect(root.querySelector(".gate")).toBeFalsy();
  });

  test("a planned course can be dropped without leaving the term", () => {
    semester.mount(root, ctxOf([sectionOf()]));
    const drop = cardFor("CS-1210").querySelector(".release") as HTMLButtonElement;
    expect(drop.textContent).toBe("×");
    drop.click();

    expect(moves()["CS-1210"]).toBe("out");
    // And the semester does not keep a list of what the plan is not doing.
    expect(root.textContent).not.toContain("out of your plan");
  });

  test("pins are kept per term", () => {
    const first = semester.mount(root, ctxOf([sectionOf()]));
    blocksOf("suggested")[0]!.click();
    expect(blocksOf("pinned")).toHaveLength(2);
    first.destroy();

    // Same section id, a different term: the pin does not follow it over.
    const other = ctxOf([sectionOf()]) as unknown as { sections: { term: string } };
    other.sections.term = "1999FA";
    semester.mount(root, other as unknown as Ctx);
    expect(blocksOf("pinned")).toHaveLength(0);
  });

  test("a pin survives a remount", () => {
    const first = semester.mount(
      root,
      ctxOf([sectionOf(), sectionOf({ Number: "02" }, "M, W", "11:00 AM")]),
    );
    radios("CS-1210")[1]!.click();
    first.destroy();

    // The same catalog, so the ids line up the way a reload would.
    next = 0;
    semester.mount(root, ctxOf([sectionOf(), sectionOf({ Number: "02" }, "M, W", "11:00 AM")]));
    expect(slotOf("CS-1210")).toContain("02");
    expect(radios("CS-1210")[1]!.checked).toBe(true);
  });

  test("destroy clears the outlet", () => {
    semester.mount(root, ctxOf([sectionOf()])).destroy();
    expect(root.children).toHaveLength(0);
  });

  test("destroy detaches subscriptions so a stale view cannot repaint", () => {
    const view = semester.mount(root, ctxOf([sectionOf()]));
    const block = blocksOf("suggested")[0]!;
    view.destroy();

    // The node is detached; clicking it must not throw or resurrect anything.
    expect(() => block.click()).not.toThrow();
    expect(root.children).toHaveLength(0);
  });
});

describe("plan view", () => {
  // The tab opens as a graph. These exercise the list rendering, which is the
  // same projection with the terms written out.
  const asList = () => localStorage.setItem("cedarville:plan-shape", JSON.stringify("list"));

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

  test("projects terms", () => {
    asList();
    plan.mount(root, ctxWith(CHAIN));
    expect(root.querySelectorAll(".term").length).toBeGreaterThan(0);
    expect(root.textContent).toContain("finishes");
  });

  // A chain of prerequisites cannot be compressed by raising the credit cap.
  test("the credit slider reprojects but cannot beat the chain", () => {
    asList();
    plan.mount(root, ctxWith(CHAIN));
    const terms = () => root.querySelectorAll(".term:not(.unplaced)").length;
    const before = terms();

    const slider = root.querySelector("input[type=range]") as HTMLInputElement;
    slider.value = "18.5";
    // A range has no click() equivalent, and happy-dom's Event is structurally
    // different from the DOM one, so the cast is the honest way through.
    slider.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    expect(terms()).toBeGreaterThanOrEqual(before);
    // The knobs are shared with the build view, and so is the storage.
    localStorage.removeItem("cedarville:load");
  });

  test("plans one fewer summer when asked for one fewer", () => {
    asList();
    plan.mount(root, ctxWith(CHAIN));
    const summers = () => root.querySelectorAll(".term.summer").length;
    expect(summers()).toBeGreaterThan(0);

    const [, count] = Array.from(root.querySelectorAll("input[type=range]")) as HTMLInputElement[];
    count!.value = "0";
    count!.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    expect(summers()).toBe(0);
    localStorage.removeItem("cedarville:load");
  });

  test("destroy clears the outlet", () => {
    plan.mount(root, ctxWith(CHAIN)).destroy();
    expect(root.children).toHaveLength(0);
  });
});

describe("plan view — arguing with the plan", () => {
  /*
   * The projection is a first draft, so these exercise the second: a course
   * dragged into another term, one added that the degree never asked for, one
   * dropped, and the button that throws the lot away.
   */
  const asList = () => localStorage.setItem("cedarville:plan-shape", JSON.stringify("list"));

  const planTree = () => {
    const raw = program("BS.CYOPR", [
      group({ Courses: [course("1", "CS", "1210")] }),
      group({ Courses: [course("2", "CS", "2210")] }),
    ]);
    raw.Program.Requirements[0]!.Subrequirements[0]!.MinGroups = null;
    return normalize(raw);
  };

  const COURSES = [
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
    { Id: "3", SubjectCode: "CS", Number: "3310", Title: "Algorithms", MinimumCredits: 3 },
  ];

  const ctx = () =>
    ({
      trees: [planTree()],
      sections: { term: "2026FA", fetchedAt: "", sections: [], courses: COURSES },
    }) as unknown as Ctx;

  const fire = (node: Element, type: string) =>
    node.dispatchEvent(new window.Event(type, { bubbles: true }) as unknown as Event);

  const terms = () => Array.from(root.querySelectorAll(".term[data-slot]"));
  const codesIn = (box: Element) =>
    Array.from(box.querySelectorAll(".plan-course b")).map((b) => b.textContent);

  beforeEach(() => {
    localStorage.removeItem("cedarville:moves");
    asList();
  });

  test("a course dragged into a later term stays there", () => {
    plan.mount(root, ctx());
    const first = terms()[0]!;
    const row = first.querySelector(".plan-course") as HTMLElement;
    const code = row.dataset.code!;

    fire(row, "dragstart");
    // Every term says whether it would take the course, which is the whole
    // reason the drag is worth having over a dropdown.
    expect(root.querySelectorAll(".term.drop-ok, .term.drop-bad").length).toBeGreaterThan(0);

    const target = terms().at(-1)!;
    const slot = (target as HTMLElement).dataset.slot!;
    fire(target, "drop");

    const moved = terms().find((t) => (t as HTMLElement).dataset.slot === slot)!;
    expect(codesIn(moved)).toContain(code);
    expect(moved.querySelector(".plan-course.moved")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("cedarville:moves")!)[code]).toBe(slot);
  });

  test("a course gated by credits says so in the list too", () => {
    localStorage.setItem("cedarville:moves", JSON.stringify({}));
    const gated = [
      ...COURSES,
      {
        Id: "9",
        SubjectCode: "EGGN",
        Number: "2010",
        Title: "Engineering Practice",
        MinimumCredits: 1,
        Description: "Prerequisite: sophomore status in engineering.",
      },
    ];
    const tree = () => {
      const raw = program("BS.CYOPR", [group({ Courses: [course("9", "EGGN", "2010")] })]);
      raw.Program.Requirements[0]!.Subrequirements[0]!.MinGroups = null;
      return normalize(raw);
    };
    plan.mount(root, {
      trees: [tree()],
      sections: { term: "2026FA", fetchedAt: "", sections: [], courses: gated },
    } as unknown as Ctx);

    const row = Array.from(root.querySelectorAll(".plan-course")).find((r) =>
      r.textContent?.includes("EGGN-2010"),
    );
    expect(row?.textContent).toContain("sophomore standing");
  });

  test("a term reads as credits against its cap", () => {
    plan.mount(root, ctx());
    expect(terms()[0]!.querySelector("h3 .cr")?.textContent).toMatch(/^\d+(\.\d+)? \/ \d+/);
  });

  // A native tooltip never shows during a drag, so the term has to say it.
  test("each term says what taking the course would do to it", () => {
    plan.mount(root, ctx());
    const row = root.querySelector(".plan-course") as HTMLElement;
    fire(row, "dragstart");

    const notes = Array.from(root.querySelectorAll(".term h3 .note")).map((n) => n.textContent);
    expect(notes.filter(Boolean).length).toBe(terms().length);
    expect(notes.join(" ")).toMatch(/cr|finish|taught|needs/);

    fire(row, "dragend");
    expect(Array.from(root.querySelectorAll(".term h3 .note")).map((n) => n.textContent)).toEqual(
      notes.map(() => ""),
    );
  });

  test("a move that breaks something says so under the course", () => {
    // CS-2210 sits behind CS-1210, so pulling it into the opening term is a
    // real clash. The plan makes the move anyway, and then explains itself.
    plan.mount(root, ctx());
    const opening = (terms()[0] as HTMLElement).dataset.slot!;
    root.replaceChildren();
    localStorage.setItem("cedarville:moves", JSON.stringify({ "CS-2210": opening }));
    plan.mount(root, ctx());

    expect(root.querySelector(".plan-course.why")?.textContent).toContain("CS-1210");
    expect(root.querySelector(".tag.bad")?.textContent).toBe("clashes");
  });

  test("a move survives a remount, because a plan is not a session", () => {
    plan.mount(root, ctx());
    const row = root.querySelector(".plan-course") as HTMLElement;
    const code = row.dataset.code!;
    fire(row, "dragstart");
    fire(terms().at(-1)!, "drop");

    root.replaceChildren();
    plan.mount(root, ctx());
    expect(root.querySelector(`.plan-course.moved[data-code="${code}"]`)).toBeTruthy();
  });

  test("dropping a course takes it out of the plan and offers it back", () => {
    plan.mount(root, ctx());
    const row = root.querySelector(".plan-course") as HTMLElement;
    const code = row.dataset.code!;
    (row.querySelectorAll("button.release")[0] as HTMLElement).click();

    const dropped = root.querySelector(".term.dropped")!;
    expect(dropped.textContent).toContain(code);
    expect(terms().flatMap(codesIn)).not.toContain(code);

    (dropped.querySelector("button.release") as HTMLElement).click();
    expect(root.querySelector(".term.dropped")).toBeNull();
    expect(terms().flatMap(codesIn)).toContain(code);
  });

  test("adds a course the degree never asked for", () => {
    plan.mount(root, ctx());
    const first = terms()[0]!;
    (first.querySelector("button.add") as HTMLElement).click();
    const input = first.querySelector("input.add-course") as HTMLInputElement;
    input.value = "cs-3310";
    fire(input, "change");

    expect(terms().flatMap(codesIn)).toContain("CS-3310");
  });

  /*
   * "Honors Integrative Seminars (4 credit hours)" draws on a pool whose
   * seminar is worth two, so the only way to meet it is to sit the same course
   * twice. A set of course codes cannot say that; a sitting suffix can.
   */
  test("adding a course already on the plan makes it a second sitting", () => {
    plan.mount(root, ctx());
    const first = terms()[0]!;
    (first.querySelector("button.add") as HTMLElement).click();
    const input = first.querySelector("input.add-course") as HTMLInputElement;
    input.value = "CS-1210";
    fire(input, "change");

    expect(JSON.parse(localStorage.getItem("cedarville:moves")!)["CS-1210#2"]).toBeTruthy();
    // Two of them on the plan, and the suffix is bookkeeping rather than a
    // course code the registrar would recognise.
    const codes = terms().flatMap(codesIn);
    expect(codes.filter((c) => c === "CS-1210")).toHaveLength(2);
    expect(root.textContent).toContain("sitting 2");
    expect(root.textContent).not.toContain("#2");
  });

  test("a second sitting waits on the same prerequisites the first did", () => {
    // CS-2210 sits behind CS-1210, so a second CS-2210 cannot land in the
    // opening term either.
    plan.mount(root, ctx());
    const opening = (terms()[0] as HTMLElement).dataset.slot!;
    root.replaceChildren();
    localStorage.setItem("cedarville:moves", JSON.stringify({ "CS-2210#2": opening }));
    plan.mount(root, ctx());
    expect(root.querySelector(".plan-course.why")?.textContent).toContain("CS-1210");
  });

  test("keeps a course nothing in the catalog lists out of the plan", () => {
    plan.mount(root, ctx());
    const first = terms()[0]!;
    (first.querySelector("button.add") as HTMLElement).click();
    const input = first.querySelector("input.add-course") as HTMLInputElement;
    input.value = "ZZ-9999";
    fire(input, "change");

    expect(root.textContent).not.toContain("ZZ-9999");
  });

  test("regenerate drops every move and hides itself", () => {
    plan.mount(root, ctx());
    const row = root.querySelector(".plan-course") as HTMLElement;
    fire(row, "dragstart");
    fire(terms().at(-1)!, "drop");

    const button = root.querySelector("button.regenerate") as HTMLButtonElement;
    expect(button.hidden).toBe(false);
    expect(button.textContent).toContain("1 move");
    button.click();

    expect(root.querySelector(".plan-course.moved")).toBeNull();
    expect(button.hidden).toBe(true);
    expect(localStorage.getItem("cedarville:moves")).toBe("{}");
  });
});

describe("build view", () => {
  // Each program carries one group, because the shared harness lets a
  // subrequirement pick only one of them.
  const required: RawGroup[] = [
    group({ Courses: [course("1", "CS", "1210")], DisplayText: "Take this" }),
  ];
  const elective: RawGroup[] = [
    group({
      Id: "elective",
      DisplayText: "One computing elective",
      FromCourses: [course("1", "CS", "1210"), course("9", "ART", "1100")],
      MinCredits: 3,
    }),
  ];

  test("asks for a capture before it can rank anything", () => {
    build.mount(root, { trees: [] });
    expect(root.textContent).toContain("capture your requirements first");
  });

  /** One enrolment covering a major and a minor, as BS.CYOPR really does. */
  const cyops = normalize(
    program("BS.CYOPR", required, { Majors: ["Cyber Operations"], Minors: ["Honors Program"] }),
  );

  test("names every major and minor an enrolment covers", () => {
    // The program code hides them: a student with an honors minor sees only
    // "BS.CYOPR" and asks, reasonably, where their minor went.
    build.mount(root, { trees: [cyops], enrolled: ["BS.CYOPR"] });
    const chips = root.querySelector(".chips") as unknown as HTMLElement;
    expect(Array.from(chips.querySelectorAll(".tag")).map((n) => n.textContent)).toEqual([
      "Cyber Operations",
      "Honors Program",
    ]);
    expect(chips.textContent?.match(/enrolled/g)).toHaveLength(1);
  });

  test("falls back to the title when a program names nothing", () => {
    build.mount(root, { trees: [treeOf("BS.CYOPR", required)], enrolled: ["BS.CYOPR"] });
    expect(root.querySelector(".chips .tag")?.textContent).toBe("BS.CYOPR program");
  });

  test("separates a what-if program from a real enrolment", () => {
    // Both come back from Colleague in the same shape; only the capture's own
    // enrolment list can tell them apart.
    build.mount(root, {
      trees: [cyops, treeOf("BS.CMPEG", required)],
      enrolled: ["BS.CYOPR"],
    });
    const chips = root.querySelector(".chips") as unknown as HTMLElement;
    expect(chips.querySelector(".tag.on")?.textContent).toBe("Cyber Operations");
    expect(chips.querySelector(".tag.trying")?.textContent).toContain("BS.CMPEG");
    expect(chips.textContent).toContain("trying");
  });

  test("a what-if program can be dropped, an enrolled one cannot", () => {
    build.mount(root, {
      trees: [treeOf("BS.CYOPR", required), treeOf("BS.CMPEG", required)],
      enrolled: ["BS.CYOPR"],
    });
    const drops = root.querySelectorAll(".tag .drop");
    expect(drops).toHaveLength(1);
    expect((drops[0] as unknown as HTMLElement).title).toContain("BS.CMPEG");
  });

  test("without an enrolment list every captured program is treated as real", () => {
    // Older captures predate the field; calling them all hypothetical would
    // offer to remove a program the student is actually in.
    build.mount(root, { trees: [treeOf("BS.CYOPR", required)] });
    expect(root.querySelectorAll(".tag .drop")).toHaveLength(0);
    expect(root.querySelector(".chips")?.textContent).toContain("enrolled");
  });

  test("puts the course another program already requires at the top", () => {
    build.mount(root, {
      trees: [treeOf("MAJ", required), treeOf("MIN", elective)],
    });
    const codes = Array.from(root.querySelectorAll(".candidate b")).map((n) => n.textContent);
    expect(codes[0]).toBe("CS-1210");
    expect(root.textContent).toContain("already required");
  });

  test("prices the alternative rather than hiding it", () => {
    build.mount(root, { trees: [treeOf("MAJ", required), treeOf("MIN", elective)] });
    const rows = Array.from(root.querySelectorAll(".candidate")).map((n) => n.textContent ?? "");
    expect(rows.find((r) => r.includes("ART-1100"))).toContain("+3 cr");
  });

  test("picking a course marks it and survives a remount", () => {
    const trees = [treeOf("MAJ", required), treeOf("MIN", elective)];
    const view = build.mount(root, { trees });
    const pick = root.querySelector(".candidate .pick") as unknown as HTMLElement;
    pick.click();
    expect(root.querySelectorAll(".candidate.picked").length).toBeGreaterThan(0);
    view.destroy();

    build.mount(root, { trees });
    expect(root.querySelectorAll(".candidate.picked").length).toBeGreaterThan(0);
    localStorage.removeItem("cedarville:pins");
  });

  test("collapses one requirement shared by two programs and names both", () => {
    build.mount(root, { trees: [treeOf("A", elective), treeOf("B", elective)] });
    expect(root.querySelectorAll(".choice:not(.shared-box)")).toHaveLength(1);
    expect(root.textContent).toContain("counts for A + B");
  });

  test("destroys cleanly", () => {
    const view = build.mount(root, { trees: [treeOf("BS.CYOPR", elective)] });
    view.destroy();
    expect(root.children).toHaveLength(0);
  });
});

describe("build view — specializations", () => {
  const track = (over: Partial<RawGroup>) => group(over);
  const withTrack = normalize({
    StudentId: "1",
    Program: {
      Code: "BS.CYOPR",
      Title: "cyber",
      Catalog: "2026",
      Degree: "BS",
      MinimumCredits: 128,
      CompletedCredits: 0,
      InProgressCredits: 0,
      PlannedCredits: 0,
      RequiredRequirementCount: 1,
      CompletedRequirementCount: 0,
      Majors: ["Cyber Operations"],
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
                track({
                  Id: "tech",
                  DisplayText: "Technical electives",
                  FromCourses: [course("1", "CS", "3220")],
                  MinCredits: 3,
                }),
                track({
                  Id: "ai",
                  DisplayText: "Artificial Intelligence Track",
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

  test("shows the track decision rather than deciding it silently", () => {
    build.mount(root, { trees: [withTrack], enrolled: ["BS.CYOPR"] });
    const branch = root.querySelector(".choice.branch") as unknown as HTMLElement;
    expect(branch.textContent).toContain("Technical electives or the AI track");
    expect(branch.textContent).toContain("Artificial Intelligence Track");
    expect(branch.querySelector(".candidate.picked")?.textContent).toContain("Technical electives");
  });

  test("choosing the other track switches to it and offers a way back", () => {
    build.mount(root, { trees: [withTrack], enrolled: ["BS.CYOPR"] });
    const rows = Array.from(root.querySelectorAll(".choice.branch .candidate"));
    const ai = rows.find((r) => r.textContent?.includes("Artificial Intelligence"))!;
    (ai.querySelector(".pick") as unknown as HTMLElement).click();

    const picked = root.querySelector(".choice.branch .candidate.picked");
    expect(picked?.textContent).toContain("Artificial Intelligence");
    expect(root.querySelector(".choice.branch .reset")).toBeTruthy();

    (root.querySelector(".choice.branch .reset") as unknown as HTMLElement).click();
    expect(root.querySelector(".choice.branch .candidate.picked")?.textContent).toContain(
      "Technical electives",
    );
    localStorage.removeItem("cedarville:tracks");
  });
});

describe("build view — a pool that cannot close its requirement", () => {
  test("says the seminar is required twice, because that is what it means", () => {
    const short = normalize(
      program("BS.CYOPR", [
        group({
          Id: "sem",
          DisplayText: "Honors Integrative Seminars (4 credit hours)",
          FromCourses: [course("1", "HON", "3020"), course("2", "HON", "4900")],
          MinCredits: 4,
        }),
      ]),
    );
    // Credits have to come from a catalog: at the default of three apiece the
    // two courses would cover four and there would be no shortfall to show.
    const allCourses = [
      { SubjectCode: "HON", Number: "3020", Title: "Honors Seminar", MinimumCredits: 2 },
      { SubjectCode: "HON", Number: "4900", Title: "Ind Study", MinimumCredits: 1 },
    ] as unknown as NonNullable<Ctx["allCourses"]>;

    build.mount(root, { trees: [short], enrolled: ["BS.CYOPR"], allCourses });
    // Four credits over a two-credit seminar is that seminar twice, and the
    // pool's one-credit study is not part of the reading.
    const row = Array.from(root.querySelectorAll(".candidate")).find((r) =>
      r.textContent?.includes("HON-3020"),
    );
    expect(row?.textContent).toContain("take it twice");
    expect(root.querySelector(".shortfall")).toBeNull();
  });
});

describe("build view — reading the requirement text", () => {
  const wordy = group({
    Id: "tech",
    DisplayText: "Technical electives selected from the following (6 credit hours):",
    FromCourses: [course("1", "CS", "3220"), course("2", "CS", "3510")],
    MinCredits: 6,
  });

  test("drops the trailing colon and the credits shown beside it", () => {
    build.mount(root, { trees: [treeOf("BS.CYOPR", [wordy])], enrolled: ["BS.CYOPR"] });
    const head = root.querySelector(".choice h3") as unknown as HTMLElement;
    expect(head.firstChild?.textContent).toBe("Technical electives");
    // The count still appears, once, as its own badge.
    expect(head.querySelector(".cr")?.textContent).toBe("6 cr");
  });

  test("drops a credit count buried in a longer aside", () => {
    const buried = group({
      Id: "hum",
      DisplayText:
        "Humanities Elective (3 credit hours selected from the list of courses identified in the catalog)",
      FromCourses: [course("1", "ART", "1100"), course("2", "LIT", "2090")],
      MinCredits: 3,
    });
    build.mount(root, { trees: [treeOf("BS.CYOPR", [buried])], enrolled: ["BS.CYOPR"] });
    const head = root.querySelector(".choice h3") as unknown as HTMLElement;
    expect(head.firstChild?.textContent).toBe("Humanities Elective");
  });

  test("a long branch option wraps rather than being clipped", () => {
    // Colleague's AI-track text runs to two sentences; `.title` is nowrap and
    // ellipsised, which silently ate the advice about MATH-3610.
    const long =
      "Replace 9 hours of technical electives with the Artificial Intelligence Track. " +
      "*Students taking the Artificial Intelligence Track should take MATH-3610 Linear " +
      "Algebra as their MATH elective.";
    const tree = normalize({
      StudentId: "1",
      Program: {
        Code: "BS.CYOPR",
        Title: "cyber",
        Catalog: "2026",
        Degree: "BS",
        MinimumCredits: 128,
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
                    Id: "t",
                    DisplayText: "Technical electives",
                    FromCourses: [course("1", "CS", "3220")],
                    MinCredits: 3,
                  }),
                  group({
                    Id: "ai",
                    DisplayText: long,
                    FromCourses: [course("2", "DSAI", "3110")],
                    MinCredits: 9,
                  }),
                ],
              },
            ],
          },
        ],
      },
    } as EvaluationResponse);

    build.mount(root, { trees: [tree], enrolled: ["BS.CYOPR"] });
    const option = Array.from(root.querySelectorAll(".choice.branch .candidate .label")).find((n) =>
      n.textContent?.includes("Artificial Intelligence"),
    );
    // Kept whole, and not wearing the class that clips.
    expect(option?.textContent).toContain("MATH-3610");
    expect(option?.className).toBe("label");
  });
});

describe("build view — a pool of one is not a choice", () => {
  /*
   * Picking the senior project among the branches used to make a box appear
   * at the bottom whose only option was the senior project. A control with
   * one setting reads as broken, and there was never anything to decide.
   */
  const lone = () => {
    const raw = program("BS.CYOPR", [
      group({
        Id: "solo",
        DisplayText: "Honors Senior Project (2 credit hours)",
        FromCourses: [course("1", "HON", "4950")],
        MinCredits: 2,
      }),
      group({
        Id: "pair",
        DisplayText: "One laboratory science",
        FromCourses: [course("2", "BIO", "1115"), course("3", "CHEM", "1110")],
        MinCredits: 4,
      }),
    ]);
    // Both groups are owed; the shared fixture would otherwise make them a
    // choice between themselves, which is a different question entirely.
    raw.Program.Requirements[0]!.Subrequirements[0]!.MinGroups = null;
    return normalize(raw);
  };

  test("shows the real choice and not the settled one", () => {
    build.mount(root, { trees: [lone()], enrolled: ["BS.CYOPR"] });
    const headings = Array.from(root.querySelectorAll(".choice:not(.branch) h3")).map(
      (h) => h.textContent ?? "",
    );
    expect(headings.some((h) => h.includes("laboratory"))).toBe(true);
    expect(headings.some((h) => h.includes("Senior Project"))).toBe(false);
  });

  test("but keeps one a rule in prose decided, since that carries the reason", () => {
    // "Students pursuing the Computer Science/Cyber Operations double major
    // must take PHYS-2120" is why a course nobody picked is on the degree.
    const mandated = normalize(
      program("BS.CYOPR", [
        group({
          Id: "phys",
          DisplayText:
            "Select one course - Students pursuing the Computer Science/Cyber Operations " +
            "double major must take PHYS-2120.",
          FromCourses: [course("1", "BIO", "1115"), course("2", "PHYS", "2120")],
          MinCredits: 4,
        }),
      ]),
    );
    mandated.majors = ["Computer Science", "Cyber Operations"];
    build.mount(root, { trees: [mandated], enrolled: ["BS.CYOPR"] });
    expect(root.textContent).toContain("required for this combination");
  });
});

describe("build view — a requirement already met", () => {
  /** The major requires CS-1210 outright, and it covers the minor's elective. */
  const major = () => normalize(program("MAJ", [group({ Courses: [course("1", "CS", "1210")] })]));
  const minorNeeding = (credits: number) =>
    normalize(
      program("MIN", [
        group({
          Id: "e",
          DisplayText: "One computing elective",
          FromCourses: [course("1", "CS", "1210"), course("9", "ART", "1100")],
          MinCredits: credits,
        }),
      ]),
    );

  test("marks the heading met and says what covers it", () => {
    build.mount(root, { trees: [major(), minorNeeding(3)], enrolled: ["MAJ"] });
    const box = root.querySelector(".choice.met") as unknown as HTMLElement;
    expect(box).toBeTruthy();
    expect(box.querySelector("h3")?.textContent).toContain("met");
    expect(box.textContent).toContain("CS-1210 covers this");
  });

  test("a met requirement still lets you pick more", () => {
    // Wanting a second course in a subject you like is a real thing to want,
    // and the planner has no business refusing it. Only the course the degree
    // requires outright is fixed.
    build.mount(root, { trees: [major(), minorNeeding(3)], enrolled: ["MAJ"] });
    const box = root.querySelector(".choice.met") as unknown as HTMLElement;
    const rows = Array.from(box.querySelectorAll(".candidate"));
    const locked = rows.filter(
      (r) => (r.querySelector(".pick") as unknown as HTMLButtonElement).disabled,
    );
    expect(locked).toHaveLength(1);
    expect(locked[0]?.textContent).toContain("CS-1210");

    const art = rows.find((r) => r.textContent?.includes("ART-1100"))!;
    (art.querySelector(".pick") as unknown as HTMLElement).click();
    expect(
      Array.from(root.querySelectorAll(".candidate.picked")).some((r) =>
        r.textContent?.includes("ART-1100"),
      ),
    ).toBe(true);
    localStorage.removeItem("cedarville:pins");
  });

  test("a requirement only partly covered is not marked met", () => {
    // Six credits wanted, three of them forced: there is still a decision.
    build.mount(root, { trees: [major(), minorNeeding(6)], enrolled: ["MAJ"] });
    expect(root.querySelector(".choice.met")).toBeNull();
  });
});

describe("build view — what the projection knows about seasons", () => {
  const only = (groups: RawGroup[]) => normalize(program("BS.CYOPR", groups));
  const required = [group({ Courses: [course("1", "CS", "1210")], DisplayText: "Take this" })];

  test("a course the degree requires outright cannot be unpicked", () => {
    const major = normalize(program("MAJ", [group({ Courses: [course("1", "CS", "1210")] })]));
    const minor = normalize(
      program("MIN", [
        group({
          Id: "e",
          DisplayText: "One computing elective",
          FromCourses: [course("1", "CS", "1210"), course("9", "ART", "1100")],
          MinCredits: 3,
        }),
      ]),
    );
    build.mount(root, { trees: [major, minor], enrolled: ["MAJ"] });

    const rows = Array.from(root.querySelectorAll(".choice .candidate"));
    const cs = rows.find((r) => r.textContent?.includes("CS-1210"))!;
    const art = rows.find((r) => r.textContent?.includes("ART-1100"))!;

    // Required: shown as taken, and not something you can toggle.
    expect(cs.className).toContain("picked");
    expect((cs.querySelector(".pick") as unknown as HTMLButtonElement).disabled).toBe(true);
    // Its neighbour is still a live choice.
    expect((art.querySelector(".pick") as unknown as HTMLButtonElement).disabled).toBe(false);
  });

  test("counts the courses the catalog says nothing about", () => {
    // Silence is not a refusal, but a date resting on several of them is
    // worth less than one that is not — so say how many.
    build.mount(root, { trees: [only(required)], enrolled: ["BS.CYOPR"] });
    const note = root.querySelector(".guessed");
    expect(note?.textContent).toContain("state no season");
    expect(note?.getAttribute("title")).toContain("assumes any");
  });

  test("places a course against the season the registrar states", () => {
    const allCourses = [
      {
        SubjectCode: "CS",
        Number: "1210",
        Title: "Intro",
        MinimumCredits: 3,
        TermsOffered: "Fall Only",
      },
    ] as unknown as NonNullable<Ctx["allCourses"]>;
    build.mount(root, { trees: [only(required)], enrolled: ["BS.CYOPR"], allCourses });
    // Autumn-only, so it can never land in the spring term the plan opens on.
    const lands = root.querySelector(".candidate .lands")?.textContent ?? "";
    expect(lands.startsWith("SP")).toBe(false);
  });
});

describe("build view — a route already walked", () => {
  const applied = (name: string, credit: number) => ({
    Id: name,
    CourseId: name,
    CourseName: name,
    Title: name,
    Credit: credit,
    VerifiedGrade: "A",
    Term: "24/FA",
    IsCompletedCredit: true,
    IsTransferCourse: false,
    IsWithdrawn: false,
    IsExtraCourse: false,
    AllowedByOverride: false,
    ReplacedStatus: "NotReplaced",
    ReplacementStatus: "NotReplacement",
  });

  /** Global awareness: six routes, one of them already finished. */
  const sixRoutes = normalize({
    StudentId: "1",
    Program: {
      Code: "BS.CYOPR",
      Title: "cyber",
      Catalog: "2026",
      Degree: "BS",
      MinimumCredits: 128,
      CompletedCredits: 0,
      InProgressCredits: 0,
      PlannedCredits: 0,
      RequiredRequirementCount: 1,
      CompletedRequirementCount: 0,
      Requirements: [
        {
          Id: "g",
          Code: "UG.GLOBAL",
          Description: "Global Awareness Requirement",
          CompletionStatus: "Completed",
          PlanningStatus: "CompletelyPlanned",
          MinSubrequirements: 1,
          MinGpa: null,
          Subrequirements: [
            {
              Id: "hs",
              Code: "2Yr HS Foreign Lang",
              DisplayText: "",
              CompletionStatus: "Completed",
              PlanningStatus: "CompletelyPlanned",
              MinGroups: null,
              MinGpa: null,
              MinInstitutionalCredits: null,
              Groups: [group({ Id: "hsg", CompletionStatus: "Completed" })],
            },
            {
              Id: "fl",
              Code: "Elem-Lvl Coll FL",
              DisplayText: "",
              CompletionStatus: "NotStarted",
              PlanningStatus: "NotPlanned",
              MinGroups: null,
              MinGpa: null,
              MinInstitutionalCredits: null,
              Groups: [
                group({ Id: "flg", FromCourses: [course("7", "SPAN", "1010")], MinCredits: 4 }),
              ],
            },
          ],
        },
      ],
    },
  } as EvaluationResponse);

  test("locks every route once one is finished", () => {
    build.mount(root, { trees: [sixRoutes], enrolled: ["BS.CYOPR"] });
    const box = root.querySelector(".choice.branch") as unknown as HTMLElement;
    expect(box.querySelector("h3")?.textContent).toContain("met");

    const picks = Array.from(box.querySelectorAll(".pick")) as unknown as HTMLButtonElement[];
    expect(picks.length).toBeGreaterThan(1);
    expect(picks.every((p) => p.disabled)).toBe(true);
    // The finished route reads as the answer, whatever the solver preferred.
    expect(box.querySelector(".candidate.picked")?.textContent).toContain("2Yr HS Foreign Lang");
    // And there is no way back to "cheapest", because nothing is being chosen.
    expect(box.querySelector(".reset")).toBeNull();
  });

  const humanities = (credit: ReturnType<typeof applied>) =>
    normalize(
      program("BS.CYOPR", [
        group({
          Id: "hum",
          DisplayText: "Introduction to Humanities",
          FromCourses: [course("1", "HUM", "1400"), course("2", "HON", "1010")],
          MinCredits: 3,
          CompletionStatus: "PartiallyCompleted",
          AppliedAcademicCredits: [credit],
        }),
      ]),
    );

  test("a requirement met by coursework on the transcript says so", () => {
    // Listing HUM-1400 at a term's cost implies work that is behind you.
    build.mount(root, { trees: [humanities(applied("HON-1010", 5))], enrolled: ["BS.CYOPR"] });
    const box = root.querySelector(".choice.met") as unknown as HTMLElement;
    expect(box).toBeTruthy();
    expect(box.textContent).toContain("HON-1010 covers this");
    expect(box.textContent).toContain("already on your transcript");
  });

  test("a course under way is not described as passed", () => {
    // A plan starts after this term, so it counts as held — but a student
    // sitting the exam in December has not "already passed" anything.
    const running = { ...applied("HON-1010", 5), IsCompletedCredit: false, VerifiedGrade: "" };
    build.mount(root, { trees: [humanities(running)], enrolled: ["BS.CYOPR"] });
    const box = root.querySelector(".choice.met") as unknown as HTMLElement;
    expect(box.textContent).toContain("you are taking it now");
    expect(box.textContent).not.toContain("passed");
  });
});

describe("build view — a saving reads as a saving", () => {
  const graph = [
    { SubjectCode: "CS", Number: "3220", Title: "Web", MinimumCredits: 3 },
    { SubjectCode: "ART", Number: "1100", Title: "Drawing", MinimumCredits: 9 },
  ] as unknown as NonNullable<Ctx["allCourses"]>;

  const elective = normalize(
    program("BS.CYOPR", [
      group({
        Id: "e",
        DisplayText: "One elective",
        FromCourses: [course("1", "CS", "3220"), course("9", "ART", "1100")],
        MinCredits: 3,
      }),
    ]),
  );

  test("shows what switching back would give you", () => {
    build.mount(root, { trees: [elective], enrolled: ["BS.CYOPR"], allCourses: graph });
    const rows = () => Array.from(root.querySelectorAll(".candidate"));

    // Pin the nine-credit course, then the three-credit one is a six-credit
    // saving — not "free", which is what a clamp at zero would have said.
    const art = rows().find((r) => r.textContent?.includes("ART-1100"))!;
    (art.querySelector(".pick") as unknown as HTMLElement).click();

    const cs = rows().find((r) => r.textContent?.includes("CS-3220"))!;
    expect(cs.querySelector(".tag")?.textContent).toBe("−6 cr");
    localStorage.removeItem("cedarville:pins");
  });
});

describe("build view — a cost is always a number", () => {
  test("shows +0 cr rather than the word free", () => {
    // ART-1200 is a swap for ART-1100 at the same price, so it costs nothing —
    // and a signed zero sits in the same column as +3 and is read against it.
    const major = normalize(program("MAJ", [group({ Courses: [course("1", "CS", "1210")] })]));
    const minor = normalize(
      program("MIN", [
        group({
          Id: "e",
          DisplayText: "One elective",
          FromCourses: [
            course("1", "CS", "1210"),
            course("9", "ART", "1100"),
            course("8", "ART", "1200"),
          ],
          MinCredits: 6,
        }),
      ]),
    );
    build.mount(root, { trees: [major, minor], enrolled: ["MAJ"] });
    const badges = Array.from(root.querySelectorAll(".candidate .tag")).map((n) => n.textContent);
    expect(badges).not.toContain("free");
    expect(badges).toContain("+0 cr");
  });

  test("keeps the credit count on a track label but drops the boilerplate", () => {
    const tree = normalize({
      StudentId: "1",
      Program: {
        Code: "BS.CYOPR",
        Title: "cyber",
        Catalog: "2026",
        Degree: "BS",
        MinimumCredits: 128,
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
                DisplayText: "Electives or the track",
                CompletionStatus: "NotStarted",
                PlanningStatus: "NotPlanned",
                MinGroups: 1,
                MinGpa: null,
                MinInstitutionalCredits: null,
                Groups: [
                  group({
                    Id: "tech",
                    DisplayText:
                      "Technical electives selected from the following (6 credit hours):",
                    FromCourses: [course("1", "CS", "3220")],
                    MinCredits: 6,
                  }),
                  group({
                    Id: "ai",
                    DisplayText: "Artificial Intelligence Track (9 credit hours)",
                    FromCourses: [course("2", "DSAI", "2110")],
                    MinCredits: 9,
                  }),
                ],
              },
            ],
          },
        ],
      },
    } as EvaluationResponse);

    build.mount(root, { trees: [tree], enrolled: ["BS.CYOPR"] });
    const labels = Array.from(root.querySelectorAll(".choice.branch .label")).map(
      (n) => n.textContent,
    );
    // The count is the substance of the choice and stays; the trailing colon
    // and the pointer to a printed list do not.
    expect(labels).toContain("Technical electives (6 credit hours)");
    expect(labels).toContain("Artificial Intelligence Track (9 credit hours)");
  });
});

describe("build view — variable-credit courses", () => {
  test("prices the two honors capstone routes as equal", () => {
    // HON-4950 runs 1 to 2 credits and the requirement asks for 2, so the
    // research project costs exactly what the two-course colloquium does.
    const allCourses = [
      { SubjectCode: "HON", Number: "4910", Title: "Colloq I", MinimumCredits: 1 },
      { SubjectCode: "HON", Number: "4920", Title: "Colloq II", MinimumCredits: 1 },
      {
        SubjectCode: "HON",
        Number: "4950",
        Title: "Project",
        MinimumCredits: 1,
        MaximumCredits: 2,
      },
    ] as unknown as NonNullable<Ctx["allCourses"]>;

    const tree = normalize({
      StudentId: "1",
      Program: {
        Code: "BS.CYOPR",
        Title: "cyber",
        Catalog: "2026",
        Degree: "BS",
        MinimumCredits: 128,
        CompletedCredits: 0,
        InProgressCredits: 0,
        PlannedCredits: 0,
        RequiredRequirementCount: 1,
        CompletedRequirementCount: 0,
        Requirements: [
          {
            Id: "r",
            Code: "ID.99.MINOR",
            Description: "Honors",
            CompletionStatus: "NotStarted",
            PlanningStatus: "NotPlanned",
            MinSubrequirements: null,
            MinGpa: null,
            Subrequirements: [
              {
                Id: "cap",
                Code: "Research Proj/Thesis",
                DisplayText: "Honors capstone",
                CompletionStatus: "NotStarted",
                PlanningStatus: "NotPlanned",
                MinGroups: 1,
                MinGpa: null,
                MinInstitutionalCredits: null,
                Groups: [
                  group({
                    Id: "colloq",
                    DisplayText: "Honors Senior Colloquium I & II (2 credit hours)",
                    Courses: [course("1", "HON", "4910"), course("2", "HON", "4920")],
                  }),
                  group({
                    Id: "proj",
                    DisplayText: "Honors Senior Project (2 credit hours)",
                    FromCourses: [course("3", "HON", "4950")],
                    MinCredits: 2,
                  }),
                ],
              },
            ],
          },
        ],
      },
    } as EvaluationResponse);

    build.mount(root, { trees: [tree], enrolled: ["BS.CYOPR"], allCourses });
    const rows = Array.from(root.querySelectorAll(".choice.branch .candidate"));
    const other = rows.find((r) => !r.className.includes("picked"))!;
    expect(other.querySelector(".tag")?.textContent).toBe("+0 cr");
  });
});

describe("build view — when, and why not", () => {
  const pool = [course("1", "ART", "1100"), course("9", "ARBC", "2420")];
  const tree = normalize(
    program("BS.CYOPR", [
      group({ Id: "e", DisplayText: "One elective", FromCourses: pool, MinCredits: 3 }),
    ]),
  );

  test("shows the term a course would be taken in", () => {
    build.mount(root, { trees: [tree], enrolled: ["BS.CYOPR"] });
    const lands = Array.from(root.querySelectorAll(".candidate .lands")).map((n) => n.textContent);
    expect(lands.length).toBeGreaterThan(0);
    expect(lands[0]).toMatch(/^(SP|FA|SU)\d\d$/);
  });

  test("explains a refusal instead of stating one", () => {
    // ARBC-2420 is Arabic IV: a spring-only course behind a three-course
    // sequence. "Won't schedule" tells a student nothing they can act on.
    const withChain = {
      trees: [tree],
      enrolled: ["BS.CYOPR"],
      allCourses: [
        { SubjectCode: "ART", Number: "1100", Title: "Drawing", MinimumCredits: 3 },
        {
          SubjectCode: "ARBC",
          Number: "2420",
          Title: "Arabic IV",
          MinimumCredits: 3,
          CourseRequisites: [
            {
              DisplayText: "Take ARBC-1410, ARBC-1420, ARBC-2410",
              DisplayTextExtension: "- Must be completed prior to taking this course.",
              IsRequired: true,
            },
          ],
        },
        { SubjectCode: "ARBC", Number: "1410", Title: "Arabic I", MinimumCredits: 3 },
        { SubjectCode: "ARBC", Number: "1420", Title: "Arabic II", MinimumCredits: 3 },
        { SubjectCode: "ARBC", Number: "2410", Title: "Arabic III", MinimumCredits: 3 },
      ] as unknown as NonNullable<Ctx["allCourses"]>,
    };
    build.mount(root, withChain);
    const arabic = Array.from(root.querySelectorAll(".candidate")).find((r) =>
      r.textContent?.includes("ARBC-2420"),
    )!;
    // Three credits on paper, twelve in practice — and the cover must not
    // prefer it to the standalone course on the strength of the sticker price.
    // The row shows a count; the names live on the tooltip.
    expect(arabic.textContent).toContain("+3 first");
    expect(arabic.querySelector(".muted")?.getAttribute("title")).toContain("ARBC-1410");
    expect(arabic.textContent).toContain("+9 cr");
    const art = Array.from(root.querySelectorAll(".candidate")).find((r) =>
      r.textContent?.includes("ART-1100"),
    )!;
    expect(art.textContent).toContain("cheapest");
  });
});

describe("build view — a row stays scannable", () => {
  test("a refusal is two words with the reason on hover", () => {
    // Two slots, and a four-course spring-only chain that cannot fit.
    const tree = normalize(
      program("BS.CYOPR", [
        group({
          Id: "e",
          DisplayText: "One elective",
          FromCourses: [course("1", "ART", "1100"), course("9", "ARBC", "2420")],
          MinCredits: 3,
        }),
      ]),
    );
    const allCourses = [
      { SubjectCode: "ART", Number: "1100", Title: "Drawing", MinimumCredits: 3 },
      {
        SubjectCode: "ARBC",
        Number: "2420",
        Title: "Arabic IV",
        MinimumCredits: 3,
        CourseRequisites: [
          {
            DisplayText: "Take ARBC-1410, ARBC-1420, ARBC-2410",
            DisplayTextExtension: "- Must be completed prior to taking this course.",
            IsRequired: true,
          },
        ],
      },
      { SubjectCode: "ARBC", Number: "1410", Title: "A1", MinimumCredits: 3 },
      { SubjectCode: "ARBC", Number: "1420", Title: "A2", MinimumCredits: 3 },
      { SubjectCode: "ARBC", Number: "2410", Title: "A3", MinimumCredits: 3 },
    ] as unknown as NonNullable<Ctx["allCourses"]>;

    build.mount(root, {
      trees: [tree],
      enrolled: ["BS.CYOPR"],
      allCourses,
      // One term of capacity three: the Arabic chain cannot possibly land.
      sections: { term: "2027SP", sections: [], courses: [], fetchedAt: "" } as never,
    });

    const arabic = Array.from(root.querySelectorAll(".candidate")).find((r) =>
      r.textContent?.includes("ARBC-2420"),
    )!;
    const badge = arabic.querySelector(".tag") as unknown as HTMLElement;
    // Whatever the verdict, the badge never becomes a sentence.
    expect((badge.textContent ?? "").length).toBeLessThan(20);
    expect((badge.title ?? "").length).toBeGreaterThan(badge.textContent!.length);
  });
});

describe("build view — a choice the prose has already made", () => {
  const PHYS =
    "Select one course (4 credit hours) - Students pursuing the Computer Science/Cyber Operations double major must take PHYS-2120.";
  const cs = (majors: string[]) =>
    normalize(
      program(
        "BS.CMPSC",
        [
          group({
            Id: "sci",
            DisplayText: PHYS,
            FromCourses: [course("1", "BIO", "1115"), course("2", "PHYS", "2120")],
            MinCourses: 1,
            MinCredits: 4,
          }),
        ],
        { Majors: majors },
      ),
    );

  test("marks the group required and offers only the mandated course", () => {
    build.mount(root, {
      trees: [cs(["Computer Science", "Cyber Operations"])],
      enrolled: ["BS.CMPSC"],
    });
    const box = root.querySelector(".choice") as unknown as HTMLElement;
    expect(box.querySelector("h3")?.textContent).toContain("required for this combination");
    const codes = Array.from(box.querySelectorAll(".candidate b")).map((n) => n.textContent);
    expect(codes).toEqual(["PHYS-2120"]);
  });

  test("a single major still gets the full choice", () => {
    build.mount(root, { trees: [cs(["Computer Science"])], enrolled: ["BS.CMPSC"] });
    const codes = Array.from(root.querySelectorAll(".choice .candidate b")).map(
      (n) => n.textContent,
    );
    expect(codes.sort()).toEqual(["BIO-1115", "PHYS-2120"]);
    expect(root.textContent).not.toContain("required for this combination");
  });
});

describe("build view — picking does not lock", () => {
  test("a chosen literature course stays unpickable-again, not required", () => {
    const tree = normalize(
      program("BS.CYOPR", [
        group({
          Id: "lit",
          DisplayText: "2000-level Literature course",
          FromCourses: [course("1", "LIT", "2090"), course("2", "LIT", "2330")],
          MinCredits: 3,
        }),
      ]),
    );
    build.mount(root, { trees: [tree], enrolled: ["BS.CYOPR"] });

    const rowFor = (code: string) =>
      Array.from(root.querySelectorAll(".candidate")).find((r) => r.textContent?.includes(code))!;
    (rowFor("LIT-2330").querySelector(".pick") as unknown as HTMLElement).click();

    const picked = rowFor("LIT-2330");
    expect(picked.className).toContain("picked");
    // The student's own decision must remain theirs to undo.
    expect((picked.querySelector(".pick") as unknown as HTMLButtonElement).disabled).toBe(false);
    expect(picked.textContent).not.toContain("already required");

    (picked.querySelector(".pick") as unknown as HTMLElement).click();
    expect(rowFor("LIT-2330").className).not.toContain("picked");
    localStorage.removeItem("cedarville:pins");
  });
});

describe("plan view — drawn as a graph", () => {
  // The graph is one rendering of the plan tab, so it is exercised through it.
  const asGraph = () => localStorage.setItem("cedarville:plan-shape", JSON.stringify("graph"));

  const allCourses = [
    { SubjectCode: "CS", Number: "1210", Title: "Intro", MinimumCredits: 3 },
    {
      SubjectCode: "CS",
      Number: "1220",
      Title: "OO Design",
      MinimumCredits: 3,
      CourseRequisites: [
        {
          DisplayText: "Take CS-1210",
          DisplayTextExtension: "- Must be completed prior to taking this course.",
          IsRequired: true,
        },
      ],
    },
  ] as unknown as NonNullable<Ctx["allCourses"]>;

  const tree = normalize(
    program("BS.CYOPR", [
      group({ Courses: [course("1", "CS", "1210"), course("2", "CS", "1220")] }),
    ]),
  );

  test("asks for a capture before it can draw anything", () => {
    plan.mount(root, { trees: [] });
    expect(root.textContent).toContain("capture your requirements");
  });

  test("draws a node per course and an edge per prerequisite", () => {
    asGraph();
    plan.mount(root, { trees: [tree], enrolled: ["BS.CYOPR"], allCourses });
    expect(root.querySelectorAll(".graph .node")).toHaveLength(2);
    expect(root.querySelectorAll(".graph .edge")).toHaveLength(1);
    expect(root.textContent).toContain("prerequisite links");
  });

  test("counts the chain that sets the finish date without painting it", () => {
    // The number is the part worth quoting to an advisor. Colouring six boxes
    // to say it drowns out the hover trace, which answers a question you asked.
    asGraph();
    plan.mount(root, { trees: [tree], enrolled: ["BS.CYOPR"], allCourses });
    expect(root.textContent).toContain("longest chain");
    expect(root.querySelectorAll(".graph .critical")).toHaveLength(0);
  });

  test("hovering a course dims everything off its chain", () => {
    asGraph();
    plan.mount(root, { trees: [tree], enrolled: ["BS.CYOPR"], allCourses });
    const first = root.querySelector(".graph .node") as unknown as HTMLElement;
    first.dispatchEvent(new window.Event("mouseenter") as unknown as Event);
    // Which way a course is connected is the whole question: what it waits on
    // is work to do first, what waits on it is work stuck behind it.
    expect(root.textContent).toContain("waits on nothing, unlocks 1");
    expect(root.querySelectorAll(".graph .node.after")).toHaveLength(1);
    expect(root.querySelectorAll(".graph .node.before")).toHaveLength(0);
  });

  test("and lights the other end of the chain the other way round", () => {
    asGraph();
    plan.mount(root, { trees: [tree], enrolled: ["BS.CYOPR"], allCourses });
    const second = root.querySelectorAll(".graph .node")[1] as unknown as HTMLElement;
    second.dispatchEvent(new window.Event("mouseenter") as unknown as Event);
    expect(root.textContent).toContain("waits on 1, unlocks nothing");
    expect(root.querySelectorAll(".graph .node.before")).toHaveLength(1);
  });

  test("the box under the pointer survives being hovered", () => {
    // Redrawing on hover pulled the element out from under the pointer, so the
    // mouseleave that would have cleared the highlight fired on a box that no
    // longer existed and the trace stuck. Same element, before and after.
    asGraph();
    plan.mount(root, { trees: [tree], enrolled: ["BS.CYOPR"], allCourses });
    const box = root.querySelector(".graph .node") as unknown as HTMLElement;
    box.dispatchEvent(new window.Event("mouseenter") as unknown as Event);
    expect(root.querySelector(".graph .node")).toBe(box as never);

    box.dispatchEvent(new window.Event("mouseleave") as unknown as Event);
    expect(root.textContent).not.toContain("waits on");
    expect(root.querySelectorAll(".graph .node.dim")).toHaveLength(0);
  });

  /*
   * "Senior status in engineering" is a sentence of prose and sometimes just
   * the word in a title. It gates a course as hard as any prerequisite and
   * draws no line to say so, which is why a course can sit three years out
   * with nothing at all behind it on the board.
   */
  test("says when a course is waiting on credits rather than on courses", () => {
    asGraph();
    const senior = [
      ...allCourses,
      {
        SubjectCode: "EGGN",
        Number: "2010",
        Title: "Engineering Practice",
        MinimumCredits: 1,
        Description: "Prerequisite: sophomore status in engineering.",
      },
    ] as unknown as NonNullable<Ctx["allCourses"]>;
    const tree = normalize(
      program("BS.CYOPR", [
        group({ Courses: [course("1", "CS", "1210"), course("9", "EGGN", "2010")] }),
      ]),
    );
    plan.mount(root, { trees: [tree], enrolled: ["BS.CYOPR"], allCourses: senior });

    const node = Array.from(root.querySelectorAll(".graph .node")).find((n) =>
      n.textContent?.includes("EGGN-2010"),
    );
    expect(node?.textContent).toContain("soph");
    expect(node?.querySelector("title")?.textContent).toContain("31 credits");

    node?.dispatchEvent(new window.Event("mouseenter") as unknown as Event);
    expect(root.textContent).toContain("and sophomore standing");
  });

  test("destroys cleanly", () => {
    asGraph();
    const view = plan.mount(root, { trees: [tree], enrolled: ["BS.CYOPR"], allCourses });
    view.destroy();
    expect(root.children).toHaveLength(0);
  });

  /*
   * SVG does not join in with HTML drag and drop, and the picture is the tab's
   * default rendering — so the moves are wired by hand here, and a feature
   * that only works in the other rendering is one most people never find.
   */
  describe("moving a course by hand", () => {
    /** happy-dom's events and the DOM's are structurally different, and both
     * ends of a dispatch have to agree; loosening the node is the honest way
     * through, and it keeps the coordinates readable. */
    const send = (node: unknown, type: string, at: { x: number; y: number }) =>
      (node as { dispatchEvent(event: unknown): boolean }).dispatchEvent(
        new window.MouseEvent(type, { bubbles: true, clientX: at.x, clientY: at.y }),
      );

    /** Where each term's heading hangs, which is where its band begins. */
    const bands = () =>
      Array.from(root.querySelectorAll(".graph .term-label")).map((label) => ({
        name: (label.textContent ?? "").split(" ")[0]!,
        y: Number(label.getAttribute("y")),
      }));

    beforeEach(() => {
      localStorage.removeItem("cedarville:moves");
      asGraph();
    });

    test("drags a course down into a later term", () => {
      plan.mount(root, { trees: [tree], enrolled: ["BS.CYOPR"], allCourses });
      const box = root.querySelector(".graph .node") as unknown as HTMLElement;
      const code = (box.querySelector(".code")?.textContent ?? "").trim();
      const target = bands().at(-1)!;

      send(box, "mousedown", { x: 20, y: 40 });
      send(window.document, "mousemove", { x: 20, y: target.y + 20 });
      send(window.document, "mouseup", { x: 20, y: target.y + 20 });

      expect(JSON.parse(localStorage.getItem("cedarville:moves")!)[code]).toBe(target.name);
      expect(root.querySelector(".graph .node.moved")).toBeTruthy();
    });

    test("a press that goes nowhere is still a click", () => {
      plan.mount(root, { trees: [tree], enrolled: ["BS.CYOPR"], allCourses });
      const box = root.querySelector(".graph .node") as unknown as HTMLElement;
      send(box, "mousedown", { x: 20, y: 40 });
      send(window.document, "mousemove", { x: 21, y: 41 });
      send(window.document, "mouseup", { x: 21, y: 41 });
      expect(localStorage.getItem("cedarville:moves")).toBeNull();
    });

    test("double clicking a pinned course hands it back to the projection", () => {
      plan.mount(root, { trees: [tree], enrolled: ["BS.CYOPR"], allCourses });
      const box = root.querySelector(".graph .node") as unknown as HTMLElement;
      const target = bands().at(-1)!;
      send(box, "mousedown", { x: 20, y: 40 });
      send(window.document, "mousemove", { x: 20, y: target.y + 20 });
      send(window.document, "mouseup", { x: 20, y: target.y + 20 });

      const pinned = root.querySelector(".graph .node.moved") as unknown as HTMLElement;
      expect(pinned.querySelector("title")?.textContent).toContain("double click to unpin");
      pinned.dispatchEvent(new window.Event("dblclick", { bubbles: true }) as unknown as Event);

      expect(localStorage.getItem("cedarville:moves")).toBe("{}");
      expect(root.querySelector(".graph .node.moved")).toBeNull();
    });

    test("lets go of the course when the view does", () => {
      const view = plan.mount(root, { trees: [tree], enrolled: ["BS.CYOPR"], allCourses });
      const box = root.querySelector(".graph .node") as unknown as HTMLElement;
      send(box, "mousedown", { x: 20, y: 40 });
      view.destroy();
      // The listeners live on the document, so a torn-down view that kept
      // them would answer a pointer with a picture that is no longer there.
      send(window.document, "mousemove", { x: 20, y: 400 });
      send(window.document, "mouseup", { x: 20, y: 400 });
      expect(localStorage.getItem("cedarville:moves")).toBeNull();
    });
  });
});

describe("build view — how heavy a term", () => {
  const tree = () =>
    normalize(
      program("BS.CYOPR", [
        group({
          Id: "e",
          DisplayText: "One elective",
          FromCourses: [course("1", "ART", "1100"), course("2", "ART", "1200")],
          MinCredits: 3,
        }),
      ]),
    );

  test("says what an advisor swapped, and who never heard about it", () => {
    const swap = normalize(
      program("BS.CYOPR", [
        group({
          Courses: [course("1", "EGGN", "1910")],
          ModificationMessages: ["8/20/26: EGGN-1110 permitted to replace EGGN-1910."],
          AppliedAcademicCredits: [
            {
              Id: "EGGN-1110",
              CourseId: "EGGN-1110",
              CourseName: "EGGN-1110",
              Title: "EGGN-1110",
              Credit: 3,
              VerifiedGrade: "A",
              Term: "2026SP",
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
      ]),
    );
    const other = normalize(
      program("BS.CMPSC", [group({ Courses: [course("1", "EGGN", "1910")] })]),
    );

    build.mount(root, { trees: [swap, other], enrolled: ["BS.CYOPR", "BS.CMPSC"] });
    const note = root.querySelector(".notes .swap")?.textContent ?? "";
    expect(note).toContain("EGGN-1110 replaces EGGN-1910");
    expect(note).toContain("still lists EGGN-1910");
  });

  test("names a second major once, however many enrolments claim it", () => {
    // BS.CYOPR records the computer science major; BS.CMPSC is what answers
    // it. Both trees name it, and the student is doing it once.
    const cyber = normalize(program("BS.CYOPR", []));
    cyber.majors = ["Cyber Operations", "Computer Science"];
    cyber.minors = ["Honors Program"];
    const comp = normalize(program("BS.CMPSC", []));
    comp.majors = ["Computer Science"];

    build.mount(root, { trees: [cyber, comp], enrolled: ["BS.CYOPR", "BS.CMPSC"] });
    const names = Array.from(root.querySelectorAll(".chips .tag")).map((t) => t.textContent);
    expect(names).toEqual(["Cyber Operations", "Computer Science", "Honors Program"]);
  });

  test("offers the term, summer and semester knobs, within the school's own limits", () => {
    build.mount(root, { trees: [tree()], enrolled: ["BS.CYOPR"] });
    const dials = Array.from(root.querySelectorAll(".dial input")) as unknown as HTMLInputElement[];
    expect(dials).toHaveLength(4);
    // 12 is full time and 18.5 the ceiling advisor approval alone can reach.
    expect(dials[0]?.min).toBe("12");
    expect(dials[0]?.max).toBe("18.5");
    // How many summers, then how heavy each one is.
    expect(dials[1]?.min).toBe("0");
    expect(dials[1]?.max).toBe("4");
    expect(dials[2]?.min).toBe("0");
    expect(dials[3]?.type).toBe("checkbox");
  });

  test("counts the summers it will plan", () => {
    build.mount(root, { trees: [tree()], enrolled: ["BS.CYOPR"] });
    expect(root.querySelector(".dials")?.textContent).toContain("4 of 4");

    const [, summers] = Array.from(
      root.querySelectorAll(".dial input"),
    ) as unknown as HTMLInputElement[];
    summers!.value = "0";
    summers!.dispatchEvent(new window.Event("input") as unknown as Event);
    expect(root.querySelector(".dials")?.textContent).toContain("none");
    localStorage.removeItem("cedarville:load");
  });

  test("says what the school would call a load of that size", () => {
    build.mount(root, { trees: [tree()], enrolled: ["BS.CYOPR"] });
    expect(root.querySelector(".dials")?.textContent).toContain("a normal load");

    const perTerm = root.querySelector(".dial input") as unknown as HTMLInputElement;
    perTerm.value = "18";
    perTerm.dispatchEvent(new window.Event("input") as unknown as Event);
    expect(root.querySelector(".dials")?.textContent).toContain("overblock tuition");

    perTerm.value = "12";
    perTerm.dispatchEvent(new window.Event("input") as unknown as Event);
    expect(root.querySelector(".dials")?.textContent).toContain("under a normal load");
    localStorage.removeItem("cedarville:load");
  });

  test("remembers the load across a remount", () => {
    const view = build.mount(root, { trees: [tree()], enrolled: ["BS.CYOPR"] });
    const perTerm = root.querySelector(".dial input") as unknown as HTMLInputElement;
    perTerm.value = "17";
    perTerm.dispatchEvent(new window.Event("input") as unknown as Event);
    view.destroy();

    build.mount(root, { trees: [tree()], enrolled: ["BS.CYOPR"] });
    expect((root.querySelector(".dial input") as unknown as HTMLInputElement).value).toBe("17");
    localStorage.removeItem("cedarville:load");
  });
});

describe("build view — sharing a plan", () => {
  /*
   * The export used to be observed through `fetch`, because it posted a copy
   * to a development route on the catalog server. That route is gone — a
   * server that holds nobody's transcript should not have a way to be handed
   * one — so the decisions now go exactly two places, and this watches both.
   */
  test("writes out every decision, not just the courses", async () => {
    const tree = normalize(
      program(
        "BS.CYOPR",
        [
          group({
            Id: "e",
            DisplayText: "One elective",
            FromCourses: [course("1", "ART", "1100"), course("2", "ART", "1200")],
            MinCredits: 3,
          }),
        ],
        { Majors: ["Cyber Operations"] },
      ),
    );

    // The student's own machine, reached through the extension.
    const sent: { type: string; picks?: unknown }[] = [];
    Object.assign(globalThis, {
      chrome: {
        runtime: {
          sendMessage: (_id: string, msg: { type: string }, cb: (r: unknown) => void) => {
            sent.push(msg);
            cb({ ok: true, data: true });
          },
        },
      },
    });
    // And the clipboard, for an advisor's inbox. Defined rather than
    // assigned: happy-dom's own navigator.clipboard is read-only.
    let copied = "";
    const clipboard = {
      writeText: async (text: string) => {
        copied = text;
      },
    };
    Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });

    build.mount(root, { trees: [tree], enrolled: ["BS.CYOPR"] });
    const art = Array.from(root.querySelectorAll(".candidate")).find((r) =>
      r.textContent?.includes("ART-1200"),
    )!;
    (art.querySelector(".pick") as unknown as HTMLElement).click();
    (root.querySelector(".export") as unknown as HTMLElement).click();
    // The handler awaits the bridge before it reaches the clipboard.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const picks = sent.find((m) => m.type === "picks")?.picks as {
      pinned: string[];
      load: { perTerm: number };
      programs: { names: string[] }[];
    };
    expect(picks.pinned).toContain("ART-1200");
    expect(picks.load.perTerm).toBeGreaterThan(0);
    expect(picks.programs[0]?.names).toEqual(["Cyber Operations"]);
    expect(JSON.parse(copied)).toEqual(picks);

    Object.assign(globalThis, { chrome: undefined });
    localStorage.removeItem("cedarville:pins");
  });

  /*
   * And without an extension there is nowhere local to send them, which must
   * not cost the student the copy they asked for. The bridge rejecting rather
   * than throwing is what makes this pass.
   */
  test("still copies when there is no companion to send to", async () => {
    const tree = normalize(program("BS.CYOPR", [group({ Courses: [course("1", "CS", "1210")] })]));
    let copied = "";
    Object.assign(globalThis, { chrome: undefined });
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => {
          copied = text;
        },
      },
      configurable: true,
    });

    build.mount(root, { trees: [tree], enrolled: ["BS.CYOPR"] });
    (root.querySelector(".export") as unknown as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(JSON.parse(copied).programs[0]?.code).toBe("BS.CYOPR");
  });
});

describe("plan view — a course the catalog does not know", () => {
  /*
   * The bug this exists for: hosted, the shared course list was empty, the
   * graph fell back to one term's 925 courses, and a planned course outside
   * that term rendered as a bare code — no title, no credits, no requisites,
   * and nothing on screen saying why. A blank line reads as a rendering bug.
   */
  const asList = () => localStorage.setItem("cedarville:plan-shape", JSON.stringify("list"));

  const tree = () => {
    const raw = program("BS.CYOPR", [
      group({ Courses: [course("1", "CS", "1210")] }),
      group({ Courses: [course("9", "HON", "1010")] }),
    ]);
    raw.Program.Requirements[0]!.Subrequirements[0]!.MinGroups = null;
    return normalize(raw);
  };

  beforeEach(() => {
    localStorage.removeItem("cedarville:moves");
    asList();
  });

  test("says so, rather than drawing an empty line", () => {
    plan.mount(root, {
      trees: [tree()],
      // HON-1010 is in the degree and in no catalog this page holds.
      sections: {
        term: "2026FA",
        fetchedAt: "",
        sections: [],
        courses: [
          { Id: "1", SubjectCode: "CS", Number: "1210", Title: "Intro", MinimumCredits: 3 },
        ],
      },
    } as unknown as Ctx);

    const lines = Array.from(root.querySelectorAll(".plan-course"));
    const hon = lines.find((l) => l.textContent?.includes("HON-1010"));
    expect(hon?.textContent).toContain("no catalog record");
    expect(hon?.querySelector(".tag.bad")?.getAttribute("title")).toContain("all guesses");

    // And a course it does know is left alone.
    const cs = lines.find((l) => l.textContent?.includes("CS-1210"));
    expect(cs?.textContent).toContain("Intro");
    expect(cs?.querySelector(".tag.bad")).toBeFalsy();
  });
});
