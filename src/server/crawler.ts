/**
 * Fetching a whole term, once, for everybody.
 *
 * A single search in SectionListing view returns sections directly, so Fall
 * 2026 is about sixty pages rather than one request per course. Doing that
 * here instead of in each student's browser is both faster for them and far
 * less traffic for the registrar: one crawl serves every user of the app.
 */

import type { CatalogCourseRecord, ListingSection, TermCatalog } from "../catalog";
import { GuestColleague } from "./colleague";
import type { CatalogStore } from "./store";

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

export async function crawlTerm(
  term: string,
  options: CrawlOptions = {},
  client = new GuestColleague(),
): Promise<TermCatalog> {
  const { delayMs = 300, onProgress, signal } = options;
  const sections: ListingSection[] = [];
  const seen = new Set<string>();

  // Colleague caps the page size at its own value regardless of what we ask,
  // so paging is driven by the TotalPages it reports back.
  let page = 1;
  let pages = 1;

  while (page <= pages) {
    if (signal?.aborted) break;

    const result = await client.search({ terms: [term], pageNumber: page });
    pages = Math.max(result.TotalPages ?? 1, 1);

    for (const raw of result.Sections ?? []) {
      const section = raw as ListingSection;
      // A section shifting between pages mid-crawl must not double up.
      if (!section?.Id || seen.has(section.Id)) continue;
      seen.add(section.Id);
      sections.push(section);
    }

    onProgress?.({ term, page, pages, sections: sections.length });
    page++;
    if (page <= pages && delayMs > 0) await sleep(delayMs);
  }

  return {
    term,
    fetchedAt: new Date().toISOString(),
    sections,
    courses: await crawlCourses(term, options, client),
  };
}

/**
 * The same term again in catalog view, which is the only place requisites
 * come back as readable text rather than an opaque rule id. Half the pages of
 * the section crawl, and it is what makes "what blocks what" answerable.
 */
export async function crawlCourses(
  term: string,
  options: CrawlOptions = {},
  client = new GuestColleague(),
): Promise<CatalogCourseRecord[]> {
  const { delayMs = 300, onProgress, signal } = options;
  const byId = new Map<string, CatalogCourseRecord>();

  let page = 1;
  let pages = 1;

  while (page <= pages) {
    if (signal?.aborted) break;

    const result = await client.search({
      terms: [term],
      pageNumber: page,
      searchResultsView: "CatalogListing",
    });
    pages = Math.max(result.TotalPages ?? 1, 1);

    for (const raw of result.CourseFullModels ?? []) {
      const course = raw as CatalogCourseRecord;
      if (course?.Id) byId.set(course.Id, course);
    }

    onProgress?.({ term, page, pages, sections: byId.size, phase: "courses" });
    page++;
    if (page <= pages && delayMs > 0) await sleep(delayMs);
  }
  return [...byId.values()];
}

/** Crawls and stores in one step. Returns how many sections landed. */
export async function refreshTerm(
  term: string,
  store: CatalogStore,
  options: CrawlOptions = {},
): Promise<number> {
  const catalog = await crawlTerm(term, options);
  // An empty crawl means something went wrong upstream; keeping the previous
  // catalog beats replacing a working timetable with nothing.
  if (catalog.sections.length === 0) return 0;
  return store.replace(catalog);
}

/** Every term Colleague currently lists as searchable. */
export const availableTerms = (client = new GuestColleague()) => client.terms();

/**
 * Current availability for a handful of courses.
 *
 * Seat counts are the one field that moves by the minute during registration,
 * so serving them from a six-hour-old crawl makes the number decorative at
 * exactly the moment it matters. This asks Colleague directly, scoped to the
 * courses a student is actually looking at: one request, under a second.
 */
export async function liveSeats(
  term: string,
  courseIds: string[],
  client = new GuestColleague(),
): Promise<Record<string, Seats>> {
  if (courseIds.length === 0) return {};

  const seats: Record<string, Seats> = {};
  let page = 1;
  let pages = 1;

  while (page <= pages) {
    const result = await client.search({ terms: [term], courseIds, pageNumber: page });
    pages = Math.max(result.TotalPages ?? 1, 1);

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
    page++;
  }
  return seats;
}

export interface Seats {
  available: number;
  capacity: number;
  enrolled: number;
  waitlisted: number;
  status: string;
}

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
export const ALL_COURSES = "ALL";

export async function crawlAllCourses(
  options: CrawlOptions = {},
  client = new GuestColleague(),
): Promise<CatalogCourseRecord[]> {
  const { delayMs = 300, onProgress, signal } = options;
  const byId = new Map<string, CatalogCourseRecord>();

  let page = 1;
  let pages = 1;

  while (page <= pages) {
    if (signal?.aborted) break;

    // No term filter: the whole catalog rather than one term's offerings.
    const result = await client.search({ pageNumber: page, searchResultsView: "CatalogListing" });
    pages = Math.max(result.TotalPages ?? 1, 1);

    for (const raw of result.CourseFullModels ?? []) {
      const course = raw as CatalogCourseRecord;
      if (course?.Id) byId.set(course.Id, course);
    }

    onProgress?.({ term: ALL_COURSES, page, pages, sections: byId.size, phase: "courses" });
    page++;
    if (page <= pages && delayMs > 0) await sleep(delayMs);
  }
  return dedupeByCode([...byId.values()]);
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

/** Crawls the full catalog and stores it under the ALL sentinel. */
export async function refreshAllCourses(
  store: CatalogStore,
  options: CrawlOptions = {},
): Promise<number> {
  const courses = await crawlAllCourses(options);
  if (courses.length === 0) return 0;
  store.replace({ term: ALL_COURSES, fetchedAt: new Date().toISOString(), sections: [], courses });
  return courses.length;
}
