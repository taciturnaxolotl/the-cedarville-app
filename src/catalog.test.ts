import { describe, expect, test } from "bun:test";
import type { ListingSection } from "./catalog";
import {
  ageInHours,
  compareTerms,
  emptyCatalog,
  forCourses,
  isStale,
  nextPlannableTerm,
  runsIn,
  seasonsOffered,
  shortTerm,
  slimCatalog,
  type TermCatalog,
  termCodeOf,
  termKey,
  termNow,
  yearsOffered,
} from "./catalog";
import { offeringsFromListing } from "./schedule";

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

describe("the term happening now", () => {
  // With nothing cached and no extension installed there is no term list to
  // ask for, so a first run would offer a menu with no items in it.
  test("names the season the calendar is in", () => {
    expect(termNow(new Date("2026-08-23T12:00:00"))).toBe("2026FA");
    expect(termNow(new Date("2026-12-01T12:00:00"))).toBe("2026FA");
    expect(termNow(new Date("2027-02-14T12:00:00"))).toBe("2027SP");
    expect(termNow(new Date("2027-06-01T12:00:00"))).toBe("2027SU");
  });
});

describe("naming a term the way Colleague does", () => {
  // Our own names are short because they are read in a column; every write to
  // a degree plan is keyed on Colleague's spelling instead.
  test("year first, season second", () => {
    expect(termCodeOf({ year: 2027, season: "spring" })).toBe("2027SP");
    expect(termCodeOf({ year: 2027, season: "summer" })).toBe("2027SU");
    expect(termCodeOf({ year: 2029, season: "fall" })).toBe("2029FA");
  });

  test("and it sorts the way the catalog's own keys do", () => {
    expect(termKey(termCodeOf({ year: 2027, season: "spring" }))).toBeLessThan(
      termKey(termCodeOf({ year: 2027, season: "fall" })),
    );
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

describe("where a plan starts", () => {
  test("the term after the one under way", () => {
    // August is already autumn here, so the next thing to plan is the spring.
    expect(nextPlannableTerm(new Date("2026-08-20"))).toEqual({ year: 2027, season: "spring" });
    expect(nextPlannableTerm(new Date("2026-12-31"))).toEqual({ year: 2027, season: "spring" });
    expect(nextPlannableTerm(new Date("2027-01-02"))).toEqual({ year: 2027, season: "fall" });
    expect(nextPlannableTerm(new Date("2027-05-30"))).toEqual({ year: 2027, season: "fall" });
  });

  test("never a summer, because no degree begins in one", () => {
    for (const day of ["2026-06-15", "2026-07-04", "2026-08-01"]) {
      expect(nextPlannableTerm(new Date(day)).season).not.toBe("summer");
    }
  });
});

describe("the copy the browser keeps", () => {
  /*
   * Colleague returns about eighty fields per section and this application
   * reads eighteen of them, so a term is ten megabytes where it needs to be
   * one and a half — and a browser allows five for everything a site stores.
   * Writing the raw thing threw *after* a sixty-page crawl had succeeded.
   *
   * The invariant that makes slimming safe is not a list of field names, it
   * is that the copy kept parses into exactly the offering the raw one did.
   */
  const raw = {
    Id: "158722",
    CourseId: "1051",
    CourseName: "COM-2300",
    Number: "01",
    Title: "Voices of Diversity",
    Synonym: "7568",
    TermId: "2027SP",
    MinimumCredits: 3,
    MaximumCredits: null,
    Capacity: 50,
    Enrolled: 2,
    Available: 48,
    Waitlisted: 0,
    AvailabilityStatus: "Open",
    IsNonStandardDates: false,
    StartDate: "2027-01-05T00:00:00-05:00",
    EndDate: "2027-04-30T00:00:00-04:00",
    FacultyDisplay: ["Mr. Derrick L. Green"],
    Meetings: [
      {
        Days: [1, 3, 5],
        StartTime: "2026-10-06T19:00:00+00:00",
        EndTime: "2026-10-06T19:50:00+00:00",
        StartDate: "2027-01-05T00:00:00-05:00",
        EndDate: "2027-04-30T00:00:00-04:00",
        Room: "244",
        Frequency: "W",
        IsOnline: false,
        InstructionalMethodCode: "LEC",
      },
    ],
    FormattedMeetingTimes: [
      {
        DaysOfWeekDisplay: "M, W, F",
        StartTimeDisplay: "2:00 PM",
        EndTimeDisplay: "2:50 PM",
        BuildingDisplay: "Milner",
        Room: "244",
        DatesDisplay: "1/5/2027 - 4/30/2027",
      },
    ],
    // The fat: a whole course record inside every one of its sections, the
    // term's description repeated each time, and the catalog prose.
    Course: { Id: "1051", Description: "x".repeat(600), Title: "Voices of Diversity" },
    Term: { Code: "2027SP", Description: "Spring 2027", ReportingYear: 2027 },
    CourseDescription: "y".repeat(600),
    BookstoreUrl: "https://example.test/bookstore?section=158722",
    MeetingsDisplay: ["MWF 2:00 PM - 2:50 PM"],
  } as unknown as ListingSection;

  const catalog: TermCatalog = {
    term: "2027SP",
    fetchedAt: "2027-01-02T00:00:00.000Z",
    sections: [raw],
    courses: [
      {
        Id: "1051",
        SubjectCode: "COM",
        Number: "2300",
        Title: "Voices of Diversity",
        MinimumCredits: 3,
        TermsOffered: "Fall/Spring",
        YearsOffered: "All Years",
        Description: "z".repeat(600),
        CourseRequisites: [{ DisplayText: "Take COM-1100", IsRequired: true }],
      },
    ],
  };

  test("parses into exactly the offering the raw copy did", () => {
    const [kept] = offeringsFromListing(slimCatalog(catalog).sections);
    const [thrown] = offeringsFromListing(catalog.sections);
    expect(kept).toEqual(thrown!);
  });

  test("keeps the requisites and seasons the planner reads", () => {
    const [course] = slimCatalog(catalog).courses ?? [];
    expect(course?.CourseRequisites?.[0]?.DisplayText).toBe("Take COM-1100");
    expect(seasonsOffered(course!)).toEqual(["fall", "spring"]);
    expect(yearsOffered(course!)).toBe("all");
  });

  test("drops the prose, which is the whole point", () => {
    const slim = slimCatalog(catalog);
    const text = JSON.stringify(slim);
    expect(text).not.toContain("x".repeat(600));
    expect(text).not.toContain("BookstoreUrl");
    expect(text.length).toBeLessThan(JSON.stringify(catalog).length / 3);
  });

  test("says which term it is, so a copy too big to keep can be fetched again", () => {
    expect(slimCatalog(catalog).term).toBe("2027SP");
    expect(slimCatalog(catalog).fetchedAt).toBe(catalog.fetchedAt);
  });
});
