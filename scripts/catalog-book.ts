#!/usr/bin/env bun

/*
 * Reads a year of the printed academic catalog into .data/book-<year>.json.
 *
 * Colleague knows what a degree requires but not the arithmetic behind it.
 * The book knows the arithmetic: the Curriculum Summary states each bucket's
 * size and the degree total, and where a course pays for two requirements the
 * summary shrinks by exactly its credits. That is the checksum a generated
 * plan can be held to.
 *
 *   bun scripts/catalog-book.ts            # the current year
 *   bun scripts/catalog-book.ts 2022-2023  # an archived one, for retired courses
 *
 * A few hundred requests against a publisher's host. Run it rarely.
 */

import { creditCeiling, genEdCredits, impliedOverlap, totalCredits } from "../src/book";
import { type CatalogYear, crawlBook } from "../src/server/book";

/** August starts the academic year, so "2026-2027" is right from then on. */
function currentYear(now = new Date()): CatalogYear {
  const start = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  return `${start}-${start + 1}`;
}

const year = process.argv[2] ?? currentYear();
if (!/^\d{4}-\d{4}$/.test(year)) throw new Error(`expected a year like 2025-2026, got ${year}`);

const book = await crawlBook(year, {
  // Redrawing one line is for a terminal; piped to a file it is 336 lines of
  // noise burying the summary that follows.
  onProgress: process.stdout.isTTY
    ? ({ page, pages, programs }) =>
        process.stdout.write(`\r  ${`${page}/${pages}`.padEnd(8)} ${programs} programs`)
    : undefined,
});
if (process.stdout.isTTY) process.stdout.write("\r");

const path = `.data/book-${year}.json`;
await Bun.write(path, JSON.stringify(book, null, 2));
console.log(`wrote ${path} — ${book.programs.length} programs across ${book.pages} pages`);

// A quick read of what was learned, since the whole point is the arithmetic.
const withOverlap = book.programs.filter((p) => impliedOverlap(p) > 0);
const withFootnotes = book.programs.filter((p) => p.doubleCounts.length);
console.log(`  ${withFootnotes.length} programs footnote a course as counting twice`);
console.log(`  ${withOverlap.length} more imply overlap by arithmetic alone`);

for (const code of process.argv.slice(3)) {
  const program = book.programs.find((p) => p.title.toLowerCase().includes(code.toLowerCase()));
  if (!program) {
    console.log(`\n${code}: no program page matched`);
    continue;
  }
  console.log(`\n${program.title} (page ${program.page})`);
  for (const line of program.summary) {
    const value = line.min === line.max ? `${line.min}` : `${line.min}-${line.max}`;
    console.log(`  ${line.label.padEnd(52, ".")} ${value}`);
  }
  console.log(
    `  → total ${totalCredits(program)}, ceiling ${creditCeiling(program)}, gen ed ${genEdCredits(program)}, overlap ${impliedOverlap(program)}`,
  );
  for (const d of program.doubleCounts)
    console.log(`  also pays for ${d.requirement}: ${d.course}`);
}
