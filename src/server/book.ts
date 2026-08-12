/**
 * Fetching the printed catalog.
 *
 * The book lives on FlippingBook, which renders one plain-HTML page per page
 * of the publication. There is no PDF download, no OAI feed, and no Acalog or
 * CourseLeaf behind it, so a page at a time is the whole of what is on offer.
 * Every catalog year from 2019-20 forward is archived at the same shape of
 * URL, which is what makes retired courses recoverable: a requisite naming
 * `MATH-1720` is legible only against the year that still had it.
 *
 * This is a few hundred requests against a marketing host, run rarely and
 * cached, rather than anything a student's browser should do.
 */

import { type ProgramPage, parseProgramPage } from "../book";

/** "2025-2026". Both halves are full years, and they must be consecutive. */
export type CatalogYear = string;

export interface BookProgress {
  page: number;
  pages: number;
  programs: number;
}

export interface BookOptions {
  /** Gap between pages. This is a publisher, not a load test. */
  delayMs?: number;
  onProgress?: (progress: BookProgress) => void;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

export interface Book {
  year: CatalogYear;
  pages: number;
  programs: ProgramPage[];
  fetchedAt: string;
}

const BASE = "https://publications.cedarville.edu/academiccatalogs";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const pageUrl = (year: CatalogYear, page: number) => `${BASE}/${year}/${page}/`;

/**
 * Strip a page to its text.
 *
 * FlippingBook emits the body one word per element, so tags collapse to
 * whitespace and the paragraph comes back intact. Scripts and styles have to
 * go first or their contents land in the text.
 */
export function textOf(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&(?:quot|#34);/g, '"')
    .replace(/&(?:apos|#39);/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ");
}

/**
 * How many pages the book has, read from the navigation.
 *
 * Every page links to the last page as its "jump to end" control, so the
 * largest page reference on page one is the page count. Catalogs have run
 * between 320 and 352 pages, so nothing here should be hard-coded.
 */
export async function pageCount(
  year: CatalogYear,
  get: typeof globalThis.fetch = fetch,
): Promise<number> {
  const html = await (await get(pageUrl(year, 1))).text();
  const refs = [...html.matchAll(/href="\.\.\/(\d+)\/"/g)].map((m) => Number(m[1]));
  const most = Math.max(0, ...refs);
  if (!most) throw new Error(`no page navigation found for catalog ${year}`);
  return most;
}

/** Read a whole catalog year, keeping only the pages that describe a program. */
export async function crawlBook(year: CatalogYear, options: BookOptions = {}): Promise<Book> {
  const { delayMs = 150, onProgress, signal, fetch: get = fetch } = options;
  const pages = await pageCount(year, get);
  const programs: ProgramPage[] = [];

  for (let page = 1; page <= pages; page++) {
    signal?.throwIfAborted();
    const response = await get(pageUrl(year, page), { signal });
    // A gap in the book is not a reason to abandon the rest of it.
    if (response.ok) {
      const program = parseProgramPage(page, textOf(await response.text()));
      if (program) programs.push(program);
    }
    onProgress?.({ page, pages, programs: programs.length });
    if (page < pages && delayMs) await sleep(delayMs);
  }

  return { year, pages, programs, fetchedAt: new Date().toISOString() };
}
