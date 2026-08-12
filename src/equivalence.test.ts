import { describe, expect, test } from "bun:test";
import { aliasesOf, buildEquivalences, satisfiedBy } from "./equivalence";

const codeForId = (id: string) => ({ "42": "MATH-2210", "43": "COM-1120" })[id];

describe("course equivalence", () => {
  test("reads old-style keys as course codes", () => {
    // ENGR_191 is how Colleague writes what the catalog calls ENGR-1910.
    const eq = buildEquivalences([{ code: "EGCP-1010", equatedIds: ["ENGR_191"] }], codeForId);
    expect(aliasesOf(eq, "ENGR-1910").sort()).toEqual(["EGCP-1010", "ENGR-1910"]);
  });

  test("resolves numeric ids against the catalog", () => {
    const eq = buildEquivalences([{ code: "MATH-3210", equatedIds: ["42"] }], codeForId);
    expect(aliasesOf(eq, "MATH-2210")).toContain("MATH-3210");
  });

  test("equivalence runs both ways", () => {
    const eq = buildEquivalences([{ code: "THTR-1410", equatedIds: ["COM_141"] }], codeForId);
    expect(aliasesOf(eq, "COM-1410")).toContain("THTR-1410");
    expect(aliasesOf(eq, "THTR-1410")).toContain("COM-1410");
  });

  /**
   * Colleague states equivalence pairwise. Chaining it across curriculum
   * revisions would assert more than the registrar did.
   */
  test("does not chain transitively", () => {
    // Subject codes are 2-5 letters; a one-letter subject is not a real code
    // and the parser rightly ignores it.
    const eq = buildEquivalences(
      [
        { code: "BB-1000", equatedIds: ["AA_100"] },
        { code: "CC-1000", equatedIds: ["BB_100"] },
      ],
      codeForId,
    );
    expect(aliasesOf(eq, "AA-1000")).toEqual(["AA-1000", "BB-1000"]);
    expect(aliasesOf(eq, "AA-1000")).not.toContain("CC-1000");
  });

  test("an unknown id is ignored rather than invented", () => {
    const eq = buildEquivalences([{ code: "X-1000", equatedIds: ["99999", "garbage"] }], codeForId);
    expect(eq.size).toBe(0);
  });

  test("a course completed under an old code satisfies the modern one", () => {
    const eq = buildEquivalences([{ code: "EGCP-1010", equatedIds: ["ENGR_191"] }], codeForId);
    expect(satisfiedBy(eq, "EGCP-1010", new Set(["ENGR-1910"]))).toBe(true);
    expect(satisfiedBy(eq, "EGCP-1010", new Set(["CS-1210"]))).toBe(false);
    // And with no equivalence data at all it still matches itself.
    expect(satisfiedBy(new Map(), "CS-1210", new Set(["CS-1210"]))).toBe(true);
  });
});
