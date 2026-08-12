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
