import { describe, expect, test } from "bun:test";
import type { ListingSection } from "./catalog";
import {
  ageInHours,
  compareTerms,
  emptyCatalog,
  forCourses,
  isStale,
  shortTerm,
  type TermCatalog,
} from "./catalog";

const HOUR = 3_600_000;
const at = (iso: string, sections = 1): TermCatalog => ({
  term: "2026FA",
  fetchedAt: iso,
  sections: Array.from({ length: sections }, (_, i) => ({ Id: `s${i}` }) as ListingSection),
});

describe("staleness", () => {
  test("age is measured from the fetch stamp", () => {
    const c = at("2026-08-12T00:00:00.000Z");
    expect(ageInHours(c, Date.parse("2026-08-12T06:00:00.000Z"))).toBe(6);
  });

  test("an empty catalog is always stale", () => {
    expect(isStale(emptyCatalog("2026FA"))).toBe(true);
    expect(isStale(at(new Date().toISOString(), 0))).toBe(true);
  });

  /**
   * The refresh timer must tick well inside the staleness window. A crawl
   * takes time, so its stamp lands after the tick that started it; if the
   * two intervals match, the catalog is always a few seconds too young when
   * the timer fires and the effective cadence silently doubles.
   */
  test("a tick at exactly the max age does not refresh", () => {
    const boot = Date.parse("2026-08-12T00:00:00.000Z");
    const finishedCrawling = at(new Date(boot + 30_000).toISOString());

    expect(isStale(finishedCrawling, 6, boot + 6 * HOUR)).toBe(false);
    // Which is why the server ticks every 30 minutes instead.
    expect(isStale(finishedCrawling, 6, boot + 6.5 * HOUR)).toBe(true);
  });
});

describe("narrowing", () => {
  test("keeps only sections whose course was asked for", () => {
    const catalog: TermCatalog = {
      term: "2026FA",
      fetchedAt: new Date().toISOString(),
      sections: [
        { Id: "a", CourseId: "1" } as ListingSection,
        { Id: "b", CourseId: "2" } as ListingSection,
      ],
    };
    expect(forCourses(catalog, new Set(["2"])).map((s) => s.Id)).toEqual(["b"]);
    expect(forCourses(catalog, new Set())).toEqual([]);
  });
});

describe("ordering terms", () => {
  test("an academic year runs spring, summer, autumn", () => {
    // The alphabet says FA, SP, SU — which puts autumn before the spring
    // that preceded it and reads as a year of school in the wrong order.
    expect(["2026FA", "2026SU", "2026SP"].sort(compareTerms)).toEqual([
      "2026SP",
      "2026SU",
      "2026FA",
    ]);
  });

  test("years come before seasons", () => {
    expect(["2026SP", "2025FA"].sort(compareTerms)).toEqual(["2025FA", "2026SP"]);
  });

  test("newest first is the same comparator, negated", () => {
    expect(["2025FA", "2026SP", "2026FA"].sort((a, b) => compareTerms(b, a))).toEqual([
      "2026FA",
      "2026SP",
      "2025FA",
    ]);
  });

  test("shortens a term the way the projection writes one", () => {
    expect(shortTerm("2026SP")).toBe("SP26");
    expect(shortTerm("2025FA")).toBe("FA25");
  });

  test("an unrecognised season sorts last within its year rather than throwing", () => {
    expect(["2026XX", "2026FA"].sort(compareTerms)).toEqual(["2026FA", "2026XX"]);
  });
});
