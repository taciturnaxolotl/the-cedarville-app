/**
 * Sections, meeting times, and whether two of them collide.
 *
 * The subtle part is dates. A 16-week term routinely contains 8-week sessions,
 * and two half-semester sections can share a weekday and an hour without ever
 * being in the same room at the same time. A conflict check that compares only
 * day and time reports phantom clashes and quietly makes half the catalog look
 * unschedulable, so every meeting carries its own date range and every
 * comparison uses it.
 */

import type { Section, SectionsResponse } from "./types";

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface Meeting {
  days: Weekday[];
  /** Minutes since midnight, local. */
  start: number;
  end: number;
  /** Inclusive ISO dates (YYYY-MM-DD) bounding the weeks this recurs. */
  from: string;
  to: string;
  room: string;
  online: boolean;
}

export interface Seats {
  capacity: number;
  enrolled: number;
  available: number;
  waitlisted: number;
  status: string;
}

export interface Offering {
  id: string;
  courseId: string;
  /** "CS-3310", the thing a human recognises. */
  courseName: string;
  /** Section number within the course, e.g. "01". */
  number: string;
  title: string;
  /** Colleague's registration code, the local equivalent of a CRN. */
  synonym: string;
  term: string;
  credits: { min: number; max?: number };
  seats: Seats;
  instructors: string[];
  meetings: Meeting[];
  /** Runs on dates other than the full term, so date-aware checks matter. */
  nonStandardDates: boolean;
}

// ---- parsing -----------------------------------------------------------

const DAYS: Record<string, Weekday> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  su: 0,
  m: 1,
  mo: 1,
  t: 2,
  tu: 2,
  w: 3,
  we: 3,
  th: 4,
  r: 4,
  f: 5,
  fr: 5,
  s: 6,
  sa: 6,
};

/**
 * Colleague is inconsistent about days across endpoints: sometimes integers,
 * sometimes "Monday", sometimes an "M, W, F" display string. Accept all three
 * rather than pick one and be wrong on a Tuesday.
 */
export function parseDays(raw: unknown): Weekday[] {
  const out = new Set<Weekday>();
  const add = (value: unknown) => {
    if (typeof value === "number" && value >= 0 && value <= 6) {
      out.add(value as Weekday);
      return;
    }
    if (typeof value !== "string") return;
    const key = value.trim().toLowerCase();
    if (key === "") return;
    const known = DAYS[key];
    if (known !== undefined) out.add(known);
  };

  if (Array.isArray(raw)) for (const v of raw) add(v);
  else if (typeof raw === "string") for (const part of raw.split(/[,\s/]+/)) add(part);
  else add(raw);

  return [...out].sort((a, b) => a - b);
}

/**
 * Cedarville, Ohio. Meeting times are wall-clock times on this campus, and
 * Colleague hands them over in UTC, so we need somewhere to put them back.
 */
export const CAMPUS_TZ = "America/New_York";

const CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: CAMPUS_TZ,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/**
 * Colleague sends an offset-bearing instant, pinned to an arbitrary reference
 * date: an 11:00 AM class arrives as "2026-08-11T15:00:00+00:00". Reading the
 * hour straight out of that string puts every class four hours late, so the
 * instant has to be converted back to campus time.
 */
function fromInstant(raw: string): number | null {
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;

  const parts = CLOCK.formatToParts(new Date(at));
  const hour = parts.find((p) => p.type === "hour")?.value;
  const minute = parts.find((p) => p.type === "minute")?.value;
  if (hour === undefined || minute === undefined) return null;
  // en-US 2-digit hour renders midnight as "24" in some runtimes.
  return (Number(hour) % 24) * 60 + Number(minute);
}

/**
 * Accepts the display form ("8:00 AM"), a bare clock ("08:00:00"), or an ISO
 * instant. Returns minutes since midnight in campus time, or null when the
 * meeting has no time at all, which is normal for online sections.
 *
 * Prefer the display string wherever both exist: it is what the registrar
 * shows a student, and it carries no timezone to get wrong.
 */
export function parseTime(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const text = raw.trim();

  const display = /^(\d{1,2}):(\d{2})\s*([ap])\.?m\.?$/i.exec(text);
  if (display) {
    const hour = Number(display[1]) % 12;
    const pm = display[3]!.toLowerCase() === "p";
    return (hour + (pm ? 12 : 0)) * 60 + Number(display[2]);
  }

  // An offset or a Z makes it an instant; without one it is already local.
  if (/T\d{2}:\d{2}/.test(text) && /(Z|[+-]\d{2}:?\d{2})$/.test(text)) return fromInstant(text);

  const clock = /T(\d{2}):(\d{2})/.exec(text) ?? /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(text);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);

  return null;
}

/** "2026-08-24T00:00:00" and "2026-08-24" both reduce to the date part. */
const isoDate = (raw: string | null | undefined) => (raw ?? "").slice(0, 10);

export function toOffering(section: Section, instructors: string[] = []): Offering {
  // FormattedMeetingTimes carries the display strings that fill in when the
  // structured Meetings entry has null times.
  const formatted = section.FormattedMeetingTimes ?? [];
  const raw = section.Meetings?.length ? section.Meetings : formatted;

  const meetings: Meeting[] = [];
  raw.forEach((m, i) => {
    const fallback = formatted[i];
    // Display first: zone-free, and the string the registrar itself shows.
    const start = parseTime(fallback?.StartTimeDisplay) ?? parseTime(m.StartTime);
    const end = parseTime(fallback?.EndTimeDisplay) ?? parseTime(m.EndTime);
    const days = parseDays(m.Days?.length ? m.Days : fallback?.DaysOfWeekDisplay);

    // No time or no day means nothing to place on a grid and nothing that can
    // collide. Asynchronous online work lives here.
    if (start === null || end === null || days.length === 0) return;

    meetings.push({
      days,
      start,
      end,
      from: isoDate(m.StartDate) || isoDate(section.StartDate),
      to: isoDate(m.EndDate) || isoDate(section.EndDate),
      room: [fallback?.BuildingDisplay, m.Room].filter(Boolean).join(" ").trim(),
      online: Boolean(m.IsOnline),
    });
  });

  return {
    id: section.Id,
    courseId: section.CourseId,
    courseName: section.CourseName,
    number: section.Number,
    title: section.Title,
    synonym: section.Synonym,
    term: section.TermId,
    credits: {
      min: section.MinimumCredits,
      ...(section.MaximumCredits !== null ? { max: section.MaximumCredits } : {}),
    },
    seats: {
      capacity: section.Capacity,
      enrolled: section.Enrolled,
      available: section.Available,
      waitlisted: section.Waitlisted,
      status: section.AvailabilityStatus,
    },
    instructors,
    meetings,
    nonStandardDates: Boolean(section.IsNonStandardDates),
  };
}

/**
 * The section-search view returns section fields flat on each entry, with no
 * `Section` wrapper, unlike the per-course endpoint. Same data, different
 * envelope; nothing about Colleague is uniform.
 */
export function offeringsFromListing(sections: unknown[]): Offering[] {
  return (sections ?? []).map((entry) => {
    const flat = entry as Section & { FacultyDisplay?: string[] | string };
    const faculty = flat.FacultyDisplay;
    return toOffering(flat, Array.isArray(faculty) ? faculty : faculty ? [faculty] : []);
  });
}

/** Flattens the term/section nesting Colleague wraps around a course. */
export function offeringsFrom(response: SectionsResponse): Offering[] {
  const out: Offering[] = [];
  for (const term of response.SectionsRetrieved?.TermsAndSections ?? []) {
    for (const entry of term.Sections ?? []) {
      out.push(
        toOffering(
          entry.Section,
          (entry.InstructorDetails ?? []).map((i) => i.FacultyName).filter(Boolean),
        ),
      );
    }
  }
  return out;
}

// ---- conflicts ---------------------------------------------------------

const rangesOverlap = (aFrom: string, aTo: string, bFrom: string, bTo: string) =>
  aFrom <= bTo && bFrom <= aTo;

/** Do two meetings ever put a student in two places at once? */
export function meetingsConflict(a: Meeting, b: Meeting): boolean {
  if (!a.days.some((d) => b.days.includes(d))) return false;
  // Touching is fine: a class ending at 10:00 and one starting at 10:00 are
  // back to back, not overlapping.
  if (a.start >= b.end || b.start >= a.end) return false;
  // Both open-ended dates means we cannot rule the clash out, so we keep it.
  if (!a.from || !a.to || !b.from || !b.to) return true;
  return rangesOverlap(a.from, a.to, b.from, b.to);
}

export interface Conflict {
  a: Offering;
  b: Offering;
  meetings: [Meeting, Meeting];
}

export function conflictsBetween(a: Offering, b: Offering): Conflict[] {
  const found: Conflict[] = [];
  for (const x of a.meetings) {
    for (const y of b.meetings) {
      if (meetingsConflict(x, y)) found.push({ a, b, meetings: [x, y] });
    }
  }
  return found;
}

/** Every pairwise clash in a proposed schedule. */
export function conflicts(offerings: Offering[]): Conflict[] {
  const found: Conflict[] = [];
  for (let i = 0; i < offerings.length; i++) {
    for (let j = i + 1; j < offerings.length; j++) {
      found.push(...conflictsBetween(offerings[i]!, offerings[j]!));
    }
  }
  return found;
}

export const fits = (offering: Offering, schedule: Offering[]): boolean =>
  schedule.every((other) => conflictsBetween(offering, other).length === 0);

// ---- presentation ------------------------------------------------------

export const formatTime = (minutes: number): string => {
  const hour = Math.floor(minutes / 60);
  const suffix = hour < 12 ? "am" : "pm";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(minutes % 60).padStart(2, "0")}${suffix}`;
};

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface Placed {
  offering: Offering;
  meeting: Meeting;
  day: Weekday;
}

/** One column per weekday, for a grid. Days nobody meets are dropped. */
export function week(offerings: Offering[]): { day: Weekday; items: Placed[] }[] {
  const byDay = new Map<Weekday, Placed[]>();
  for (const offering of offerings) {
    for (const meeting of offering.meetings) {
      for (const day of meeting.days) {
        const items = byDay.get(day) ?? [];
        items.push({ offering, meeting, day });
        byDay.set(day, items);
      }
    }
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a - b)
    .map(([day, items]) => ({
      day,
      items: items.sort((x, y) => x.meeting.start - y.meeting.start),
    }));
}

/** Earliest start and latest end across a schedule, for grid bounds. */
export function span(offerings: Offering[]): { start: number; end: number } | null {
  const times = offerings.flatMap((o) => o.meetings.flatMap((m) => [m.start, m.end]));
  return times.length ? { start: Math.min(...times), end: Math.max(...times) } : null;
}
