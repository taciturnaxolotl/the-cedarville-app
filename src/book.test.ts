import { describe, expect, test } from "bun:test";
import {
  absorbed,
  creditCeiling,
  genEdCredits,
  impliedOverlap,
  matchProgram,
  type ProgramPage,
  parseProgramPage,
  totalCredits,
} from "./book";

/**
 * Every fixture below is transcribed from the 2025-26 undergraduate catalog,
 * dot leaders and all, because the dot leaders are what the parser reads.
 */

const CYBER = `
Cyber Operations — Bachelor of Science Course requirements for the Bachelor of
Science degree with a major in cyber operations involve 79-82 semester hours
including: CS-1210 Introduction to Programming Using C++....................3
CY-4820 Secure Software Engineering II................................4
EGCP-1010 Digital Logic Design...............................................3
Cyber Operations Major Curriculum Summary
Proficiency Requirements..........................................................0–4
General Education Requirements.............................................41.5
Cyber Operations Major Requirements...................................64-67
Required Cognates......................................................................15
Electives................................................................................ 4.5-7.5
Total (minimum, not including proficiency)...........................128
A complete description of the general education requirements is found on page 24.
Suggested Four-Year Curriculum for a Major in Cyber Operations
First Year: CS-1210 Introduction to Programming Using C++.............................3
EGCP-1010 Digital Logic Design........................................................3
Total................................................................................................. 6
Second Year: CY-4820 Secure Software Engineering II.................................4
Total................................................................................................. 4
Made with FlippingBook
`;

const COMPUTER_ENGINEERING = `
CS-1210 Introduction to Programming Using C++.........................3
EGCP-4820 Computer Engineering Senior Design II...................3
1EGGN-3110 Professional Ethics....................................................3
EGGN-4010 Senior Seminar..........................................................0
*Capstone Course 1Satisfies humanities general education requirements
Required Cognates ...................................................................29
3GBIO-1000 Principles of Biology...........................................3.5
4CHEM-1050 Chemistry for Engineers...................................3.5
5MATH-1705 Calculus I.............................................................4
3Satisfies biological science general education requirements
4Satisfies physical science general education requirements
5Satisfies mathematics general education requirements
Computer Engineering Major Curriculum Summary
Proficiency Requirements..........................................................0–4
General Education Requirements................................................38
Comprehensive Computer Engineering Requirements................65
Required Cognates......................................................................29
Total (minimum, not including proficiency)...........................132
A complete description of the general education requirements is found on page 24.
Made with FlippingBook
`;

/**
 * On roughly a third of the pages the summary is followed immediately by the
 * program's requirement list, set in the same style. Reading past the Total
 * turned a 128-credit degree into a 441-credit one.
 */
const SUMMARY_THEN_LIST = `
Accounting Major Curriculum Summary
General Education Requirements................................................48
Accounting Major Requirements.................................................70
Required Cognate........................................................................3
Electives.......................................................................................7
Total (minimum, not including proficiency)...........................128
The course plan includes the following:
ACCT-4150 Government and Nonprofit Accounting.....................3
BUS-2100 Business Communication............................................3
Made with FlippingBook
`;

const cyber = parseProgramPage(156, CYBER)!;
const cpe = parseProgramPage(151, COMPUTER_ENGINEERING)!;

describe("reading a program page", () => {
  test("names the program from its summary heading", () => {
    expect(cyber.title).toBe("Cyber Operations");
    expect(cpe.title).toBe("Computer Engineering");
  });

  test("reads every summary line, ranges included", () => {
    expect(cyber.summary).toContainEqual({
      label: "Proficiency Requirements",
      min: 0,
      max: 4,
    });
    expect(cyber.summary).toContainEqual({
      label: "General Education Requirements",
      min: 41.5,
      max: 41.5,
    });
    expect(cyber.summary).toContainEqual({ label: "Electives", min: 4.5, max: 7.5 });
    expect(totalCredits(cyber)).toBe(128);
    expect(genEdCredits(cyber)).toBe(41.5);
  });

  test("stops at the Total rather than reading the requirement list after it", () => {
    const accounting = parseProgramPage(110, SUMMARY_THEN_LIST)!;
    expect(totalCredits(accounting)).toBe(128);
    expect(accounting.summary.map((l) => l.label)).not.toContain(
      "ACCT-4150 Government and Nonprofit Accounting",
    );
  });

  test("ignores a page with no curriculum summary", () => {
    expect(parseProgramPage(5, "Founders Hall Milner Hall Chick-fil-A")).toBeUndefined();
  });

  test("ignores a heading with no total under it", () => {
    expect(
      parseProgramPage(102, "Nursing Curriculum Summary Clinical Hours......12"),
    ).toBeUndefined();
  });
});

describe("courses the catalog counts twice", () => {
  test("pairs a footnote marker with its definition", () => {
    expect(cpe.doubleCounts).toEqual([
      { course: "EGGN-3110", requirement: "humanities" },
      { course: "GBIO-1000", requirement: "biological science" },
      { course: "CHEM-1050", requirement: "physical science" },
      { course: "MATH-1705", requirement: "mathematics" },
    ]);
  });

  test("a credit value is not a footnote marker", () => {
    // "Senior Seminar..........0 EGME-1810" must not read as footnote 0.
    expect(cpe.doubleCounts.map((d) => d.course)).not.toContain("EGME-1810");
  });

  test("sums the credits the registrar declared as shared", () => {
    const credits = (c: string) =>
      ({ "EGGN-3110": 3, "GBIO-1000": 3.5, "CHEM-1050": 3.5, "MATH-1705": 4 })[c] ?? 0;
    expect(absorbed(cpe, credits)).toBe(14);
  });

  test("cyber operations declares none, which is the finding", () => {
    expect(cyber.doubleCounts).toEqual([]);
    expect(impliedOverlap(cyber)).toBe(0);
  });

  test("infers overlap from arithmetic when no footnote says so", () => {
    // Middle Childhood Education: 48 + 14 + 32 + 44.5 parts against 133.
    const page = parseProgramPage(
      133,
      `Middle Childhood Education Major Curriculum Summary
       General Education Requirements....48
       Teacher Education Program Pre-requisites....14
       Program Requirements....32
       Professional Content Requirements....44.5
       Total (minimum, not including proficiency)....133`,
    )!;
    expect(impliedOverlap(page)).toBe(5.5);
  });
});

describe("the ceiling a plan must not exceed", () => {
  test("widens by the slack the summary itself prints", () => {
    // 64-67 gives 3, 4.5-7.5 gives 3, so 128 + 6.
    expect(creditCeiling(cyber)).toBe(134);
  });

  test("proficiency sits outside the total and so outside the ceiling", () => {
    // The 0–4 proficiency range must not widen it; 132 with no other range.
    expect(creditCeiling(cpe)).toBe(132);
  });
});

describe("the suggested sequence", () => {
  test("splits by year and keeps the printed total", () => {
    expect(cyber.sequence).toHaveLength(2);
    expect(cyber.sequence[0]).toMatchObject({ year: 1, total: 6 });
    expect(cyber.sequence[0]?.entries.map((e) => e.code)).toEqual(["CS-1210", "EGCP-1010"]);
    expect(cyber.sequence[1]).toMatchObject({ year: 2, total: 4 });
  });

  test("keeps placeholders that name no course", () => {
    const page = parseProgramPage(
      1,
      `X Curriculum Summary Total....128
       Suggested Four-Year Curriculum for a Major in X
       First Year: History Elective..................................3
       Total.......................................................................3
       Made with FlippingBook`,
    )!;
    expect(page.sequence[0]?.entries[0]).toEqual({
      code: undefined,
      text: "History Elective",
      credits: 3,
    });
  });
});

describe("matching a page to a program", () => {
  const pages = [cyber, cpe];

  test("matches on the courses named, not the title", () => {
    const required = new Set(cpe.courses);
    expect(matchProgram(pages, required)?.page).toBe(151);
  });

  test("declines when nothing overlaps enough", () => {
    expect(matchProgram(pages, new Set(["MUS-1000", "MUS-2000"]))).toBeUndefined();
  });

  test("declines on an empty requirement set", () => {
    expect(matchProgram(pages, new Set())).toBeUndefined();
  });

  test("prefers the page that shares proportionally more, not merely more", () => {
    // A page listing the whole book would otherwise win on raw overlap alone.
    const everything: ProgramPage = {
      ...cyber,
      page: 999,
      courses: [
        ...new Set([
          ...cyber.courses,
          ...cpe.courses,
          ...Array.from({ length: 400 }, (_, i) => `ZZ-${1000 + i}`),
        ]),
      ].sort(),
    };
    expect(matchProgram([everything, cpe], new Set(cpe.courses))?.page).toBe(151);
  });
});
