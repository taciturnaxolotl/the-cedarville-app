#!/usr/bin/env bun

/*
 * Writes .data/plan.md — a term-by-term projection built from your captured
 * evaluations and the cached catalog, so it can be regenerated whenever
 * either changes rather than going stale in a text file.
 *
 * Local only: it reads a transcript.
 */

import { absorbed, creditCeiling, impliedOverlap, matchProgram, totalCredits } from "../src/book";
import { compareTerms, runsIn, seasonsOffered, yearsOffered } from "../src/catalog";
import { criticalPath, projectPlan, type Season, type TermSlot, termsFrom } from "../src/planner";
import { addSitting, buildGraph, eligibility, nodeOf } from "../src/prereqs";
import {
  baseCode,
  completedCourses,
  coursesNeeded,
  coursesNeededAcross,
  creditOverflow,
  groupCoverage,
  groupKey,
  inProgressCourses,
  normalize,
  sharedCredits,
  walkGroups,
} from "../src/requirements";
import { offeringsFromListing } from "../src/schedule";
import { sequencesFrom } from "../src/sequences";
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
  // Newest first, by the academic calendar rather than the alphabet: a plain
  // sort puts "2026FA" before "2026SP" and calls the older term the newer one.
  .sort((a, b) => compareTerms(b, a));
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
// A second sitting of a course is priced, named and dated as the course it
// is: only the plan needs to tell the two apart.
const price = (c: string) => credits.get(baseCode(c)) ?? 3;
const maxima = new Map(
  records.map((c) => [`${c.SubjectCode}-${c.Number}`, c.MaximumCredits ?? c.MinimumCredits ?? 0]),
);
const titles = new Map(records.map((c) => [`${c.SubjectCode}-${c.Number}`, c.Title]));
const graph = buildGraph(records.map(nodeOf));
const sequences = sequencesFrom(records);

const inFall = new Set(offeringsFromListing(fall.sections).map((o) => o.courseName));
const inSummer = new Set(offeringsFromListing(summer.sections).map((o) => o.courseName));
/** Seen in fall implies both regular terms; spring is unpublished, so absence means spring. */
const regularSeason: Season = regularTerm.includes("SP") ? "spring" : "fall";
const seasons = new Map(records.map((c) => [`${c.SubjectCode}-${c.Number}`, seasonsOffered(c)]));
const cycles = new Map(records.map((c) => [`${c.SubjectCode}-${c.Number}`, yearsOffered(c)]));
/** The registrar's own statement, rather than what one term's listing implies. */
const offeredIn = (code: string, slot: TermSlot) => {
  const stated = seasons.get(baseCode(code));
  if (stated?.length && !stated.includes(slot.season)) return false;
  return runsIn(cycles.get(baseCode(code)) ?? "all", slot.year, slot.season);
};

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

// The transcript belongs to the student, not to one evaluation: a course
// bought for the second major is absent from the first major's tree.
const done = completedCourses(trees);
const inProgress = inProgressCourses(trees);
const have = new Set([...done, ...inProgress]);

const label = (code: string) => {
  const base = baseCode(code);
  const nth = Number(code.split("#")[1] ?? 1);
  return `${base}${titles.has(base) ? ` — ${titles.get(base)}` : ""}${nth > 1 ? ` (sitting ${nth})` : ""}`;
};

/** A course code as `accepts` wants it: subject, number and title. */
const asCourse = (code: string) => {
  const [subject = "", number = ""] = code.split("-");
  return {
    Id: code,
    SubjectCode: subject,
    Number: number,
    Title: titles.get(baseCode(code)) ?? code,
    CourseName: code,
    EquatedCourseIds: null,
    IsPseudoCourse: false,
  };
};

/** The group an unenumerable entry came from, found by the ids it carries. */
const groupAt = (tree: ReturnType<typeof normalize>, ids: { requirement: string; group: string }) =>
  [...walkGroups(tree)].find(
    ({ requirement, group }) => requirement.code === ids.requirement && group.id === ids.group,
  )?.group;
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
// Two majors on one bachelor's share a single credit total, so the largest
// requirement is the requirement, never the sum.
const needs = Math.max(...trees.map((t) => t.credits.minimum));
w(
  `- ${trees.map((t) => t.code).join(" + ")} needs **${needs}**, so **${needs - cy.credits.completed - cy.credits.inProgress}** remain after this term`,
);
w(`- ${done.size} courses passed, ${inProgress.size} running now`);
w();

for (const tree of trees) {
  const cap = 15;
  const name = `${tree.code} — ${tree.title}`;
  // First pass: find the groups the evaluation will not enumerate.
  const naming = {
    // A pool can only be judged short at what its courses can be taken for,
    // and a requirement asking for two of something says so in its name.
    ceiling: (c: string) => maxima.get(baseCode(c)) || price(c),
    titleOf: (c: string) => titles.get(baseCode(c)) ?? "",
  };
  const first = coursesNeeded(tree, { credits: price, have, ...naming });

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
  const {
    courses: need,
    unenumerable,
    shortfalls,
  } = coursesNeeded(tree, {
    credits: price,
    have,
    resolved,
    ...naming,
  });
  for (const u of first.unenumerable) {
    const pool = resolved.get(groupKey(u.ids));
    if (pool) u.resolved = pool;
  }
  // A requirement its pool cannot close is met by sitting a course twice, and
  // the second sitting waits on whatever the first one did.
  for (const code of need) addSitting(graph, code);
  const plan = projectPlan({
    need,
    completed: have,
    graph,
    credits: price,
    offeredIn,
    sequences,
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
    w(`This schedules ${plan.totalCredits} credits against a ${toGo}-credit gap. A degree minimum`);
    w("is a floor rather than a budget, and the reconciliation below accounts for the gap");
    w("in full, so treat the date as an upper bound but not a wild one.");
    w();
  }

  // The catalog is the only place the overlap is stated, so it is the only
  // thing that can tell an honest over-schedule from a bookkeeping artefact.
  if (printed) {
    const ceiling = creditCeiling(printed);
    const projected = tree.credits.completed + tree.credits.inProgress + plan.totalCredits;
    const overlap = impliedOverlap(printed) + absorbed(printed, price);
    // Credits already earned above the size of the slot they fill. The
    // catalog sums slot sizes; a transcript sums courses, and the two differ.
    const over = creditOverflow(tree);
    const allowance = overlap + over;

    w(
      `Checked against the ${book.year} catalog, page ${printed.page} (“${printed.title}”, ${totalCredits(printed)} credits).`,
    );
    w();
    if (over) {
      w(`You have earned **${over} credits more than the requirements they fill asked for**, so`);
      w("the degree total is not a ceiling you can be held to exactly:");
      w();
      for (const { group, subrequirement } of walkGroups(tree)) {
        const min = group.min.credits ?? 0;
        const applied = group.applied.filter((c) => !c.IsWithdrawn);
        const got = applied.reduce((n, c) => n + (c.Credit ?? 0), 0);
        if (!min || got <= min) continue;
        w(
          `- ${applied.map((c) => `${c.CourseName} (${c.Credit})`).join(", ")} fills the ${min}-credit ${subrequirement.code} slot, ${(got - min).toFixed(1)} over`,
        );
      }
      w();
    }
    if (overlap) {
      w(`The catalog counts **${overlap} credits twice**, so a plan may legitimately exceed the`);
      w("degree total by that much:");
      w();
      for (const d of printed.doubleCounts)
        w(`- ${label(d.course)} also pays for the ${d.requirement} general education requirement`);
      w();
    } else {
      w("The catalog's own arithmetic closes exactly: it footnotes no course as counting toward");
      w("two requirements.");
      w();
    }

    // The catalog under-reports this badly; the evaluation does not.
    const shared = sharedCredits(tree);
    if (shared.length) {
      w("Your evaluation, though, already applies these to two requirements each:");
      w();
      for (const s of shared)
        w(`- ${label(s.course)} (${s.credits}) counts toward ${s.requirements.join(" and ")}`);
      w();
      w("Colleague states this only for coursework already done, so it explains the credits");
      w("behind you rather than predicting which of the courses ahead will do the same.");
      w();
    }
    if (ceiling !== undefined && projected > ceiling + allowance) {
      w(
        `⚠️ This plan reaches **${projected} credits** against a stated ceiling of ${ceiling + allowance}.`,
      );
      w(
        `That ${(projected - ceiling - allowance).toFixed(1)}-credit excess is a bug in this model,`,
      );
      w("not a feature of the degree. Treat the finish date as pessimistic.");
      w();
    } else if (ceiling !== undefined) {
      w(
        `This plan reaches ${projected} credits, inside the ${ceiling + allowance} the catalog allows for.`,
      );
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
    for (const u of buckets) {
      w(`- ${u.credits ? `**${u.credits}cr** ` : ""}${u.text || u.requirement}`);
      // Not an assertion if we can count it. These groups name a level rather
      // than a course list, which is exactly what `accepts` can decide.
      const group = groupAt(tree, u.ids);
      if (!group) continue;
      const cover = groupCoverage(group, [...have, ...need].map(asCourse), price);
      const enough = u.credits === undefined || cover.credits >= u.credits;
      w(
        `  <br>_${enough ? "covered" : "**short**"}: ${cover.credits} credits of this plan qualify${cover.unsure ? `, plus ${cover.unsure} that may` : ""} — ${cover.courses.slice(0, 10).join(", ")}${cover.courses.length > 10 ? " …" : ""}_`,
      );
    }
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
  // A pool that cannot close its own requirement is a hole in the date above:
  // "Honors Integrative Seminars (4 credit hours)" draws on a pool whose
  // seminar is worth two, so it means that seminar twice, and a set of course
  // codes has no way to say so.
  if (shortfalls.length) {
    w("Requirements their own pool cannot close — nearly always a course taken twice:");
    w();
    for (const s of shortfalls) {
      w(
        `- ${s.text}\n  <br>_${s.pool.join(", ")} add up to ${s.wanted - s.short} of the ${s.wanted} ` +
          "credits asked for; the rest is the same course again — check with your advisor_",
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

const owed = coursesNeededAcross(trees, { credits: price, have }).courses;
const path = criticalPath(graph, owed, have);
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
for (const code of [...owed].sort()) {
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
