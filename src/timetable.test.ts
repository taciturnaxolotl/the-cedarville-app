/*
 * The section arranger.
 *
 * Each case is a judgement the arranger makes on a student's behalf, so each
 * is written as the sentence the student would say: not that 8am section, not
 * a five-day week, not a class I cannot get into, and not without the one I
 * already chose.
 */

import { describe, expect, test } from "bun:test";
import type { Offering, Weekday } from "./schedule";
import { arrange, spread } from "./timetable";

let next = 0;

/** A section, named by its course and number, meeting when told to. */
const sectionOf = (
  code: string,
  number: string,
  meets: { days: Weekday[]; start: number; end: number }[],
  seats = 10,
): Offering => ({
  id: `${code}-${number}-${next++}`,
  courseId: code,
  courseName: code,
  number,
  title: code,
  synonym: "0",
  term: "2027SP",
  credits: { min: 3 },
  seats: { capacity: 30, enrolled: 30 - seats, available: seats, waitlisted: 0, status: "Open" },
  instructors: [],
  meetings: meets.map((m) => ({
    days: m.days,
    start: m.start,
    end: m.end,
    from: "2027-01-12",
    to: "2027-04-30",
    room: "100",
    online: false,
  })),
  nonStandardDates: false,
});

const at = (hour: number) => hour * 60;
const MW: Weekday[] = [1, 3];
const TR: Weekday[] = [2, 4];
const MWF: Weekday[] = [1, 3, 5];

const numbersOf = (chosen: Map<string, Offering>) =>
  Object.fromEntries([...chosen].map(([code, o]) => [code, o.number]));

describe("spread", () => {
  test("counts the days used and the time spent waiting between classes", () => {
    const nine = sectionOf("A", "01", [{ days: MW, start: at(9), end: at(9) + 50 }]);
    const one = sectionOf("B", "01", [{ days: MW, start: at(13), end: at(13) + 50 }]);
    const week = spread([nine, one]);

    expect(week.days).toBe(2);
    // 9:50 to 1:00 is 190 minutes, on each of two days.
    expect(week.gapMinutes).toBe(380);
    expect(week.earliestStart).toBe(at(9));
    expect(week.latestEnd).toBe(at(13) + 50);
  });

  test("a week with no scheduled meeting has no edges to report", () => {
    const online = sectionOf("A", "01", []);
    expect(spread([online])).toEqual({
      days: 0,
      gapMinutes: 0,
      earliestStart: 0,
      latestEnd: 0,
    });
  });
});

describe("arrange", () => {
  test("takes the pair that does not collide, not the first of each", () => {
    // Both courses list a nine o'clock Monday section first, and a greedy
    // pass that takes them in order paints itself into a corner.
    const arranged = arrange([
      {
        code: "CS-1210",
        offerings: [
          sectionOf("CS-1210", "01", [{ days: MW, start: at(9), end: at(9) + 50 }]),
          sectionOf("CS-1210", "02", [{ days: MW, start: at(11), end: at(11) + 50 }]),
        ],
      },
      {
        code: "MATH-1710",
        offerings: [sectionOf("MATH-1710", "01", [{ days: MW, start: at(9), end: at(9) + 50 }])],
      },
    ]);

    expect(arranged.unplaced).toEqual([]);
    expect(numbersOf(arranged.chosen)).toEqual({ "CS-1210": "02", "MATH-1710": "01" });
  });

  test("a pinned section is kept even when it costs another course its place", () => {
    const pin = sectionOf("CS-1210", "01", [{ days: MW, start: at(9), end: at(9) + 50 }]);
    const arranged = arrange(
      [
        { code: "CS-1210", offerings: [pin] },
        {
          code: "MATH-1710",
          offerings: [sectionOf("MATH-1710", "01", [{ days: MW, start: at(9), end: at(9) + 50 }])],
        },
      ],
      { pinned: new Set([pin.id]) },
    );

    expect(arranged.chosen.get("CS-1210")).toBe(pin);
    expect(arranged.unplaced).toEqual([
      { code: "MATH-1710", why: "every section clashes with a section you pinned" },
    ]);
  });

  test("a course with no section this term is reported, not silently dropped", () => {
    const arranged = arrange([
      { code: "CS-1210", offerings: [] },
      {
        code: "MATH-1710",
        offerings: [sectionOf("MATH-1710", "01", [{ days: MW, start: at(9), end: at(9) + 50 }])],
      },
    ]);

    expect(arranged.unplaced).toEqual([
      { code: "CS-1210", why: "no section is offered this term" },
    ]);
    expect(arranged.chosen.has("MATH-1710")).toBe(true);
  });

  // A free day is worth more than a tidy hour, and students say so.
  test("prefers the week that keeps a day clear", () => {
    const arranged = arrange([
      {
        code: "A",
        offerings: [sectionOf("A", "01", [{ days: MW, start: at(9), end: at(9) + 50 }])],
      },
      {
        code: "B",
        offerings: [
          sectionOf("B", "spread", [{ days: TR, start: at(9), end: at(9) + 50 }]),
          sectionOf("B", "same-days", [{ days: MW, start: at(10), end: at(10) + 50 }]),
        ],
      },
    ]);

    expect(arranged.chosen.get("B")?.number).toBe("same-days");
    expect(arranged.days).toBe(2);
  });

  test("prefers a section you can get into over one that is full", () => {
    const arranged = arrange([
      {
        code: "A",
        offerings: [
          sectionOf("A", "full", [{ days: MW, start: at(9), end: at(9) + 50 }], 0),
          sectionOf("A", "open", [{ days: MW, start: at(14), end: at(14) + 50 }], 4),
        ],
      },
    ]);

    expect(arranged.chosen.get("A")?.number).toBe("open");
    expect(arranged.full).toBe(0);
  });

  test("a full section is still better than no section at all", () => {
    const arranged = arrange([
      {
        code: "A",
        offerings: [sectionOf("A", "full", [{ days: MW, start: at(9), end: at(9) + 50 }], 0)],
      },
    ]);

    expect(arranged.chosen.get("A")?.number).toBe("full");
    expect(arranged.full).toBe(1);
    expect(arranged.unplaced).toEqual([]);
  });

  test("asked to finish early, it finishes early", () => {
    const choices = [
      {
        code: "A",
        offerings: [
          sectionOf("A", "morning", [{ days: MWF, start: at(8), end: at(8) + 50 }]),
          sectionOf("A", "evening", [{ days: MWF, start: at(18), end: at(18) + 50 }]),
        ],
      },
    ];
    expect(arrange(choices, { shape: "early" }).chosen.get("A")?.number).toBe("morning");
    expect(arrange(choices, { shape: "late" }).chosen.get("A")?.number).toBe("evening");
  });

  test("the same question twice gives the same answer", () => {
    const choices = [
      {
        code: "A",
        offerings: [
          sectionOf("A", "01", [{ days: MW, start: at(9), end: at(9) + 50 }]),
          sectionOf("A", "02", [{ days: MW, start: at(10), end: at(10) + 50 }]),
        ],
      },
      {
        code: "B",
        offerings: [
          sectionOf("B", "01", [{ days: TR, start: at(9), end: at(9) + 50 }]),
          sectionOf("B", "02", [{ days: TR, start: at(10), end: at(10) + 50 }]),
        ],
      },
    ];
    const once = numbersOf(arrange(choices).chosen);
    const twice = numbersOf(arrange(choices).chosen);
    expect(twice).toEqual(once);
  });

  test("an online section with no meeting time always has a place", () => {
    const arranged = arrange([
      {
        code: "A",
        offerings: [sectionOf("A", "01", [{ days: MW, start: at(9), end: at(9) + 50 }])],
      },
      { code: "ONLINE", offerings: [sectionOf("ONLINE", "70", [])] },
    ]);

    expect(arranged.unplaced).toEqual([]);
    expect(arranged.chosen.size).toBe(2);
  });

  test("searches a five course term to exhaustion", () => {
    const choices = ["A", "B", "C", "D", "E"].map((code, i) => ({
      code,
      offerings: [8, 10, 13, 15].map((hour) =>
        sectionOf(code, `${hour}`, [
          { days: i % 2 === 0 ? MW : TR, start: at(hour), end: at(hour) + 50 },
        ]),
      ),
    }));
    const arranged = arrange(choices);

    expect(arranged.exhaustive).toBe(true);
    expect(arranged.unplaced).toEqual([]);
    expect(arranged.chosen.size).toBe(5);
  });

  test("gives up on time rather than hanging the tab", () => {
    // Twelve courses of six sections each is 2.1 billion weeks; the budget is
    // what makes asking for it safe.
    const choices = Array.from({ length: 12 }, (_, i) => ({
      code: `C${i}`,
      offerings: Array.from({ length: 6 }, (_, j) =>
        sectionOf(`C${i}`, `${j}`, [{ days: MW, start: at(8) + j * 70, end: at(8) + j * 70 + 50 }]),
      ),
    }));
    const arranged = arrange(choices, { budget: 500 });

    expect(arranged.exhaustive).toBe(false);
    expect(arranged.explored).toBeLessThanOrEqual(501);
  });
});
