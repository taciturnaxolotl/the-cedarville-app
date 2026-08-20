import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { CEILING, DEFAULT_LOAD, FULL_TIME, readLoad, SUMMERS, verdictOf, writeLoad } from "./load";

const window = new Window();
Object.assign(globalThis, { localStorage: window.localStorage });

describe("what the school calls a term of this size", () => {
  // Every threshold is from the 2026-27 catalog, page 26.
  test("below twelve hours a student is part time", () => {
    expect(verdictOf(FULL_TIME - 0.5).text).toBe("part time");
    expect(verdictOf(FULL_TIME).text).not.toBe("part time");
  });

  test("fifteen to seventeen is the load the catalog calls normal", () => {
    expect(verdictOf(15).text).toBe("a normal load");
    expect(verdictOf(17).text).toBe("a normal load");
  });

  test("above seventeen costs overblock tuition", () => {
    // Not eighteen, which is the number everyone remembers.
    expect(verdictOf(17).text).not.toContain("overblock");
    expect(verdictOf(17.5).text).toBe("overblock tuition");
  });

  test("twelve to fifteen is full time but under a normal load", () => {
    expect(verdictOf(13).text).toBe("full time, under a normal load");
  });
});

describe("remembering a load", () => {
  const load = { perTerm: 16.5, summer: 4, summers: 2, fullSemesters: false };

  test("round trips", () => {
    writeLoad(load);
    expect(readLoad()).toEqual(load);
  });

  test("falls back when nothing has been stored", () => {
    localStorage.removeItem("cedarville:load");
    expect(readLoad()).toEqual(DEFAULT_LOAD);
  });

  test("clamps a stored value that is out of range", () => {
    // Written by an older build, or by hand.
    localStorage.setItem(
      "cedarville:load",
      JSON.stringify({ perTerm: 40, summer: -3, summers: 9 }),
    );
    expect(readLoad()).toMatchObject({ perTerm: CEILING, summer: 0, summers: SUMMERS });
  });

  test("a load written before summers were countable keeps its answer", () => {
    // Zero credits a summer was the only way to say "no summers", and a
    // student who said it should not find four of them planned.
    localStorage.setItem("cedarville:load", JSON.stringify({ perTerm: 15, summer: 0 }));
    expect(readLoad().summers).toBe(0);

    localStorage.setItem("cedarville:load", JSON.stringify({ perTerm: 15, summer: 7 }));
    expect(readLoad().summers).toBe(SUMMERS);
  });

  test("survives a corrupt entry rather than throwing", () => {
    localStorage.setItem("cedarville:load", "not json");
    expect(readLoad()).toEqual(DEFAULT_LOAD);
    localStorage.removeItem("cedarville:load");
  });
});
