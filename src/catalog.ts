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

/**
 * A slot's name as Colleague spells it: "2027SP" for the spring of 2027.
 *
 * Our own names are short because they are read in a column ("SP27"); Colleague
 * wants the year first, and every write to a degree plan is keyed on it.
 */
export const termCodeOf = (slot: { year: number; season: "fall" | "spring" | "summer" }) =>
  `${slot.year}${slot.season === "spring" ? "SP" : slot.season === "summer" ? "SU" : "FA"}`;

/** Oldest first. Negate for newest first. */
export const compareTerms = (a: string, b: string) => termKey(a) - termKey(b);

/**
 * The first term a plan may use: the one after whichever is under way.
 *
 * Naming it literally is how a planner goes stale without anything looking
 * broken — "SP27" was written into two files and would have quietly kept
 * projecting a plan that started in the past. Cedarville's autumn runs from
 * August, so from August the next term to plan is the spring after it, and
 * before that it is the autumn of the same year. Summers are never a starting
 * point: nothing about a degree begins in one.
 */
export function nextPlannableTerm(now: Date): { year: number; season: "spring" | "fall" } {
  const year = now.getFullYear();
  return now.getMonth() >= 7 ? { year: year + 1, season: "spring" } : { year, season: "fall" };
}

/**
 * The term happening now, as Colleague names it.
 *
 * Distinct from `nextPlannableTerm`, which answers "where does a plan start".
 * This one answers "what is on offer today", which is what an empty catalog
 * needs before anyone can fetch anything: with no terms cached and no
 * extension installed there is otherwise nothing to name, and a first run
 * offers a menu with no items in it.
 *
 * Cedarville's autumn runs August to December, spring January to April, and
 * the summer sessions fill the rest.
 */
export function termNow(now: Date): string {
  const month = now.getMonth();
  const season = month >= 7 ? "FA" : month <= 3 ? "SP" : "SU";
  return `${now.getFullYear()}${season}`;
}

/**
 * The seasons a course is taught, as the registrar states them.
 *
 * `TermsOffered` is prose but a closed set of it: seven spellings cover all
 * 1,945 courses that carry one. An empty result means the field was absent,
 * which is not the same as "never" — 82 courses say nothing, and a caller
 * should read that as unknown rather than as a refusal.
 */
export function seasonsOffered(record: {
  TermsOffered?: string;
}): ("fall" | "spring" | "summer")[] {
  const text = (record.TermsOffered ?? "").toLowerCase();
  if (!text) return [];
  const seasons: ("fall" | "spring" | "summer")[] = [];
  if (text.includes("fall")) seasons.push("fall");
  if (text.includes("spring")) seasons.push("spring");
  if (text.includes("summer")) seasons.push("summer");
  return seasons;
}

/**
 * Which academic years a course runs in, for the ones that alternate.
 *
 * "Odd Years (ex: 2021-22)" means the academic year beginning in an odd year,
 * so a spring term belongs to the year before it. `CRJU-4160` runs spring of
 * odd academic years: spring 2028 yes, spring 2029 no.
 */
export type YearCycle = "all" | "odd" | "even";

export function yearsOffered(record: { YearsOffered?: string }): YearCycle {
  const text = (record.YearsOffered ?? "").toLowerCase();
  if (text.includes("odd")) return "odd";
  if (text.includes("even")) return "even";
  return "all";
}

/** Whether a course that alternates runs in the academic year a term sits in. */
export function runsIn(cycle: YearCycle, year: number, season: "fall" | "spring" | "summer") {
  if (cycle === "all") return true;
  // An academic year is named for the autumn that opens it, so spring and
  // summer belong to the year before them.
  const academic = season === "fall" ? year : year - 1;
  return cycle === "odd" ? academic % 2 === 1 : academic % 2 === 0;
}

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
  /**
   * When the registrar says the course runs: "Fall/Spring", "Spring Only",
   * "Fall/Spring/Summer". This is the answer to a question we had been
   * guessing at from a single term's section listing, and guessing wrong —
   * `EGCP-4210` is Fall Only and was inferred spring-only purely because it
   * did not appear in the one autumn we hold.
   */
  TermsOffered?: string;
  /** "All Years", or "Odd Years (ex: 2021-22)" for a course taught alternately. */
  YearsOffered?: string;
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
