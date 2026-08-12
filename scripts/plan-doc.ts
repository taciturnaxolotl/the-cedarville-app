#!/usr/bin/env bun

/*
 * Writes .data/plan.md — a term-by-term projection built from your captured
 * evaluations and the cached catalog, so it can be regenerated whenever
 * either changes rather than going stale in a text file.
 *
 * Local only: it reads a transcript.
 */

import { absorbed, creditCeiling, impliedOverlap, matchProgram, totalCredits } from "../src/book";
import { criticalPath, projectPlan, type Season, termsFrom } from "../src/planner";
import { buildGraph, type CourseNode, eligibility, parseRequisite } from "../src/prereqs";
import {
  completedCourses,
  coursesNeeded,
  groupKey,
  inProgressCourses,
  normalize,
} from "../src/requirements";
import { offeringsFromListing } from "../src/schedule";
import type { Book } from "../src/server/book";
import { resolveGroup } from "../src/server/colleague";
import { CatalogStore } from "../src/server/store";

const store = new CatalogStore();

// Newest cached terms rather than named ones, so the projection does not keep
// reasoning from last autumn's catalog after a newer one lands.
const cached = store
  .stats()
  .map((s) => s.term)
  .filter((t) => t !== "ALL")
  .sort()
  .reverse();
const regularTerm = cached.find((t) => !t.includes("SU"));
const summerTerm = cached.find((t) => t.includes("SU"));
if (!regularTerm) throw new Error("no catalog cached; run the planner server once to crawl");

const fall = store.read(regularTerm);
const summer = summerTerm ? store.read(summerTerm) : { sections: [], courses: [] };

// Requisites come from the whole catalog; seasons from the cached terms.
const everything = store.readCourses("ALL");
const records = everything.length
  ? everything
  : [...(fall.courses ?? []), ...(summer.courses ?? [])];
const credits = new Map(
  records.map((c) => [`${c.SubjectCode}-${c.Number}`, c.MinimumCredits ?? 0]),
);
const price = (c: string) => credits.get(c) ?? 3;
const titles = new Map(records.map((c) => [`${c.SubjectCode}-${c.Number}`, c.Title]));
const graph = buildGraph(
  records.map(
    (c) =>
      ({
        code: `${c.SubjectCode}-${c.Number}`,
        title: c.Title,
        requisites: (c.CourseRequisites ?? []).map(parseRequisite),
      }) as CourseNode,
  ),
);

const inFall = new Set(offeringsFromListing(fall.sections).map((o) => o.courseName));
const inSummer = new Set(offeringsFromListing(summer.sections).map((o) => o.courseName));
/** Seen in fall implies both regular terms; spring is unpublished, so absence means spring. */
const regularSeason: Season = regularTerm.includes("SP") ? "spring" : "fall";
const offeredIn = (code: string, season: Season) =>
  season === "summer" ? inSummer.has(code) : season === regularSeason ? inFall.has(code) : true;

/**
 * The printed catalog, if it has been scraped. Colleague gives requirements;
 * the book gives the arithmetic to check a plan against. Optional on purpose —
 * a missing book costs the checksum, not the plan.
 */
const books = (
  await Array.fromAsync(
    new Bun.Glob("book-*.json").scan({ cwd: ".data", absolute: true }),
    async (path) => (await Bun.file(path).json()) as Book,
  )
).sort((a, b) => b.year.localeCompare(a.year));
const book = books[0];

const snapshot = await Bun.file(".data/evaluations.json").json();
// Whatever was captured, in capture order: no program code is named here.
const trees = Object.values(snapshot.evaluations).map((raw) => normalize(raw as never));
const cy = trees[0];
if (!cy) throw new Error("no evaluations captured; use the planner's capture button first");

const done = completedCourses(cy);
const inProgress = inProgressCourses(cy);
const have = new Set([...done, ...inProgress]);

const label = (code: string) => `${code}${titles.has(code) ? ` — ${titles.get(code)}` : ""}`;
const out: string[] = [];
const w = (line = "") => out.push(line);

w("# Degree plan");
w();
w(`Generated ${new Date().toISOString().slice(0, 10)} from the captured evaluations and the`);
w(
  `cached ${regularTerm}${summerTerm ? ` / ${summerTerm}` : ""} catalog. Regenerate with \`bun scripts/plan-doc.ts\`.`,
);
w();
w("Spring terms are modelled, not read: Colleague publishes only a term or two ahead, so a");
w("course absent from Fall 2026 is assumed to run in spring. Treat dates as a projection.");
w();
w("## Where you stand");
w();
w(`- completed **${cy.credits.completed}** credits, **${cy.credits.inProgress}** in progress`);
w(
  `- cyber ops needs **${cy.credits.minimum}**, so **${cy.credits.minimum - cy.credits.completed - cy.credits.inProgress}** remain after this term`,
);
w(`- ${done.size} courses passed, ${inProgress.size} running now`);
w();

for (const tree of trees) {
  const cap = 15;
  const name = `${tree.code} — ${tree.title}`;
  // First pass: find the groups the evaluation will not enumerate.
  const first = coursesNeeded(tree, { credits: price, have });

  const resolved = new Map<string, string[]>();
  for (const u of first.unenumerable) {
    if (u.bucket) continue; // satisfied by other coursework, not shopped for
    try {
      const options = (await resolveGroup(u.ids)).filter((c) => !have.has(c));
      if (options.length) resolved.set(groupKey(u.ids), options);
    } catch {
      // Leave it listed as unresolved rather than guessing.
    }
  }

  // Second pass: with the rules expanded, every requirement enters the same
  // cover, so a course bought for one can pay for a rule-based one too.
  const { courses: need, unenumerable } = coursesNeeded(tree, {
    credits: price,
    have,
    resolved,
  });
  for (const u of first.unenumerable) {
    const pool = resolved.get(groupKey(u.ids));
    if (pool) u.resolved = pool;
  }
  const plan = projectPlan({
    need,
    completed: have,
    graph,
    credits: price,
    offeredIn,
    slots: termsFrom({ year: 2027, season: "spring" }, 12, { capacity: cap }),
  });

  w(`## ${name}`);
  w();
  w(
    `At ${cap} credits a term with summers, named requirements finish **${plan.finishes ?? "—"}**.`,
  );
  w();

  const toGo = tree.credits.minimum - tree.credits.completed - tree.credits.inProgress;
  const printed = book && matchProgram(book.programs, new Set([...need, ...have]));

  if (plan.totalCredits > toGo) {
    w(`This schedules ${plan.totalCredits} credits against a ${toGo}-credit gap, so read the date`);
    w("as an upper bound rather than a promise. A degree minimum is a floor, and the named");
    w("requirements can sum past it: one course often satisfies a major requirement and a");
    w("general-education slot at once. The planner counts each course once, but cannot tell");
    w("which *other* slot it also fills, so it schedules for both.");
    w();
  }

  // The catalog is the only place the overlap is stated, so it is the only
  // thing that can tell an honest over-schedule from a bookkeeping artefact.
  if (printed) {
    const ceiling = creditCeiling(printed);
    const projected = tree.credits.completed + tree.credits.inProgress + plan.totalCredits;
    const overlap = impliedOverlap(printed) + absorbed(printed, price);

    w(
      `Checked against the ${book.year} catalog, page ${printed.page} (“${printed.title}”, ${totalCredits(printed)} credits).`,
    );
    w();
    if (overlap) {
      w(`The catalog counts **${overlap} credits twice**, so a plan may legitimately exceed the`);
      w("degree total by that much:");
      w();
      for (const d of printed.doubleCounts)
        w(`- ${label(d.course)} also pays for the ${d.requirement} general education requirement`);
      w();
    } else {
      w("The catalog's own arithmetic closes exactly: no course is declared as counting toward");
      w("two requirements. Anything this plan schedules past the degree total is over-scheduling");
      w("on our side rather than a requirement filling two slots.");
      w();
    }
    if (ceiling !== undefined && projected > ceiling + overlap) {
      w(
        `⚠️ This plan reaches **${projected} credits** against a stated ceiling of ${ceiling + overlap}.`,
      );
      w(`That ${(projected - ceiling - overlap).toFixed(1)}-credit excess is a bug in this model,`);
      w("not a feature of the degree. Treat the finish date as pessimistic.");
      w();
    }
  }
  for (const term of plan.terms) {
    w(`### ${term.slot.name} · ${term.credits} credits`);
    w();
    for (const c of term.courses) {
      w(
        `- ${label(c.code)} (${c.credits})${c.caution ? `  \n  _check: ${c.caution.slice(0, 110)}_` : ""}`,
      );
    }
    w();
  }
  const expanded = first.unenumerable.filter((u) => u.resolved?.length);
  const buckets = unenumerable.filter((u) => u.bucket);
  const stuck = unenumerable.filter((u) => !u.bucket && !resolved.has(groupKey(u.ids)));

  if (buckets.length) {
    w("Satisfied incidentally by other coursework, not scheduled separately:");
    w();
    for (const u of buckets)
      w(`- ${u.credits ? `**${u.credits}cr** ` : ""}${u.text || u.requirement}`);
    w();
  }
  if (expanded.length) {
    w("Rule-based requirements, expanded by asking Colleague what qualifies:");
    w();
    for (const u of expanded) {
      w(`- ${u.credits ? `**${u.credits}cr** ` : ""}${u.text}`);
      w(
        `  <br>_${u.resolved!.length} options: ${u.resolved!.slice(0, 12).join(", ")}${u.resolved!.length > 12 ? " …" : ""}_`,
      );
    }
    w();
  }
  if (stuck.length) {
    w("Still unresolved — ask your advisor what qualifies:");
    w();
    for (const u of stuck) w(`- ${u.credits ? `**${u.credits}cr** ` : ""}${u.text}`);
    w();
  }
  if (plan.unscheduled.length) {
    w("Not placed:");
    w();
    for (const u of plan.unscheduled) w(`- ${label(u.code)} — ${u.why}`);
    w();
  }
}

const path = criticalPath(graph, coursesNeeded(cy, { credits: price, have }).courses, have);
w("## The critical path");
w();
w("The longest chain of prerequisites still ahead. No credit load shortens it.");
w();
w("```");
w(path.join("  →  "));
w("```");
w();
w(`That is ${path.length} terms minimum, whatever else you do.`);
w();

w("## Blocked right now, and by what");
w();
for (const code of [...coursesNeeded(cy, { credits: price, have }).courses].sort()) {
  const verdict = eligibility(
    graph.courses.get(code) ?? { code, title: "", requisites: [] },
    done,
    inProgress,
    { exists: (c) => graph.courses.has(c) },
  );
  if (verdict.state === "blocked") w(`- **${code}** needs ${verdict.blockedBy.join(", ")}`);
}
w();
w("## What this model does not know");
w();
w("Four things it cannot see, all of which can move a date:");
w();
w("- **Class standing.** Senior seminars and capstones are placed as soon as their");
w("  prerequisites clear, so `EGGN-4010`, `HON-4910` and friends may appear years early.");
w("- **Which alternative is cheapest.** Where a requirement offers several ways to");
w("  satisfy it, the cheapest in credits is chosen. That is not always the one you");
w("  want: a language you have started, or a track you care about, may cost more.");
w("- **The spring catalog.** Unpublished. Any course absent from Fall 2026 is assumed to");
w("  run in spring, which is an inference from the curriculum guides, not a reading.");
w("- **Shared-credit caps.** Schools limit how much counts toward two programs at once,");
w("  and that policy lives in the academic catalog rather than any endpoint.");
w();
w("---");
w();
w("_Projections only. Confirm with your advisor before registering._");

await Bun.write(".data/plan.md", out.join("\n"));
console.log(`wrote .data/plan.md (${out.length} lines)`);
