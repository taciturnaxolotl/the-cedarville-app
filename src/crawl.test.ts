import { describe, expect, test } from "bun:test";
import {
  ALL_COURSES,
  crawlAllCourses,
  crawlGroup,
  crawlSeats,
  crawlSections,
  crawlTerm,
  type SearchCriteria,
  type Searcher,
  type SearchPage,
} from "./crawl";

/**
 * A searcher that serves canned pages and records what it was asked.
 *
 * Every crawl here is a paging loop over somebody else's `TotalPages`, so the
 * things worth asserting are what it asked for and when it stopped. A fake
 * that remembers its calls is the only way to see either.
 */
function fake(pages: SearchPage[]): Searcher & { asked: SearchCriteria[] } {
  const asked: SearchCriteria[] = [];
  return {
    asked,
    search(criteria) {
      asked.push(criteria);
      const page = pages[(criteria.pageNumber ?? 1) - 1];
      if (!page) throw new Error(`asked for page ${criteria.pageNumber}, which was not set up`);
      return Promise.resolve(page);
    },
  };
}

const sectionPage = (ids: string[], pages = 1, term = "2026FA"): SearchPage => ({
  Sections: ids.map((Id) => ({ Id, CourseId: `c${Id}`, TermId: term })),
  TotalItems: ids.length,
  TotalPages: pages,
  CurrentPageIndex: 0,
});

const coursePage = (codes: string[], pages = 1): SearchPage => ({
  CourseFullModels: codes.map((code) => {
    const [subject, number] = code.split("-");
    return { Id: code, SubjectCode: subject, Number: number };
  }),
  TotalItems: codes.length,
  TotalPages: pages,
  CurrentPageIndex: 0,
});

const noDelay = { delayMs: 0 };

describe("paging", () => {
  test("follows TotalPages rather than guessing", async () => {
    const client = fake([sectionPage(["a"], 3), sectionPage(["b"], 3), sectionPage(["c"], 3)]);

    const { sections, complete } = await crawlSections(client, "2026FA", noDelay);

    expect(sections.map((s) => s.Id)).toEqual(["a", "b", "c"]);
    expect(complete).toBe(true);
    expect(client.asked.map((c) => c.pageNumber)).toEqual([1, 2, 3]);
  });

  test("asks for the view it wants, never the endpoint's default", async () => {
    const client = fake([sectionPage(["a"])]);
    await crawlSections(client, "2026FA", noDelay);
    expect(client.asked[0]?.searchResultsView).toBe("SectionListing");

    const courses = fake([coursePage(["ACCT-2110"])]);
    await crawlAllCourses(courses, noDelay);
    expect(courses.asked[0]?.searchResultsView).toBe("CatalogListing");
  });

  test("a section seen twice across pages lands once", async () => {
    // Sections shift between pages while a crawl is running, so the same one
    // legitimately arrives on page 1 and page 2.
    const client = fake([sectionPage(["a", "b"], 2), sectionPage(["b", "c"], 2)]);

    const { sections } = await crawlSections(client, "2026FA", noDelay);
    expect(sections.map((s) => s.Id)).toEqual(["a", "b", "c"]);
  });

  test("a one-page crawl makes one request", async () => {
    const client = fake([sectionPage(["a"])]);
    await crawlSections(client, "2026FA", noDelay);
    expect(client.asked).toHaveLength(1);
  });

  test("reports progress per page, with the phase it is in", async () => {
    const seen: string[] = [];
    const client = fake([sectionPage(["a"], 2), sectionPage(["b"], 2)]);

    await crawlSections(client, "2026FA", {
      ...noDelay,
      onProgress: ({ page, pages, phase }) => seen.push(`${phase} ${page}/${pages}`),
    });

    expect(seen).toEqual(["sections 1/2", "sections 2/2"]);
  });
});

describe("an interrupted crawl says so", () => {
  // The distinction the shared cache is built on: a term that lost half its
  // sections and a crawl that stopped halfway look identical in the data, so
  // the crawl has to report which it was.
  test("aborting mid-crawl comes back incomplete", async () => {
    const abort = new AbortController();
    const client: Searcher = {
      search(criteria) {
        if ((criteria.pageNumber ?? 1) === 2) abort.abort();
        return Promise.resolve(sectionPage([`s${criteria.pageNumber}`], 5));
      },
    };

    const { sections, complete } = await crawlSections(client, "2026FA", {
      ...noDelay,
      signal: abort.signal,
    });

    expect(complete).toBe(false);
    // Page 2 was fetched, then the abort stopped page 3.
    expect(sections).toHaveLength(2);
  });

  test("a crawl that reaches the end is complete", async () => {
    const client = fake([sectionPage(["a"], 2), sectionPage(["b"], 2)]);
    expect((await crawlSections(client, "2026FA", noDelay)).complete).toBe(true);
  });

  test("a term is complete only when both halves are", async () => {
    const abort = new AbortController();
    const client: Searcher = {
      search(criteria) {
        if (criteria.searchResultsView === "CatalogListing") {
          abort.abort();
          return Promise.resolve(coursePage(["ACCT-2110"], 4));
        }
        return Promise.resolve(sectionPage(["a"], 1));
      },
    };

    const term = await crawlTerm(client, "2026FA", { ...noDelay, signal: abort.signal });
    expect(term.sections).toHaveLength(1);
    expect(term.complete).toBe(false);
  });
});

describe("a term, both ways round", () => {
  test("carries sections, courses and the term it was asked for", async () => {
    const client: Searcher = {
      search: (criteria) =>
        Promise.resolve(
          criteria.searchResultsView === "CatalogListing"
            ? coursePage(["ACCT-2110", "ACCT-2120"])
            : sectionPage(["s1", "s2"]),
        ),
    };

    const term = await crawlTerm(client, "2026FA", noDelay);

    expect(term.term).toBe("2026FA");
    expect(term.sections).toHaveLength(2);
    expect(term.courses).toHaveLength(2);
    expect(Date.parse(term.fetchedAt)).toBeGreaterThan(0);
    expect(term.complete).toBe(true);
  });

  test("scopes both halves to the one term", async () => {
    const client = fake([sectionPage(["s1"]), coursePage(["ACCT-2110"])]);
    const asked: (string[] | undefined)[] = [];
    await crawlTerm(
      {
        search: (criteria) => {
          asked.push(criteria.terms);
          return client.search(criteria);
        },
      },
      "2026FA",
      noDelay,
    );
    expect(asked).toEqual([["2026FA"], ["2026FA"]]);
  });
});

describe("every course that exists", () => {
  test("sends no term filter, because the question is not about a term", async () => {
    const client = fake([coursePage(["ACCT-2110"])]);
    await crawlAllCourses(client, noDelay);
    expect(client.asked[0]?.terms).toBeUndefined();
  });

  test("prefers the record being taught when one code has two", async () => {
    // Real case: a course being retired beside its replacement, both live
    // during the transition, both ACCT-2110.
    const page: SearchPage = {
      CourseFullModels: [
        { Id: "old", SubjectCode: "ACCT", Number: "2110", MatchingSectionIds: [] },
        { Id: "new", SubjectCode: "ACCT", Number: "2110", MatchingSectionIds: ["s1"] },
      ],
      TotalItems: 2,
      TotalPages: 1,
      CurrentPageIndex: 0,
    };

    const { courses } = await crawlAllCourses({ search: () => Promise.resolve(page) }, noDelay);
    expect(courses).toHaveLength(1);
    expect(courses[0]?.Id).toBe("new");
  });

  test("names its progress after the sentinel rather than a term", async () => {
    const seen: string[] = [];
    await crawlAllCourses(
      { search: () => Promise.resolve(coursePage(["ACCT-2110"])) },
      { ...noDelay, onProgress: ({ term }) => seen.push(term) },
    );
    expect(seen).toEqual([ALL_COURSES]);
  });
});

describe("seats", () => {
  test("asks for nothing when given no courses", async () => {
    const client = fake([]);
    expect(await crawlSeats(client, "2026FA", [])).toEqual({});
    expect(client.asked).toHaveLength(0);
  });

  test("reads availability per section id", async () => {
    const page: SearchPage = {
      Sections: [
        {
          Id: "s1",
          Available: 3,
          Capacity: 30,
          Enrolled: 27,
          Waitlisted: 1,
          AvailabilityStatus: "Open",
        },
      ],
      TotalItems: 1,
      TotalPages: 1,
      CurrentPageIndex: 0,
    };

    const seats = await crawlSeats({ search: () => Promise.resolve(page) }, "2026FA", ["c1"]);
    expect(seats.s1).toEqual({
      available: 3,
      capacity: 30,
      enrolled: 27,
      waitlisted: 1,
      status: "Open",
    });
  });
});

describe("expanding a rule", () => {
  test("carries the group's coordinates and sorts the answer", async () => {
    const client = fake([
      {
        Courses: [
          { SubjectCode: "BIO", Number: "2010" },
          { SubjectCode: "BIO", Number: "1010" },
        ],
        TotalItems: 2,
        TotalPages: 1,
        CurrentPageIndex: 0,
      },
    ]);

    const courses = await crawlGroup(client, {
      requirement: "R1",
      subrequirement: "S1",
      group: "G1",
    });

    expect(courses).toEqual(["BIO-1010", "BIO-2010"]);
    expect(client.asked[0]).toMatchObject({
      requirement: "R1",
      subrequirement: "S1",
      group: "G1",
      searchResultsView: "CatalogListing",
    });
  });

  test("a course missing either half of its code is skipped", async () => {
    const courses = await crawlGroup(
      {
        search: () =>
          Promise.resolve({
            Courses: [{ SubjectCode: "BIO" }, { SubjectCode: "BIO", Number: "1010" }],
            TotalItems: 2,
            TotalPages: 1,
            CurrentPageIndex: 0,
          }),
      },
      { requirement: "R1", subrequirement: "S1", group: "G1" },
    );
    expect(courses).toEqual(["BIO-1010"]);
  });
});
