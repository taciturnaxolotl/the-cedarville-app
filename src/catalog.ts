/**
 * The section catalog for one term.
 *
 * This is the one thing in the project that is *not* personal. Meeting times,
 * seat counts and instructors are identical for every student at the school,
 * which is why it can be cached and shared while a transcript never can. The
 * boundary is worth stating plainly: catalog on the server, record in the
 * browser.
 */

import type { Section } from "./types";

/**
 * A section as the search endpoint returns it: fields flat on the entry, with
 * faculty names alongside. Kept raw so a normalizer bug stays diagnosable
 * from the cache alone.
 */
export type ListingSection = Section & { FacultyDisplay?: string[] | string };

export interface TermCatalog {
  term: string;
  /** When these sections were fetched from Self-Service. */
  fetchedAt: string;
  sections: ListingSection[];
  /** Course-level records, which is where requisites live. */
  courses?: CatalogCourseRecord[];
}

/**
 * Colleague names a term "2026SP", which sorts alphabetically and wrongly:
 * `FA` precedes `SP`, so a plain sort puts autumn ahead of the spring before
 * it. An academic year runs spring, summer, autumn.
 */
const SEASON_ORDER: Record<string, number> = { SP: 0, SU: 1, FA: 2 };

/** Sortable key for a term code, ascending in time. */
export function termKey(code: string): number {
  const year = Number(code.slice(0, 4));
  return (Number.isFinite(year) ? year : 0) * 10 + (SEASON_ORDER[code.slice(4)] ?? 9);
}

/** Oldest first. Negate for newest first. */
export const compareTerms = (a: string, b: string) => termKey(a) - termKey(b);

/** "2026SP" as the projection writes it: "SP26". */
export const shortTerm = (code: string) => `${code.slice(4)}${code.slice(2, 4)}`;

/**
 * A course as the catalog view returns it. `CourseRequisites` is the only
 * machine-readable prerequisite data Colleague exposes: the section view
 * carries an opaque rule id instead.
 */
export interface CatalogCourseRecord {
  Id: string;
  SubjectCode: string;
  Number: string;
  Title: string;
  Description?: string;
  MinimumCredits?: number;
  /**
   * Present only when the course is variable credit. `HON-4950` runs 1 to 2,
   * and the honors capstone requires it at 2 — so pricing every course at its
   * minimum makes the research project look a credit cheaper than the
   * colloquium it is an alternative to, when the two are equal.
   */
  MaximumCredits?: number;
  CourseRequisites?: {
    DisplayText?: string | null;
    DisplayTextExtension?: string | null;
    IsRequired?: boolean;
  }[];
}

export const emptyCatalog = (term: string): TermCatalog => ({
  term,
  fetchedAt: new Date(0).toISOString(),
  sections: [],
  courses: [],
});

/**
 * Seat counts move hourly during registration while meeting times do not, so
 * age is a reason to refresh availability, never to distrust the timetable.
 */
export function ageInHours(catalog: TermCatalog, now = Date.now()): number {
  return (now - Date.parse(catalog.fetchedAt)) / 3_600_000;
}

/**
 * Empty means stale, but "empty" differs by catalog: a term is defined by its
 * sections, while the full course list has none at all and is defined by its
 * courses.
 */
export const isStale = (catalog: TermCatalog, maxAgeHours = 6, now = Date.now()) =>
  (catalog.sections.length === 0 && (catalog.courses?.length ?? 0) === 0) ||
  ageInHours(catalog, now) > maxAgeHours;

/** Sections whose course is in the given set, for narrowing to a degree plan. */
export function forCourses(catalog: TermCatalog, courseIds: Set<string>): ListingSection[] {
  return catalog.sections.filter((s) => courseIds.has(s.CourseId));
}
