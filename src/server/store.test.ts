import { describe, expect, test } from "bun:test";
import type { ListingSection, TermCatalog } from "../catalog";
import { CatalogStore } from "./store";

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

  test("stats summarise what is cached", () => {
    const db = store();
    db.replace(catalog());
    expect(db.stats()).toEqual([
      { term: "2026FA", sections: 2, courses: 2, fetchedAt: "2026-08-12T00:00:00.000Z" },
    ]);
    db.close();
  });
});
