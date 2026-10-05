/**
 * The server's side of the crawl: the shared loop, bound to a guest session
 * and to the SQLite cache.
 *
 * The loop itself lives in `src/crawl.ts`, because the planner runs the same
 * one in the browser now that Cedarville has put the catalog behind SSO.
 * What is left here is the part that is genuinely server-only: supplying a
 * guest client, and writing what comes back into the store.
 *
 * Every function here still works, and every one of them fails the moment the
 * guest endpoint is gone. That is not a bug to paper over: a server that can
 * no longer read the catalog should say so, and the ingest route is how the
 * catalog gets filled instead.
 */

import type { CatalogCourseRecord, TermCatalog } from "../catalog";
import {
  ALL_COURSES,
  type CrawlOptions,
  type CrawlProgress,
  crawlAllCourses as crawlAll,
  crawlSeats,
  crawlTerm as crawlTermWith,
  dedupeByCode,
  type Searcher,
  type Seats,
} from "../crawl";
import { GuestColleague } from "./colleague";
import type { CatalogStore } from "./store";

export type { CrawlOptions, CrawlProgress, Searcher, Seats };
export { ALL_COURSES, dedupeByCode };

export const crawlTerm = (
  term: string,
  options: CrawlOptions = {},
  client: Searcher = new GuestColleague(),
): Promise<TermCatalog & { complete: boolean }> => crawlTermWith(client, term, options);

export const crawlAllCourses = async (
  options: CrawlOptions = {},
  client: Searcher = new GuestColleague(),
): Promise<CatalogCourseRecord[]> => (await crawlAll(client, options)).courses;

export const liveSeats = (
  term: string,
  courseIds: string[],
  client: Searcher = new GuestColleague(),
): Promise<Record<string, Seats>> => crawlSeats(client, term, courseIds);

/** Every term Colleague currently lists as searchable. */
export const availableTerms = (client = new GuestColleague()) => client.terms();

/** Crawls and stores in one step. Returns how many sections landed. */
export async function refreshTerm(
  term: string,
  store: CatalogStore,
  options: CrawlOptions = {},
): Promise<number> {
  const catalog = await crawlTerm(term, options);
  // An empty crawl means something went wrong upstream; keeping the previous
  // catalog beats replacing a working timetable with nothing. An incomplete
  // one is worse than empty, because it looks like a term that lost half its
  // sections, and `replace` would delete the rest.
  if (catalog.sections.length === 0 || !catalog.complete) return 0;
  return store.replace(catalog);
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
