import { describe, expect, test } from "bun:test";
import type { TermCatalog } from "../catalog";
import type { SectionsResponse } from "../types";
import { CatalogStore } from "./store";

/** ":memory:" keeps each test's database to itself. */
const store = () => new CatalogStore(":memory:");

const payload = (name: string) =>
  ({
    SectionsRetrieved: {
      Course: { CourseName: name },
      TermsAndSections: [],
    },
  }) as unknown as SectionsResponse;

const catalog = (over: Partial<TermCatalog> = {}): TermCatalog => ({
  term: "26/FA",
  fetchedAt: "2026-08-12T00:00:00.000Z",
  sections: { c1: payload("CS-3310") },
  notOffered: ["c2"],
  ...over,
});

describe("the test guard", () => {
  // Regression class, not a bug: a test that opened the default database
  // would quietly read and write live catalog data. test/setup.ts pins the
  // default to memory, and this asserts the pin is still in place.
  test("the default store is in memory during tests", () => {
    expect(process.env.CATALOG_DB).toBe(":memory:");

    const db = new CatalogStore();
    db.write(catalog());
    expect(db.stats()).toHaveLength(1);
    db.close();

    // A second default store starts empty, which only holds for :memory:.
    const fresh = new CatalogStore();
    expect(fresh.stats()).toEqual([]);
    fresh.close();
  });
});

describe("catalog store", () => {
  test("round-trips sections and the not-offered list", () => {
    const db = store();
    expect(db.write(catalog())).toBe(2);

    const read = db.read("26/FA");
    expect(Object.keys(read.sections)).toEqual(["c1"]);
    expect(read.notOffered).toEqual(["c2"]);
    expect(read.fetchedAt).toBe("2026-08-12T00:00:00.000Z");
    db.close();
  });

  test("reads only the courses asked for", () => {
    const db = store();
    db.write(catalog({ sections: { c1: payload("A"), c3: payload("B") } }));

    expect(Object.keys(db.read("26/FA", ["c1"]).sections)).toEqual(["c1"]);
    expect(db.read("26/FA", ["nope"]).sections).toEqual({});
    db.close();
  });

  test("keeps terms apart", () => {
    const db = store();
    db.write(catalog());
    db.write(catalog({ term: "27/SP", sections: { c9: payload("Z") }, notOffered: [] }));

    expect(Object.keys(db.read("26/FA").sections)).toEqual(["c1"]);
    expect(Object.keys(db.read("27/SP").sections)).toEqual(["c9"]);
    db.close();
  });

  // Seat counts are the reason to refetch, so a newer crawl has to win.
  test("a newer fetch overwrites an older one", () => {
    const db = store();
    db.write(catalog({ sections: { c1: payload("stale") } }));
    db.write(
      catalog({
        fetchedAt: "2026-08-13T00:00:00.000Z",
        sections: { c1: payload("fresh") },
        notOffered: [],
      }),
    );

    const read = db.read("26/FA");
    expect(read.sections.c1?.SectionsRetrieved.Course).toMatchObject({ CourseName: "fresh" });
    db.close();
  });

  test("an older fetch does not clobber newer data", () => {
    const db = store();
    db.write(
      catalog({ fetchedAt: "2026-08-13T00:00:00.000Z", sections: { c1: payload("fresh") } }),
    );
    db.write(
      catalog({ fetchedAt: "2026-08-01T00:00:00.000Z", sections: { c1: payload("stale") } }),
    );

    const read = db.read("26/FA");
    expect(read.sections.c1?.SectionsRetrieved.Course).toMatchObject({ CourseName: "fresh" });
    db.close();
  });

  test("a course that starts being offered leaves the not-offered list", () => {
    const db = store();
    db.write(catalog({ sections: {}, notOffered: ["c1"] }));
    db.write(
      catalog({
        fetchedAt: "2026-08-13T00:00:00.000Z",
        sections: { c1: payload("now taught") },
        notOffered: [],
      }),
    );

    const read = db.read("26/FA");
    expect(read.notOffered).toEqual([]);
    expect(Object.keys(read.sections)).toEqual(["c1"]);
    db.close();
  });

  test("an empty term reads as empty rather than throwing", () => {
    const db = store();
    expect(db.read("99/XX")).toMatchObject({ sections: {}, notOffered: [] });
    expect(db.stats()).toEqual([]);
    db.close();
  });

  test("stats summarise what is cached", () => {
    const db = store();
    db.write(catalog());
    expect(db.stats()).toEqual([
      { term: "26/FA", courses: 2, offered: 1, oldest: "2026-08-12T00:00:00.000Z" },
    ]);
    db.close();
  });
});
