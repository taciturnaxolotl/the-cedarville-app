/**
 * Paging the course search, independently of who is signed in.
 *
 * Colleague's catalog used to be readable by anyone, so the crawl lived on the
 * server and one pass served every student. Cedarville moved the whole thing
 * behind SSO, and the only thing left with a session is a student's own
 * browser. So the loop had to leave the server.
 *
 * It did not have to be rewritten. Every crawl here asks one question of one
 * object — `search(criteria)` — so the loops are parameterised over that and
 * nothing else. The server passes a guest client when there is still a guest
 * endpoint to use; the planner passes one that round-trips through the
 * extension. Same paging, same dedupe, same politeness delay, one
 * implementation, because two would drift and only one of them would be
 * tested.
 *
 * Deliberately free of imports from `server/`: this module is bundled into
 * the browser, and `server/store` opens SQLite.
 */

import type { CatalogCourseRecord, ListingSection, TermCatalog } from "./catalog";

/**
 * What the crawl sends. A partial of Colleague's own criteria object: the
 * endpoint fills in every field it is not given, and naming all of them here
 * would mean restating defaults we do not care about.
 */
export interface SearchCriteria {
  terms?: string[];
  subjects?: string[];
  courseIds?: string[];
  /** Degree-audit coordinates: asks Colleague to evaluate that group's rule. */
  requirement?: string;
  subrequirement?: string;
  group?: string;
  keyword?: string;
  pageNumber?: number;
  quantityPerPage?: number;
  searchResultsView?: "SectionListing" | "CatalogListing";
}

/**
 * What it sends back. Which of the three collections is populated depends on
 * `searchResultsView`, so all three are optional and the caller reads the one
 * it asked for.
 */
export interface SearchPage {
  Sections?: unknown[];
  Courses?: unknown[];
  CourseFullModels?: unknown[];
  TotalItems: number;
  TotalPages: number;
  CurrentPageIndex: number;
}

/**
 * The whole contract a crawl needs. Both halves of the app have something
 * that satisfies it, and neither had to be built for this.
 */
export interface Searcher {
  search(criteria: SearchCriteria): Promise<SearchPage>;
}

export interface CrawlProgress {
  term: string;
  page: number;
  pages: number;
  sections: number;
  phase?: "sections" | "courses";
}

export interface CrawlOptions {
  /** Gap between pages. This is a registrar, not a load test. */
  delayMs?: number;
  onProgress?: (progress: CrawlProgress) => void;
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs the pager and hands each page to a collector.
 *
 * Every crawl below is this loop plus a different thing done with each page,
 * and the parts worth getting right are the shared ones: `TotalPages` comes
 * from the response rather than being guessed, an abort is checked before
 * each request rather than after, and the delay is skipped on the last page
 * so a one-page crawl does not sit waiting for nothing.
 *
 * Returns how many pages were actually read, which is how a caller tells a
 * complete crawl from one that was cut short.
 */
async function page(
  searcher: Searcher,
  criteria: SearchCriteria,
  options: CrawlOptions,
  take: (result: SearchPage) => void,
  progress: (page: number, pages: number) => void,
): Promise<{ pages: number; read: number; total: number }> {
  const { delayMs = 300, signal } = options;
  let current = 1;
  let pages = 1;
  let read = 0;
  let total = 0;

  while (current <= pages) {
    if (signal?.aborted) break;

    const result = await searcher.search({ ...criteria, pageNumber: current });
    pages = Math.max(result.TotalPages ?? 1, 1);
    total = result.TotalItems ?? 0;
    take(result);
    read++;

    progress(current, pages);
    current++;
    if (current <= pages && delayMs > 0) await sleep(delayMs);
  }
  return { pages, read, total };
}

/**
 * A term's sections, which is the timetable: when each one meets, where, with
 * whom, and how many seats are left.
 *
 * One search in `SectionListing` view returns sections directly, so a term is
 * about sixty pages rather than one request per course.
 */
export async function crawlSections(
  searcher: Searcher,
  term: string,
  options: CrawlOptions = {},
): Promise<{ sections: ListingSection[]; complete: boolean }> {
  const sections: ListingSection[] = [];
  const seen = new Set<string>();

  const { pages, read } = await page(
    searcher,
    { terms: [term], searchResultsView: "SectionListing" },
    options,
    (result) => {
      for (const raw of result.Sections ?? []) {
        const section = raw as ListingSection;
        // A section shifting between pages mid-crawl must not double up.
        if (!section?.Id || seen.has(section.Id)) continue;
        seen.add(section.Id);
        sections.push(section);
      }
    },
    (current, totalPages) =>
      options.onProgress?.({
        term,
        page: current,
        pages: totalPages,
        sections: sections.length,
        phase: "sections",
      }),
  );

  return { sections, complete: read >= pages };
}

/**
 * The same term again in catalog view, which is the only place requisites
 * come back as readable text rather than an opaque rule id. Half the pages of
 * the section crawl, and it is what makes "what blocks what" answerable.
 */
export async function crawlCourses(
  searcher: Searcher,
  term: string,
  options: CrawlOptions = {},
): Promise<{ courses: CatalogCourseRecord[]; complete: boolean }> {
  const byId = new Map<string, CatalogCourseRecord>();

  const { pages, read } = await page(
    searcher,
    { terms: [term], searchResultsView: "CatalogListing" },
    options,
    (result) => {
      for (const raw of result.CourseFullModels ?? []) {
        const course = raw as CatalogCourseRecord;
        if (course?.Id) byId.set(course.Id, course);
      }
    },
    (current, totalPages) =>
      options.onProgress?.({
        term,
        page: current,
        pages: totalPages,
        sections: byId.size,
        phase: "courses",
      }),
  );

  return { courses: [...byId.values()], complete: read >= pages };
}

/**
 * A term, both ways round.
 *
 * `complete` is true only when both halves paged all the way to the end. An
 * interrupted crawl is still worth keeping in the browser, but it must never
 * be allowed to replace a whole term in the shared cache: a partial crawl
 * looks exactly like a term where half the sections were cancelled.
 */
export async function crawlTerm(
  searcher: Searcher,
  term: string,
  options: CrawlOptions = {},
): Promise<TermCatalog & { complete: boolean }> {
  const sections = await crawlSections(searcher, term, options);
  const courses = await crawlCourses(searcher, term, options);

  return {
    term,
    fetchedAt: new Date().toISOString(),
    sections: sections.sections,
    courses: courses.courses,
    complete: sections.complete && courses.complete,
  };
}

/** The sentinel term under which "every course that exists" is stored. */
export const ALL_COURSES = "ALL";

/**
 * Every course in the catalog, whether or not it runs this year.
 *
 * The per-term crawl answers "what is offered"; this answers "what exists".
 * They have to be separate, because a prerequisite is often a course nobody
 * is teaching this year — EGEE-2010 roots a four-course engineering chain and
 * appears in neither cached term. Built from term-scoped data alone, the
 * graph loses 36% of its prerequisite nodes and silently understates depth on
 * a third of its courses.
 */
export async function crawlAllCourses(
  searcher: Searcher,
  options: CrawlOptions = {},
): Promise<{ courses: CatalogCourseRecord[]; complete: boolean }> {
  const byId = new Map<string, CatalogCourseRecord>();

  const { pages, read } = await page(
    searcher,
    // No term filter: the whole catalog rather than one term's offerings.
    { searchResultsView: "CatalogListing" },
    options,
    (result) => {
      for (const raw of result.CourseFullModels ?? []) {
        const course = raw as CatalogCourseRecord;
        if (course?.Id) byId.set(course.Id, course);
      }
    },
    (current, totalPages) =>
      options.onProgress?.({
        term: ALL_COURSES,
        page: current,
        pages: totalPages,
        sections: byId.size,
        phase: "courses",
      }),
  );

  return { courses: dedupeByCode([...byId.values()]), complete: read >= pages };
}

/**
 * One record per course code, chosen deliberately.
 *
 * About 1% of codes carry two records: a course being retired beside its
 * replacement, both live during the transition ("Prin Accounting I" and
 * "Financial Accounting" are both ACCT-2110 this term). Colleague tells them
 * apart by id and picks per the student's catalog year; requisite text only
 * ever names a code, so a graph keyed by code has to choose. Choosing by
 * whichever the crawl happened to see last is not a choice at all — prefer the
 * one being taught, then the one that states requisites.
 */
export function dedupeByCode(records: CatalogCourseRecord[]): CatalogCourseRecord[] {
  const best = new Map<string, CatalogCourseRecord>();
  const score = (c: CatalogCourseRecord) =>
    ((c as { MatchingSectionIds?: string[] }).MatchingSectionIds?.length ?? 0) * 10 +
    (c.CourseRequisites?.length ?? 0);

  for (const course of records) {
    const code = `${course.SubjectCode}-${course.Number}`;
    const held = best.get(code);
    if (!held || score(course) > score(held)) best.set(code, course);
  }
  return [...best.values()];
}

export interface Seats {
  available: number;
  capacity: number;
  enrolled: number;
  waitlisted: number;
  status: string;
}

/**
 * Current availability for a handful of courses.
 *
 * Seat counts are the one field that moves by the minute during registration,
 * so serving them from a six-hour-old crawl makes the number decorative at
 * exactly the moment it matters. This asks Colleague directly, scoped to the
 * courses a student is actually looking at: one request, under a second.
 */
export async function crawlSeats(
  searcher: Searcher,
  term: string,
  courseIds: string[],
  options: CrawlOptions = {},
): Promise<Record<string, Seats>> {
  if (courseIds.length === 0) return {};

  const seats: Record<string, Seats> = {};
  await page(
    searcher,
    { terms: [term], courseIds, searchResultsView: "SectionListing" },
    { ...options, delayMs: options.delayMs ?? 0 },
    (result) => {
      for (const raw of result.Sections ?? []) {
        const s = raw as ListingSection;
        if (!s?.Id) continue;
        seats[s.Id] = {
          available: s.Available,
          capacity: s.Capacity,
          enrolled: s.Enrolled,
          waitlisted: s.Waitlisted,
          status: s.AvailabilityStatus,
        };
      }
    },
    () => {},
  );
  return seats;
}

/**
 * Expands a requirement group whose eligible courses Colleague will not
 * enumerate in an evaluation, by asking the search to evaluate the rule.
 */
export async function crawlGroup(
  searcher: Searcher,
  ids: { requirement: string; subrequirement: string; group: string },
  options: CrawlOptions = {},
): Promise<string[]> {
  const names = new Set<string>();

  await page(
    searcher,
    { ...ids, searchResultsView: "CatalogListing" },
    { ...options, delayMs: options.delayMs ?? 0 },
    (result) => {
      for (const raw of result.Courses ?? []) {
        const course = raw as { SubjectCode?: string; Number?: string };
        if (course.SubjectCode && course.Number) {
          names.add(`${course.SubjectCode}-${course.Number}`);
        }
      }
    },
    () => {},
  );
  return [...names].sort();
}
