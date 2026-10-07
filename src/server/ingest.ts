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
const Section = z
  .object({
    Id: z.string().min(1),
    CourseId: z.string().min(1),
    CourseName: z.string(),
    TermId: z.string().min(1),
    MinimumCredits: z.number(),
    Capacity: z.number(),
    Enrolled: z.number(),
    Available: z.number(),
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
  | { ok: true; sections: number; courses: number; replaced: boolean }
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
 * The term under which the whole catalog lives, which never arrives by
 * ingest: it is 900-odd courses with no sections, and the shrink guard
 * counts sections. Refused by name rather than by accident.
 */
const SENTINELS = new Set(["ALL"]);

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

export function ingest(store: CatalogStore, raw: unknown): Verdict {
  const parsed = Ingest.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, why: `malformed crawl: ${first?.path.join(".")} ${first?.message}` };
  }
  const body = parsed.data;

  if (SENTINELS.has(body.term)) {
    return { ok: false, why: `${body.term} is not a term and cannot be ingested` };
  }

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

  const held = store.read(body.term).sections.length;
  const floor = Math.floor(held * (1 - SHRINK_LIMIT));
  if (body.sections.length < floor) {
    return {
      ok: false,
      why:
        `refusing to shrink ${body.term} from ${held} sections to ${body.sections.length}; ` +
        `a crawl may lose up to ${Math.round(SHRINK_LIMIT * 100)}% of a term, not more`,
    };
  }

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
  };
}
