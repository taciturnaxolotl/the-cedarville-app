import { describe, expect, test } from "bun:test";
import type { ListingSection, TermCatalog } from "../catalog";
import { CatalogStore, ruleKey } from "./store";

/** ":memory:" keeps each test's database to itself. */
const store = () => new CatalogStore(":memory:");

const section = (id: string, courseId = "c1", name = "ACCT-2110"): ListingSection =>
  ({ Id: id, CourseId: courseId, CourseName: name, Number: "01" }) as ListingSection;

const catalog = (over: Partial<TermCatalog> = {}): TermCatalog => ({
  term: "2026FA",
  fetchedAt: "2026-08-12T00:00:00.000Z",
  sections: [section("s1"), section("s2", "c2", "ACCT-2120")],
  ...over,
});

describe("the test guard", () => {
  // Regression class, not a bug: a test that opened the default database
  // would quietly read and write live catalog data. test/setup.ts pins the
  // default to memory, and this asserts the pin is still in place.
  test("the default store is in memory during tests", () => {
    expect(process.env.CATALOG_DB).toBe(":memory:");

    const db = new CatalogStore();
    db.replace(catalog());
    expect(db.stats()).toHaveLength(1);
    db.close();

    // A second default store starts empty, which only holds for :memory:.
    const fresh = new CatalogStore();
    expect(fresh.stats()).toEqual([]);
    fresh.close();
  });
});

describe("catalog store", () => {
  test("round-trips sections", () => {
    const db = store();
    expect(db.replace(catalog())).toBe(2);

    const read = db.read("2026FA");
    expect(read.sections.map((s) => s.Id).sort()).toEqual(["s1", "s2"]);
    expect(read.fetchedAt).toBe("2026-08-12T00:00:00.000Z");
    db.close();
  });

  test("narrows to the courses asked for", () => {
    const db = store();
    db.replace(catalog());

    expect(db.read("2026FA", ["c2"]).sections.map((s) => s.Id)).toEqual(["s2"]);
    expect(db.read("2026FA", ["nope"]).sections).toEqual([]);
    db.close();
  });

  test("keeps terms apart", () => {
    const db = store();
    db.replace(catalog());
    db.replace(catalog({ term: "2026SU", sections: [section("s9", "c9")] }));

    expect(db.read("2026FA").sections).toHaveLength(2);
    expect(db.read("2026SU").sections.map((s) => s.Id)).toEqual(["s9"]);
    db.close();
  });

  test("a later crawl updates a section in place", () => {
    const db = store();
    db.replace(catalog({ sections: [{ ...section("s1"), Available: 5 } as ListingSection] }));
    db.replace(
      catalog({
        fetchedAt: "2026-08-13T00:00:00.000Z",
        sections: [{ ...section("s1"), Available: 0 } as ListingSection],
      }),
    );

    const read = db.read("2026FA");
    expect(read.sections).toHaveLength(1);
    expect(read.sections[0]!.Available).toBe(0);
    db.close();
  });

  // A crawl sees every section that exists, so one that vanished was
  // cancelled and must not linger in a student's timetable.
  test("a section missing from a newer crawl is dropped", () => {
    const db = store();
    db.replace(catalog());
    db.replace(catalog({ fetchedAt: "2026-08-13T00:00:00.000Z", sections: [section("s1")] }));

    expect(db.read("2026FA").sections.map((s) => s.Id)).toEqual(["s1"]);
    db.close();
  });

  test("an empty term reads as empty rather than throwing", () => {
    const db = store();
    expect(db.read("9999XX")).toMatchObject({ sections: [] });
    expect(db.stats()).toEqual([]);
    db.close();
  });

  test("stores course records with their requisites", () => {
    const db = store();
    db.replace(
      catalog({
        courses: [
          {
            Id: "c1",
            SubjectCode: "CS",
            Number: "2210",
            Title: "Data Structures",
            CourseRequisites: [
              { DisplayText: "Take CS-1220", DisplayTextExtension: "- prior", IsRequired: true },
            ],
          },
        ],
      }),
    );

    const read = db.read("2026FA");
    expect(read.courses).toHaveLength(1);
    expect(read.courses?.[0]?.CourseRequisites?.[0]?.DisplayText).toBe("Take CS-1220");
    db.close();
  });

  // A sections-only refresh must not wipe the requisite data, which is
  // collected by a separate, slower pass.
  test("a crawl with no courses leaves the stored ones alone", () => {
    const db = store();
    db.replace(
      catalog({
        courses: [{ Id: "c1", SubjectCode: "CS", Number: "2210", Title: "Data Structures" }],
      }),
    );
    db.replace(catalog({ fetchedAt: "2026-08-13T00:00:00.000Z", courses: [] }));

    expect(db.read("2026FA").courses).toHaveLength(1);
    db.close();
  });

  /**
   * Requirement groups whose courses live in a Colleague rule are keyed by
   * catalog coordinates, not by student: the same rule resolves the same way
   * for everyone, so one lookup is shared.
   */
  test("caches resolved rule groups by their catalog coordinates", () => {
    const db = store();
    const key = { requirement: "UG.GENED.BS.2026", subrequirement: "33963", group: "33964" };
    expect(db.readRules([key]).size).toBe(0);
    expect(db.ruleCount()).toBe(0);

    db.writeRule(key, ["GBIO-1000", "BIO-1115"]);
    expect(db.readRules([key]).get(ruleKey(key))).toEqual(["GBIO-1000", "BIO-1115"]);
    expect(db.ruleCount()).toBe(1);
    db.close();
  });

  test("re-resolving a group replaces its list", () => {
    const db = store();
    const key = { requirement: "R", subrequirement: "S", group: "G" };
    db.writeRule(key, ["OLD-1000"]);
    db.writeRule(key, ["NEW-1000", "NEW-2000"]);

    expect(db.readRules([key]).get(ruleKey(key))).toEqual(["NEW-1000", "NEW-2000"]);
    expect(db.ruleCount()).toBe(1);
    db.close();
  });

  test("unknown groups are absent rather than empty, so callers can tell", () => {
    const db = store();
    db.writeRule({ requirement: "R", subrequirement: "S", group: "G" }, []);
    const known = db.readRules([
      { requirement: "R", subrequirement: "S", group: "G" },
      { requirement: "R", subrequirement: "S", group: "MISSING" },
    ]);
    // A group that genuinely resolves to nothing is still a known answer.
    expect(known.get("R/S/G")).toEqual([]);
    expect(known.has("R/S/MISSING")).toBe(false);
    db.close();
  });

  test("stats summarise what is cached", () => {
    const db = store();
    db.replace(catalog());
    expect(db.stats()).toEqual([
      { term: "2026FA", sections: 2, courses: 2, fetchedAt: "2026-08-12T00:00:00.000Z" },
    ]);
    db.close();
  });
});

describe("the full course catalog", () => {
  /**
   * Prerequisites routinely name courses nobody is teaching this year, so the
   * catalog is stored term-lessly under a sentinel alongside the per-term
   * offerings. Built from term data alone the graph lost 36% of its nodes.
   */
  test("stores courses with no sections at all", () => {
    const db = store();
    db.replace({
      term: "ALL",
      fetchedAt: "2026-08-12T00:00:00.000Z",
      sections: [],
      courses: [{ Id: "c9", SubjectCode: "EGEE", Number: "2010", Title: "Circuits" }],
    });

    expect(db.readCourses("ALL")).toHaveLength(1);
    // And it does not pretend to be a term with offerings.
    expect(db.read("ALL").sections).toEqual([]);
    db.close();
  });

  test("the sentinel does not collide with a real term", () => {
    const db = store();
    db.replace(catalog());
    db.replace({
      term: "ALL",
      fetchedAt: "2026-08-12T00:00:00.000Z",
      sections: [],
      courses: [{ Id: "c9", SubjectCode: "EGEE", Number: "2010", Title: "Circuits" }],
    });

    expect(db.readCourses("ALL").map((c) => c.Id)).toEqual(["c9"]);
    expect(db.read("2026FA").sections).toHaveLength(2);
    db.close();
  });
});
