/**
 * Taking a crawl from a student, for everybody.
 *
 * The catalog used to be readable without a session, so the server crawled it
 * and trusted itself. Cedarville put it behind SSO, and the only thing left
 * with a session is a student's browser. So the crawl moved there, and the
 * shared cache now has to accept data from the people using it.
 *
 * That is a different problem from fetching it. A crawl the server performed
 * was true by construction; a crawl posted to the server is a claim. The
 * cache is read by every other student, so a bad claim is not one person's
 * problem.
 *
 * Three guards, in the order a bad payload meets them:
 *
 *   shape         every section is checked field by field, and one bad
 *                 section refuses the batch rather than being skipped. A
 *                 skipped section is indistinguishable from a cancelled one.
 *
 *   completeness  the client says whether it paged to the end, and only a
 *                 complete crawl may replace a term. `store.replace` deletes
 *                 what the crawl did not see, so an interrupted crawl would
 *                 cancel half a term's sections.
 *
 *   no shrinking  a crawl that would remove a large share of a term it did
 *                 not fill is refused. This is the one that makes the route
 *                 safe to leave open: without it, three well-formed sections
 *                 and `complete: true` empty the catalog for everyone.
 *
 *   a real term   the term is a code the registrar could actually issue, in
 *                 a year somebody could actually be enrolled in. Without
 *                 this the route accepts any 32-character string, so a
 *                 hosted cache would grow a new twenty-thousand-section
 *                 table for every name anyone cared to invent.
 *
 * Two different things arrive here. A term is what is *offered*: sections,
 * with their course records alongside. `ALL` is what *exists*: every course
 * in the catalog and no sections at all, which is a separate crawl because a
 * prerequisite is routinely a course nobody is teaching this year. Built from
 * one term's courses alone the prerequisite graph loses a third of its nodes,
 * and a student sees a planned course with no title, no credits and no
 * requisites — which is what happened the first time this was hosted, because
 * the server used to crawl the whole catalog itself and SSO ended that.
 *
 * So both are accepted, and each is checked for being the thing it claims to
 * be: a term that brought no sections is a failed crawl, and an `ALL` that
 * brought sections is confused about which crawl it ran.
 *
 * What is deliberately not here is identity. There is no account system and
 * nothing to attach one to, so the guards are all about the claim rather than
 * the claimant. A determined student with a real session can still post a
 * plausible lie about the catalog; what they cannot do is quietly delete it.
 */

import { z } from "zod";
import type { TermCatalog } from "../catalog";
import type { CatalogStore } from "./store";

/**
 * The fields the planner actually reads, required, and everything else
 * allowed through untouched.
 *
 * Strict on what is used and loose on the rest, deliberately: Ellucian adds
 * fields between releases, and a schema that rejects unknown keys would turn
 * every upstream addition into an outage. A missing `Id` is a different
 * matter, because it is the primary key.
 */
/**
 * Cedarville's heaviest single course is eight credits; the ceiling here is
 * loose enough not to argue with the registrar and tight enough that a
 * section cannot claim to be worth a semester on its own.
 */
const MAX_CREDITS = 24;
/** Nobody enrols twenty thousand students in one section. */
const MAX_SEATS = 10_000;

const Section = z
  .object({
    Id: z.string().min(1),
    CourseId: z.string().min(1),
    CourseName: z.string(),
    TermId: z.string().min(1),
    // Bounded, not merely numeric. A negative or absurd credit count is not
    // a thing Colleague says, and the planner adds these up to decide whether
    // a term is full.
    MinimumCredits: z.number().min(0).max(MAX_CREDITS),
    Capacity: z.number().min(0).max(MAX_SEATS),
    Enrolled: z.number().min(0).max(MAX_SEATS),
    // Available goes negative on an over-enrolled section, which is a thing
    // a registrar's override really does produce.
    Available: z.number().min(-MAX_SEATS).max(MAX_SEATS),
    Meetings: z.array(z.unknown()),
  })
  .passthrough();

const Course = z
  .object({
    Id: z.string().min(1),
    SubjectCode: z.string().min(1),
    Number: z.string().min(1),
  })
  .passthrough();

export const Ingest = z.object({
  term: z.string().min(1).max(32),
  /** Whether the crawl paged all the way to the end. Only a complete one may replace. */
  complete: z.boolean(),
  sections: z.array(Section).max(20_000),
  courses: z.array(Course).max(20_000).optional(),
});

export type IngestBody = z.infer<typeof Ingest>;

export type Verdict =
  | {
      ok: true;
      sections: number;
      courses: number;
      replaced: boolean;
      /**
       * What this crawl did to the term it replaced, which is the part worth
       * reading in a log. Wholesale fabrication is refused outright; what
       * gets through is bounded, and these are the bounds it used.
       */
      changed?: { kept: number; added: number; gone: number };
    }
  | { ok: false; why: string };

/**
 * How much of a term a crawl is allowed to remove.
 *
 * Sections genuinely disappear between crawls, so demanding a crawl never
 * shrink a term would refuse every honest refresh late in registration. A
 * fifth is far more than the churn we have measured and far less than the
 * loss a truncated or malicious crawl would cause.
 */
const SHRINK_LIMIT = 0.2;

/**
 * The term under which the whole catalog lives: every course the school
 * lists, with no sections. Its guards count courses, because there are no
 * sections here to count.
 */
const EVERY_COURSE = "ALL";

/** "2027SP". The only shape the rest of this codebase can sort or compare. */
const TERM_CODE = /^(\d{4})(SP|SU|FA)$/;

/**
 * How far either side of now a term may be.
 *
 * Generous on purpose: a catalog is published a year or so ahead, and an old
 * term is worth keeping for anyone reading their own history. What this
 * refuses is the year 9999, which is not a term but a way to make a hosted
 * cache grow for as long as somebody keeps asking.
 */
const YEARS_BACK = 10;
const YEARS_AHEAD = 3;

/**
 * The course list rather than a term's timetable.
 *
 * Same three questions as a term, asked of the thing that is actually here:
 * did the crawl finish, did it bring anything, and is it about to replace a
 * larger list with a smaller one. Sections are refused outright because their
 * presence means the caller ran the per-term crawl and posted it under the
 * wrong name, and accepting that would file one term's offerings as the whole
 * catalog.
 */
function everyCourse(store: CatalogStore, body: IngestBody): Verdict {
  if (!body.complete) {
    return { ok: false, why: "crawl did not reach the last page; a partial catalog is not one" };
  }
  if (body.sections.length) {
    return {
      ok: false,
      why: `${EVERY_COURSE} is every course and no sections; ${body.sections.length} arrived`,
    };
  }
  const courses = body.courses ?? [];
  if (courses.length === 0) {
    return { ok: false, why: "a catalog with no courses is a failed crawl" };
  }

  const held = store.readCourses(EVERY_COURSE).length;
  const floor = Math.floor(held * (1 - SHRINK_LIMIT));
  if (courses.length < floor) {
    return {
      ok: false,
      why:
        `refusing to shrink the course list from ${held} to ${courses.length}; ` +
        `a crawl may lose up to ${Math.round(SHRINK_LIMIT * 100)}% of it, not more`,
    };
  }

  store.replace({
    term: EVERY_COURSE,
    fetchedAt: new Date().toISOString(),
    sections: [],
    // Carried through whole, like a term's: the records hold far more than
    // this file names, and the planner reads requisites out of them.
    courses: courses as unknown as TermCatalog["courses"],
  });
  return { ok: true, sections: 0, courses: courses.length, replaced: held > 0 };
}

export function ingest(store: CatalogStore, raw: unknown): Verdict {
  const parsed = Ingest.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, why: `malformed crawl: ${first?.path.join(".")} ${first?.message}` };
  }
  const body = parsed.data;

  if (body.term === EVERY_COURSE) return everyCourse(store, body);

  const named = TERM_CODE.exec(body.term);
  if (!named) {
    return { ok: false, why: `"${body.term}" is not a term code; Colleague writes them "2027SP"` };
  }
  const year = Number(named[1]);
  const now = new Date().getFullYear();
  if (year < now - YEARS_BACK || year > now + YEARS_AHEAD) {
    return {
      ok: false,
      why: `${body.term} is outside the years this catalog keeps (${now - YEARS_BACK}-${now + YEARS_AHEAD})`,
    };
  }
  if (!body.complete) {
    return { ok: false, why: "crawl did not reach the last page; a partial term is not a term" };
  }
  if (body.sections.length === 0) {
    return { ok: false, why: "a term with no sections is a failed crawl, not an empty term" };
  }

  // Every section must claim the term it was posted under. A crawl that
  // mixes terms would write Fall sections into the Spring cache, and the
  // shrink guard counts rows rather than reading them.
  const astray = body.sections.find((s) => s.TermId !== body.term);
  if (astray) {
    return { ok: false, why: `section ${astray.Id} belongs to ${astray.TermId}, not ${body.term}` };
  }

  /*
   * A course nobody has ever heard of.
   *
   * The sections are the part of a crawl nothing can check — ten o'clock is
   * as plausible as eleven — but the *courses* they claim to be sections of
   * are checkable against the list of every course the school offers, which
   * arrives by its own crawl and has its own guards. So a crawl may lie about
   * when a real course meets; it may not invent the course.
   *
   * Checked against the list already held rather than the one in this
   * payload, or inventing a course and its sections would be one request.
   * Skipped entirely until somebody has filled that list, because refusing
   * every section on a server that knows no courses yet would mean no server
   * could ever be filled.
   *
   * By code rather than by id, which is not a shortcut. About 1% of codes
   * carry two records — a course being retired beside its replacement, both
   * live during the transition — and the course list keeps one id per code
   * while a section may reference either. Checked by id, one honest section
   * of 1,728 refused the whole spring: EDEC-2300 taught under course 5185,
   * listed under 2868. A code is also what the rest of this application
   * identifies a course by.
   */
  const known = new Set(store.readCourses(EVERY_COURSE).map((c) => `${c.SubjectCode}-${c.Number}`));
  if (known.size) {
    const invented = body.sections.find((s) => !known.has(s.CourseName));
    if (invented) {
      return {
        ok: false,
        why:
          `section ${invented.Id} claims course ${invented.CourseName}, ` +
          "which is in no catalog this server holds",
      };
    }
  }

  /*
   * Agreement with the term already held.
   *
   * Counting sections let a crawl swap a real term for a same-sized
   * fabrication, which is the one thing a cache this open must not accept.
   * Comparing the section ids instead means a replacement has to *be* the
   * term it is replacing: it may add, it may lose a fifth, and everything
   * else has to still be there.
   */
  const standing = store.read(body.term).sections;
  const ids = new Set(body.sections.map((s) => s.Id));
  const kept = standing.filter((s) => ids.has(s.Id)).length;
  const floor = Math.ceil(standing.length * (1 - SHRINK_LIMIT));
  if (standing.length && kept < floor) {
    return {
      ok: false,
      why:
        `this crawl keeps ${kept} of the ${standing.length} sections ${body.term} already has; ` +
        `a crawl may lose up to ${Math.round(SHRINK_LIMIT * 100)}% of a term, not replace it`,
    };
  }
  const held = standing.length;

  const catalog: TermCatalog = {
    term: body.term,
    fetchedAt: new Date().toISOString(),
    // Validated above for the fields the planner reads, and carried through
    // whole: Colleague's own records hold far more than this file names, and
    // narrowing them to the validated subset would throw away the meeting
    // times the schedule is built from.
    sections: body.sections as unknown as TermCatalog["sections"],
    courses: body.courses as unknown as TermCatalog["courses"],
  };
  const sections = store.replace(catalog);

  return {
    ok: true,
    sections,
    courses: body.courses?.length ?? 0,
    replaced: held > 0,
    changed: { kept, added: body.sections.length - kept, gone: held - kept },
  };
}
