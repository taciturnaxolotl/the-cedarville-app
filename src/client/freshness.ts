/*
 * When a crawl is worth the pages.
 *
 * Reading a term costs nineteen pages of somebody's Self-Service session and
 * the course list twenty-one, so the question comes up on every load and the
 * answer wants to be in one place. Too eager and every page view spends forty
 * pages; too lazy and a student plans a spring against a timetable from
 * before registration opened.
 *
 * Both windows are measured against the *shared* copy rather than the
 * browser's, so the first student each day pays the pages and everybody after
 * them reads what that student shared.
 */

/** A term's sections move through registration: opened, filled, cancelled. */
export const TERM_HOURS = 24;

/**
 * The course list is catalog-year data — what exists, with its requisites and
 * seasons — and changes when the catalog does and not otherwise. Re-reading
 * twenty-one pages of it daily would be waste.
 */
export const COURSE_LIST_HOURS = 24 * 7;

/** Whether a timestamp is old enough to be worth replacing. */
export const olderThan = (hours: number, fetchedAt: string | undefined, now = Date.now()) =>
  !fetchedAt || now - Date.parse(fetchedAt) > hours * 3_600_000;

export interface Held {
  /** Sections the shared cache holds for this term. */
  sections: number;
  /** When it last crawled them. */
  fetchedAt?: string;
}

/**
 * What to do about a term: read the shared copy, crawl a fresh one, or admit
 * there is neither.
 *
 * `crawl` needs a session and so needs the extension, which is why its
 * absence turns a crawl into whatever the cache has — a stale timetable said
 * to be stale beats no timetable at all.
 */
export type Plan = "crawl" | "fetch" | "refuse";

export function planFor(
  held: Held,
  options: { force?: boolean; installed?: boolean; now?: number } = {},
): Plan {
  const { force = false, installed = false, now = Date.now() } = options;
  const empty = held.sections === 0;
  // Asked for outright, never crawled, or a day old.
  const worthIt = force || empty || olderThan(TERM_HOURS, held.fetchedAt, now);

  if (worthIt && installed) return "crawl";
  return empty ? "refuse" : "fetch";
}

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/**
 * Largest unit first, so an hour-old crawl is not reported in seconds and a
 * copy dated to the epoch is not reported as twenty thousand days. Years and
 * months are the average kind, which is what a relative label wants.
 */
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_557_600_000],
  ["month", 2_629_800_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/**
 * How long ago, in the unit a person would have chosen.
 *
 * "yesterday" rather than "27 hours ago", and "just now" rather than "in 3
 * seconds" when a clock is a little ahead of the server's — a planner that
 * claims to hold tomorrow's timetable reads as broken rather than as skewed.
 */
export function since(fetchedAt: string | undefined, now = Date.now()): string {
  if (!fetchedAt) return "never";
  const at = Date.parse(fetchedAt);
  if (Number.isNaN(at)) return "never";

  const elapsed = now - at;
  if (elapsed < 60_000) return "just now";
  for (const [unit, ms] of UNITS) {
    if (elapsed >= ms) return RELATIVE.format(-Math.round(elapsed / ms), unit);
  }
  return "just now";
}
