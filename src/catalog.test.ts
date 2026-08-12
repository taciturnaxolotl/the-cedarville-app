import { describe, expect, test } from "bun:test";
import type { ListingSection } from "./catalog";
import {
  ageInHours,
  compareTerms,
  emptyCatalog,
  forCourses,
  isStale,
  runsIn,
  seasonsOffered,
  shortTerm,
  type TermCatalog,
  yearsOffered,
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

describe("when the registrar says a course runs", () => {
  test("reads every spelling the catalog uses", () => {
    // Seven spellings cover all 1,945 courses that state one.
    expect(seasonsOffered({ TermsOffered: "Fall/Spring" })).toEqual(["fall", "spring"]);
    expect(seasonsOffered({ TermsOffered: "Spring Only" })).toEqual(["spring"]);
    expect(seasonsOffered({ TermsOffered: "Fall Only" })).toEqual(["fall"]);
    expect(seasonsOffered({ TermsOffered: "Fall/Spring/Summer" })).toEqual([
      "fall",
      "spring",
      "summer",
    ]);
    expect(seasonsOffered({ TermsOffered: "Summer Only" })).toEqual(["summer"]);
  });

  test("silence is not a refusal", () => {
    // 82 courses state nothing, and reading that as "never" strands them.
    expect(seasonsOffered({})).toEqual([]);
    expect(seasonsOffered({ TermsOffered: "" })).toEqual([]);
  });
});

describe("courses that run in alternate years", () => {
  test("reads the cycle", () => {
    expect(yearsOffered({ YearsOffered: "All Years" })).toBe("all");
    expect(yearsOffered({ YearsOffered: "Odd Years (ex: 2021-22)" })).toBe("odd");
    expect(yearsOffered({ YearsOffered: "Even Years (ex: 2020-21)" })).toBe("even");
    expect(yearsOffered({})).toBe("all");
  });

  test("an academic year is named for the autumn that opens it", () => {
    // CRJU-4160 runs spring of odd academic years: spring 2028 sits in
    // 2027-28, so it runs; spring 2029 sits in 2028-29, so it does not.
    expect(runsIn("odd", 2028, "spring")).toBe(true);
    expect(runsIn("odd", 2029, "spring")).toBe(false);
    expect(runsIn("odd", 2027, "fall")).toBe(true);
    expect(runsIn("odd", 2028, "fall")).toBe(false);
  });

  test("a course taught every year runs whenever", () => {
    expect(runsIn("all", 2028, "spring")).toBe(true);
    expect(runsIn("all", 2029, "fall")).toBe(true);
  });
});
