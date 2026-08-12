import { describe, expect, test } from "bun:test";
import {
  conflicts,
  conflictsBetween,
  fits,
  formatTime,
  type Meeting,
  meetingsConflict,
  type Offering,
  offeringsFrom,
  parseDays,
  parseTime,
  span,
  toOffering,
  week,
} from "./schedule";
import type { Section, SectionsResponse } from "./types";

const meeting = (over: Partial<Meeting> = {}): Meeting => ({
  days: [1, 3, 5],
  start: 8 * 60,
  end: 9 * 60,
  from: "2026-08-24",
  to: "2026-12-11",
  room: "ENS 234",
  online: false,
  ...over,
});

const offering = (id: string, meetings: Meeting[]): Offering => ({
  id,
  courseId: id,
  courseName: id,
  number: "01",
  title: id,
  synonym: id,
  term: "26/FA",
  credits: { min: 3 },
  seats: { capacity: 30, enrolled: 10, available: 20, waitlisted: 0, status: "Open" },
  instructors: [],
  meetings,
  nonStandardDates: false,
});

describe("parsing days", () => {
  test("accepts the three shapes Colleague uses", () => {
    expect(parseDays(["Monday", "Wednesday", "Friday"])).toEqual([1, 3, 5]);
    expect(parseDays([1, 3, 5])).toEqual([1, 3, 5]);
    expect(parseDays("M, W, F")).toEqual([1, 3, 5]);
  });

  test("reads Thursday as R and Tuesday as T, not both as T", () => {
    expect(parseDays("T, R")).toEqual([2, 4]);
    expect(parseDays("Tu, Th")).toEqual([2, 4]);
  });

  test("survives empties and nonsense without inventing days", () => {
    expect(parseDays(null)).toEqual([]);
    expect(parseDays([])).toEqual([]);
    expect(parseDays("")).toEqual([]);
    expect(parseDays(["", "zzz"])).toEqual([]);
  });
});

describe("parsing times", () => {
  test("reads ISO, bare clock, and display forms alike", () => {
    expect(parseTime("2026-08-24T08:00:00")).toBe(480);
    expect(parseTime("08:00:00")).toBe(480);
    expect(parseTime("8:00 AM")).toBe(480);
    expect(parseTime("1:30 PM")).toBe(13 * 60 + 30);
  });

  test("handles the noon and midnight edges", () => {
    expect(parseTime("12:00 PM")).toBe(720);
    expect(parseTime("12:30 AM")).toBe(30);
  });

  test("returns null rather than zero when there is no time", () => {
    expect(parseTime(null)).toBeNull();
    expect(parseTime("")).toBeNull();
    expect(parseTime("TBD")).toBeNull();
  });
});

describe("conflicts", () => {
  test("same day and overlapping hour collides", () => {
    expect(meetingsConflict(meeting(), meeting({ start: 510, end: 570 }))).toBe(true);
  });

  test("back to back does not collide", () => {
    const a = meeting({ start: 480, end: 540 });
    const b = meeting({ start: 540, end: 600 });
    expect(meetingsConflict(a, b)).toBe(false);
  });

  test("different days never collide", () => {
    expect(meetingsConflict(meeting({ days: [1, 3, 5] }), meeting({ days: [2, 4] }))).toBe(false);
  });

  // The wrinkle that makes date-blind checks wrong: two 8-week sessions inside
  // one 16-week term can share a slot and never coexist.
  test("half-semester sections in different halves do not collide", () => {
    const first = meeting({ from: "2026-08-24", to: "2026-10-16" });
    const second = meeting({ from: "2026-10-19", to: "2026-12-11" });
    expect(meetingsConflict(first, second)).toBe(false);
  });

  test("half-semester sections in the same half do collide", () => {
    const a = meeting({ from: "2026-08-24", to: "2026-10-16" });
    const b = meeting({ from: "2026-09-01", to: "2026-10-16" });
    expect(meetingsConflict(a, b)).toBe(true);
  });

  test("missing dates are treated as a possible clash, not a safe one", () => {
    expect(meetingsConflict(meeting({ from: "", to: "" }), meeting())).toBe(true);
  });

  test("finds every clashing pair in a schedule", () => {
    const morning = offering("CS-3310", [meeting()]);
    const clashes = offering("CY-3320", [meeting({ start: 510, end: 570 })]);
    const afternoon = offering("MATH-2740", [meeting({ start: 13 * 60, end: 14 * 60 })]);

    expect(conflicts([morning, afternoon])).toHaveLength(0);
    expect(conflicts([morning, clashes, afternoon])).toHaveLength(1);
    expect(fits(afternoon, [morning, clashes])).toBe(true);
    expect(fits(clashes, [morning])).toBe(false);
  });

  test("compares every meeting of a section, not just the first", () => {
    const lecture = offering("EGCP-3010", [
      meeting({ days: [1, 3], start: 8 * 60, end: 9 * 60 }),
      meeting({ days: [4], start: 14 * 60, end: 17 * 60, room: "Lab" }),
    ]);
    const clashesWithLabOnly = offering("PHYS-2110", [
      meeting({ days: [4], start: 15 * 60, end: 16 * 60 }),
    ]);
    expect(conflictsBetween(lecture, clashesWithLabOnly)).toHaveLength(1);
  });
});

describe("building offerings from a response", () => {
  const section = (over: Partial<Section> = {}): Section =>
    ({
      Id: "s1",
      CourseId: "c1",
      CourseName: "CS-3310",
      Number: "01",
      Title: "Algorithms",
      Synonym: "12345",
      TermId: "26/FA",
      MinimumCredits: 3,
      MaximumCredits: null,
      Capacity: 30,
      Enrolled: 28,
      Available: 2,
      Waitlisted: 0,
      AvailabilityStatus: "Open",
      IsNonStandardDates: false,
      StartDate: "2026-08-24T00:00:00",
      EndDate: "2026-12-11T00:00:00",
      Meetings: [],
      FormattedMeetingTimes: [],
      ...over,
    }) as Section;

  const structured = {
    Days: ["Monday", "Wednesday", "Friday"],
    StartTime: "2026-08-24T08:00:00",
    EndTime: "2026-08-24T08:50:00",
    StartDate: "2026-08-24T00:00:00",
    EndDate: "2026-12-11T00:00:00",
    Room: "234",
    Frequency: "W",
    IsOnline: false,
    InstructionalMethodCode: "LEC",
  };

  test("reads a structured meeting", () => {
    const o = toOffering(section({ Meetings: [structured] }), ["Dr Who"]);
    expect(o.meetings).toHaveLength(1);
    expect(o.meetings[0]).toMatchObject({ days: [1, 3, 5], start: 480, end: 530 });
    expect(o.instructors).toEqual(["Dr Who"]);
    expect(o.seats.available).toBe(2);
  });

  // Observed in the spec: Meetings[].StartTime comes back null and the time
  // only exists on the display twin.
  test("falls back to the display times when the structured ones are null", () => {
    const o = toOffering(
      section({
        Meetings: [{ ...structured, StartTime: null, EndTime: null, Days: [] }],
        FormattedMeetingTimes: [
          {
            ...structured,
            StartTime: null,
            EndTime: null,
            Days: [],
            StartTimeDisplay: "8:00 AM",
            EndTimeDisplay: "8:50 AM",
            DaysOfWeekDisplay: "M, W, F",
            BuildingDisplay: "ENS",
            RoomDisplay: "234",
            DatesDisplay: "",
          },
        ],
      }),
    );
    expect(o.meetings[0]).toMatchObject({ days: [1, 3, 5], start: 480, end: 530 });
    expect(o.meetings[0]!.room).toBe("ENS 234");
  });

  test("an asynchronous online section has no placeable meeting", () => {
    const o = toOffering(
      section({ Meetings: [{ ...structured, Days: [], StartTime: null, EndTime: null }] }),
    );
    expect(o.meetings).toHaveLength(0);
    // Nothing to collide with, so it fits any schedule.
    expect(fits(o, [offering("CS-1210", [meeting()])])).toBe(true);
  });

  test("flattens the term wrapper Colleague puts around sections", () => {
    const response = {
      SectionsRetrieved: {
        Course: {},
        TermsAndSections: [
          {
            Term: { Code: "26/FA", Description: "Fall 2026" },
            Sections: [
              {
                Section: section({ Meetings: [structured] }),
                FacultyDisplay: "Dr Who",
                InstructorDetails: [{ FacultyId: "1", FacultyName: "Dr Who" }],
              },
            ],
          },
        ],
      },
    } as unknown as SectionsResponse;

    const offerings = offeringsFrom(response);
    expect(offerings).toHaveLength(1);
    expect(offerings[0]!.instructors).toEqual(["Dr Who"]);
  });

  test("an empty response yields nothing rather than throwing", () => {
    expect(offeringsFrom({} as SectionsResponse)).toEqual([]);
  });
});

describe("laying out a week", () => {
  test("groups by weekday and sorts by start time", () => {
    const early = offering("A", [meeting({ days: [1], start: 8 * 60, end: 9 * 60 })]);
    const late = offering("B", [meeting({ days: [1], start: 13 * 60, end: 14 * 60 })]);
    const tuesday = offering("C", [meeting({ days: [2], start: 10 * 60, end: 11 * 60 })]);

    const grid = week([late, early, tuesday]);
    expect(grid.map((c) => c.day)).toEqual([1, 2]);
    expect(grid[0]!.items.map((i) => i.offering.courseName)).toEqual(["A", "B"]);
  });

  test("span covers the whole schedule, and is null when nothing meets", () => {
    expect(span([offering("A", [meeting({ start: 480, end: 530 })])])).toEqual({
      start: 480,
      end: 530,
    });
    expect(span([offering("A", [])])).toBeNull();
  });

  test("formats times the way a human reads a timetable", () => {
    expect(formatTime(480)).toBe("8:00am");
    expect(formatTime(720)).toBe("12:00pm");
    expect(formatTime(13 * 60 + 5)).toBe("1:05pm");
    expect(formatTime(0)).toBe("12:00am");
  });
});
