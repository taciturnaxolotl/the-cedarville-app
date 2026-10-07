/*
 * Reading what Colleague actually sent.
 *
 * Every shape in this file is one the application met in the wild rather than
 * one anybody designed, so the tests are mostly a record of what has already
 * gone wrong once.
 */

import { describe, expect, test } from "bun:test";
import { programsIn } from "./client";
import type { ProgramSummary } from "./types";

const program = (code: string, active = true) =>
  ({
    Code: code,
    Title: `${code} program`,
    Degree: "BS",
    AcademicLevelCode: "UG",
    Majors: [],
    Minors: [],
    IsActive: active,
  }) as ProgramSummary;

describe("the program list, however it arrives", () => {
  test("takes the bare array it was written against", () => {
    const list = [program("BS.CS"), program("BS.CYOPR")];
    expect(programsIn(list)).toEqual(list);
  });

  /*
   * The bug this exists for: the planner said "list.filter is not a function",
   * which is a TypeError standing where a sentence should be. Whatever
   * Colleague wraps the list in, a list of programs is still in there.
   */
  test("unwraps whatever property the list arrived inside", () => {
    const list = [program("BS.CS")];
    expect(programsIn({ Programs: list })).toEqual(list);
    expect(programsIn({ ActivePrograms: list })).toEqual(list);
    expect(programsIn({ Items: list, TotalItems: 1 })).toEqual(list);
  });

  test("ignores the arrays that are not programs", () => {
    const list = [program("BS.CS")];
    expect(programsIn({ AcademicLevels: ["UG", "GR"], Programs: list })).toEqual(list);
  });

  test("an answer with one empty array is an empty answer", () => {
    expect(programsIn({ Programs: [] })).toEqual([]);
  });

  /*
   * And when it is none of those, the error has to carry the one thing the
   * next reader needs, which is what actually arrived.
   */
  test("names the keys it was given rather than throwing a TypeError", () => {
    expect(() => programsIn({ Error: "unauthorised", Status: 401 })).toThrow(
      /object rather than a list \(Error, Status\)/,
    );
    expect(() => programsIn({ Programs: {}, Other: 2 })).toThrow(/Programs, Other/);
  });

  test("says so when the answer is not an object at all", () => {
    expect(() => programsIn("<html>sign in</html>")).toThrow(/string, not a list/);
    expect(() => programsIn(null)).toThrow(/object, not a list/);
    expect(() => programsIn(undefined)).toThrow(/undefined, not a list/);
  });
});
