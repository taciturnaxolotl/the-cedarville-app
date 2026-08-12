/**
 * The printed catalog, read as data.
 *
 * Colleague publishes requirements but not the arithmetic behind them. It will
 * say a degree needs 128 credits and list the groups, yet never say that
 * `GBIO-1000` pays for both a cognate and the biological-science general
 * education slot. The registrar does say it, in the catalog, twice over: once
 * as a footnote on the course, and once in the Curriculum Summary, where the
 * general-education line shrinks by exactly the credits absorbed elsewhere.
 *
 *   Cyber Operations   gen ed 41.5 + major 64-67 + cognates 15 + electives 4.5-7.5 = 128
 *   Computer Engr      gen ed 38   + major 65    + cognates 29                     = 132
 *
 * That 3.5-credit difference is `GBIO-1000` counted once instead of twice.
 *
 * The catalog lives on FlippingBook, which renders a plain-HTML page per page
 * of the book. There is no PDF, no OAI feed, and no Acalog or CourseLeaf
 * behind it — the per-page HTML is the whole of the machine-readable surface,
 * so this parses the printed layout rather than a data format. Dot leaders are
 * the one thing the typesetting is reliable about, so every rule here hangs
 * off them.
 */

/** A `Label.........12.5` line, or `Label......0–4` when it is a range. */
export interface SummaryLine {
  label: string;
  min: number;
  /** Equal to `min` unless the catalog printed a range. */
  max: number;
}

/** A footnote saying a course pays for a general education slot as well. */
export interface DoubleCount {
  /** "GBIO-1000". */
  course: string;
  /** "biological science", as the catalog words it. */
  requirement: string;
}

export interface SequenceEntry {
  /** "CS-1210", or undefined for a placeholder like "History Elective". */
  code?: string;
  text: string;
  credits: number;
}

export interface SequenceYear {
  /** 1-4, occasionally 5. */
  year: number;
  entries: SequenceEntry[];
  /** The catalog's own total for the year, for checking our parse. */
  total?: number;
}

export interface ProgramPage {
  /** Page number within the book, which is also its URL segment. */
  page: number;
  title: string;
  summary: SummaryLine[];
  doubleCounts: DoubleCount[];
  sequence: SequenceYear[];
  /** Every course code named anywhere on the page. Used to match programs. */
  courses: string[];
}

const COURSE = /\b[A-Z]{2,5}-\d{4}[A-Z]?\b/g;
/** Four or more dot leaders, then a number, optionally a range. */
const LEADER = /([A-Za-z][^.\n]*?)\.{4,}\s*(\d+(?:\.\d+)?)(?:\s*[–—-]\s*(\d+(?:\.\d+)?))?/g;
/**
 * A footnote marker sits flush against the course code — `3GBIO-1000` — while
 * a credit value is always separated by a space. That gap is the only thing
 * telling the two apart.
 */
const MARKED = /(?:^|\s)(\d)([A-Z]{2,5}-\d{4}[A-Z]?)\b/g;
const FOOTNOTE = /(?:^|\s)(\d)\s?Satisfies (?:the )?(.+?)(?: elective)? general education/g;
const YEAR_HEADS = ["First", "Second", "Third", "Fourth", "Fifth"];
const TOTAL = /^Total\b/i;
const GEN_ED = /^General Education/i;
const PROFICIENCY = /^Proficiency/i;
/**
 * A word that can belong to a program heading: capitalised, a dash, or one of
 * the few lowercase connectors real names use ("Bachelor of Music Education").
 */
const HEADING_WORD = /^(?:[A-Z(][A-Za-z'’()/&,-]*|[—–-]+|of|and|for|the|in|with|a|an)$/;

/** FlippingBook emits one word per element; collapse it back to a paragraph. */
function flatten(html: string): string {
  return html.replace(/\s+/g, " ").trim();
}

function slice(text: string, from: string, until: string[]): string | undefined {
  const start = text.indexOf(from);
  if (start < 0) return undefined;
  const rest = text.slice(start + from.length);
  const end = until
    .map((u) => rest.indexOf(u))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)[0];
  return end === undefined ? rest : rest.slice(0, end);
}

/**
 * Every `Label.....n` line, stopping after the `Total`.
 *
 * Stopping matters more than it sounds. On about a third of the pages the
 * summary is followed immediately by the program's full requirement list, set
 * in the same dot-leader style, and reading on turns a 128-credit degree into
 * a 441-credit one. The Total line is the only structural end marker the
 * layout offers, and it is the last line of every summary block.
 */
function leaders(text: string, stopAtTotal = false): SummaryLine[] {
  const lines: SummaryLine[] = [];
  for (const m of text.matchAll(LEADER)) {
    const label = (m[1] ?? "").replace(/\s+/g, " ").trim();
    const min = Number(m[2]);
    // A trailing range only counts when the catalog printed one; "0–4" is a
    // range, but "128 A complete description" is a total followed by prose.
    const max = m[3] === undefined ? min : Number(m[3]);
    if (!label) continue;
    lines.push({ label, min, max: Math.max(min, max) });
    if (stopAtTotal && TOTAL.test(label)) break;
  }
  return lines;
}

/**
 * The program's name, taken from the Curriculum Summary heading.
 *
 * The page's own display title is unusable: FlippingBook interleaves the
 * characters of headline text set in two columns, so page 151 reads
 * "C o mB pa cuht e rl oErnogfi nSecei er in cge". The summary heading is body
 * text and survives intact.
 */
function titleOf(text: string, at: number): string {
  // Take trailing words while they still look like a heading, rather than
  // cutting at a delimiter. Headings are Title Case, and whatever precedes
  // them — a footnote legend, the end of a sentence, a credit value — is not.
  const words = text
    .slice(Math.max(0, at - 120), at)
    .trim()
    .split(/\s+/);
  const heading: string[] = [];
  for (let i = words.length - 1; i >= 0; i--) {
    const word = words[i];
    if (!word || !HEADING_WORD.test(word)) break;
    heading.unshift(word);
  }
  return (
    heading
      .join(" ")
      .replace(/^[.\s*]+/, "")
      .trim()
      // "*Capstone Course" legends butt straight against the heading, and the
      // star has already been dropped as a non-heading word.
      .replace(/^(?:Capstone )?Courses?(?: for .+? program)?\s+/i, "")
      .replace(/\s+Major$/, "")
      .trim()
  );
}

function sequenceOf(text: string): SequenceYear[] {
  const body = slice(text, "Suggested Four-Year Curriculum", ["Made with FlippingBook"]);
  if (!body) return [];

  const years: SequenceYear[] = [];
  for (const [index, head] of YEAR_HEADS.entries()) {
    const chunk = slice(
      body,
      `${head} Year:`,
      YEAR_HEADS.slice(index + 1).map((h) => `${h} Year:`),
    );
    if (!chunk) continue;

    const entries: SequenceEntry[] = [];
    let total: number | undefined;
    // Same reasoning as the summary: the final year runs straight into the
    // footer and the next program, so the printed Total ends the year.
    for (const line of leaders(chunk, true)) {
      if (TOTAL.test(line.label)) {
        total = line.min;
        break;
      }
      entries.push({
        code: line.label.match(COURSE)?.[0],
        text: line.label,
        credits: line.min,
      });
    }
    if (entries.length) years.push({ year: index + 1, entries, total });
  }
  return years;
}

/** Parse one catalog page, or return undefined when it is not a program page. */
export function parseProgramPage(page: number, html: string): ProgramPage | undefined {
  const text = flatten(html);
  const at = text.indexOf("Curriculum Summary");
  if (at < 0) return undefined;

  const summary = leaders(
    slice(text, "Curriculum Summary", [
      "A complete description",
      "Suggested Four-Year",
      "Made with FlippingBook",
    ]) ?? "",
    true,
  );
  // Without a Total there is nothing to check a plan against, and the block is
  // more likely a requirement list that happened to follow the heading.
  if (!summary.some((l) => TOTAL.test(l.label))) return undefined;

  // Footnote markers and their definitions are far apart on the page, so pair
  // them by number rather than position.
  const meanings = new Map(
    [...text.matchAll(FOOTNOTE)].map(
      (m) => [m[1] ?? "", (m[2] ?? "").replace(/\s+/g, " ").trim()] as const,
    ),
  );
  const doubleCounts: DoubleCount[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(MARKED)) {
    const course = m[2];
    const requirement = meanings.get(m[1] ?? "");
    if (!course || !requirement || seen.has(course)) continue;
    seen.add(course);
    doubleCounts.push({ course, requirement });
  }

  return {
    page,
    title: titleOf(text, at),
    summary,
    doubleCounts,
    sequence: sequenceOf(text),
    courses: [...new Set(text.match(COURSE) ?? [])].sort(),
  };
}

// ---- reading the summary -------------------------------------------------

/** The degree's stated minimum, which is the floor a plan must clear. */
export function totalCredits(program: ProgramPage): number | undefined {
  return program.summary.find((l) => TOTAL.test(l.label))?.min;
}

/**
 * How far a plan may exceed the degree minimum before it is a modelling bug.
 *
 * A plan can legitimately run over: proficiency requirements sit outside the
 * total, and a student may hold courses that fit nowhere. It cannot
 * legitimately run over by more than the summary's own slack, so this gives a
 * ceiling worth asserting against.
 */
export function creditCeiling(program: ProgramPage): number | undefined {
  const total = totalCredits(program);
  if (total === undefined) return undefined;
  // Proficiency is the one range that must not widen the ceiling: the total
  // says so itself, "minimum, not including proficiency".
  const slack = program.summary
    .filter((l) => !TOTAL.test(l.label) && !PROFICIENCY.test(l.label))
    .reduce((n, l) => n + (l.max - l.min), 0);
  return total + slack;
}

/**
 * Credits the catalog says are counted twice, and so must not be scheduled
 * twice. Only where the registrar footnoted it: 21 of the 76 program pages in
 * the 2025-26 book do, and cyber operations is not among them.
 */
export function absorbed(program: ProgramPage, credits: (code: string) => number): number {
  return program.doubleCounts.reduce((n, d) => n + credits(d.course), 0);
}

/** Whether the general education line was reduced, which implies double counts. */
export function genEdCredits(program: ProgramPage): number | undefined {
  return program.summary.find((l) => GEN_ED.test(l.label))?.min;
}

/**
 * Credits that must be counted twice for the summary's own arithmetic to work.
 *
 * The footnotes only cover 7 of 75 programs, but the summary gives the same
 * fact away by construction: when the parts sum past the stated total, the
 * difference is coursework filling two slots at once. Middle Childhood
 * Education lists 138.5 credits of parts against a 133-credit degree, and
 * that 5.5 is real overlap the registrar never footnoted.
 *
 * Zero means the catalog claims no overlap — which is itself worth knowing.
 * Cyber operations reports zero, so a plan for it that exceeds the total is
 * over-scheduling rather than double-counting.
 */
export function impliedOverlap(program: ProgramPage): number {
  const total = totalCredits(program);
  if (total === undefined) return 0;
  const parts = program.summary
    .filter((l) => !TOTAL.test(l.label) && !PROFICIENCY.test(l.label))
    .reduce((n, l) => n + l.min, 0);
  return Math.max(0, parts - total);
}

// ---- matching a page to a Colleague program ------------------------------

/**
 * Which catalog page describes a program, judged by the courses it names.
 *
 * Titles are the obvious key and the wrong one. Colleague calls the program
 * "BS Cyber Operations" and the catalog "Cyber Operations — Bachelor of
 * Science"; worse, several programs share a page with a track that differs
 * only in a parenthetical. Course lists collide far less often, and a student
 * on any program gets the same treatment without a lookup table.
 */
export function matchProgram(
  pages: readonly ProgramPage[],
  required: ReadonlySet<string>,
): ProgramPage | undefined {
  if (!required.size) return undefined;

  let best: { page: ProgramPage; score: number } | undefined;
  for (const page of pages) {
    const shared = page.courses.filter((c) => required.has(c)).length;
    // Jaccard rather than raw overlap: a page listing every course in the book
    // would otherwise beat the page that actually describes the program.
    const score = shared / (page.courses.length + required.size - shared);
    if (!best || score > best.score) best = { page, score };
  }
  // Below this the "match" is a handful of shared general-education courses,
  // which every program in the book has.
  return best && best.score >= 0.25 ? best.page : undefined;
}
