import { describe, expect, test } from "bun:test";
import type { CatalogCourseRecord } from "./catalog";
import { sequencesFrom } from "./sequences";

const course = (
  code: string,
  Title: string,
  over: Partial<CatalogCourseRecord> = {},
): CatalogCourseRecord => {
  const [SubjectCode = "", number = ""] = code.split("-");
  return {
    Id: code,
    SubjectCode,
    Number: number,
    Title,
    MinimumCredits: 3,
    ...over,
  } as unknown as CatalogCourseRecord;
};

const requires = (code: string) => ({
  CourseRequisites: [
    {
      DisplayText: `Take ${code}`,
      DisplayTextExtension: "- Must be completed prior to taking this course.",
      IsRequired: true,
    },
  ],
});

describe("finding the courses that run back to back", () => {
  test("believes a description that names what it continues", () => {
    const pairs = sequencesFrom([
      course("CY-4810", "Secure Software Engr I", { TermsOffered: "Fall Only" }),
      course("CY-4820", "Secure Software Engr II", {
        TermsOffered: "Spring Only",
        Description: "Continuation of CY-4810 Secure Software Engineering I. Student teams will…",
        ...requires("CY-4810"),
      }),
    ]);
    expect(pairs.get("CY-4820")).toBe("CY-4810");
  });

  /* The colloquium carries no requisite at all; only the numeral pairs them. */
  test("pairs a I with its II when nothing else does", () => {
    const pairs = sequencesFrom([
      course("HON-4910", "Honors Sr Colloq I"),
      course("HON-4920", "Honors Sr Colloq II"),
    ]);
    expect(pairs.get("HON-4920")).toBe("HON-4910");
  });

  test("but not across subjects that happen to share a name", () => {
    const pairs = sequencesFrom([
      course("ART-1000", "Studio Seminar I"),
      course("BIO-2000", "Studio Seminar II"),
    ]);
    expect(pairs.size).toBe(0);
  });

  /*
   * Making of the Modern Mind says it only by how it is taught: one autumn
   * course, one spring course waiting on it, one name across the two.
   */
  test("reads a pair out of the seasons and the shared name", () => {
    const pairs = sequencesFrom([
      course("HON-1010", "Making Mod Mind: Cl Antiquity", { TermsOffered: "Fall Only" }),
      course("HON-1020", "Making Mod Mind: Ren/Reform", {
        TermsOffered: "Spring Only",
        ...requires("HON-1010"),
      }),
    ]);
    expect(pairs.get("HON-1020")).toBe("HON-1010");
  });

  test("and leaves a plain prerequisite alone", () => {
    // General Ecology waits on General Botany and is not its second half. The
    // shared-name test is what tells them apart.
    const pairs = sequencesFrom([
      course("BIO-2500", "General Botany", { TermsOffered: "Fall Only" }),
      course("BIO-2600", "General Ecology", {
        TermsOffered: "Spring Only",
        ...requires("BIO-2500"),
      }),
    ]);
    expect(pairs.size).toBe(0);
  });

  test("leaves a course taught every term alone, since waiting costs it nothing", () => {
    const pairs = sequencesFrom([
      course("MATH-1705", "Calculus: Concepts"),
      course("MATH-1715", "Calculus: Methods", { ...requires("MATH-1705") }),
    ]);
    expect(pairs.size).toBe(0);
  });
});
