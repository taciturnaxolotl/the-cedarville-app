#!/usr/bin/env bun

/*
 * Writes .data/plan.md — a term-by-term projection built from your captured
 * evaluations and the cached catalog, so it can be regenerated whenever
 * either changes rather than going stale in a text file.
 *
 * Local only: it reads a transcript.
 */

import { criticalPath, projectPlan, type Season, termsFrom } from "../src/planner";
import { buildGraph, type CourseNode, eligibility, parseRequisite } from "../src/prereqs";
import { completedCourses, coursesNeeded, inProgressCourses, normalize } from "../src/requirements";
import { offeringsFromListing } from "../src/schedule";
import { CatalogStore } from "../src/server/store";

const store = new CatalogStore();

// Newest cached terms rather than named ones, so the projection does not keep
// reasoning from last autumn's catalog after a newer one lands.
const cached = store
  .stats()
  .map((s) => s.term)
  .sort()
  .reverse();
const regularTerm = cached.find((t) => !t.includes("SU"));
const summerTerm = cached.find((t) => t.includes("SU"));
if (!regularTerm) throw new Error("no catalog cached; run the planner server once to crawl");

const fall = store.read(regularTerm);
const summer = summerTerm ? store.read(summerTerm) : { sections: [], courses: [] };

const records = [...(fall.courses ?? []), ...(summer.courses ?? [])];
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
  const { courses: need, unenumerable } = coursesNeeded(tree, { credits: price, have });
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
  if (unenumerable.length) {
    w("Not plannable — Colleague evaluates these but never publishes the courses:");
    w();
    for (const u of unenumerable) w(`- ${u.credits ? `**${u.credits}cr** ` : ""}${u.text}`);
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
w("- **Language sequences.** Choose-from pools are filled by cheapest-first, which can");
w("  pick `BTBL-3510` without the `BTBL-2510` that precedes it. Pick a language and");
w("  follow it rather than trusting the greedy choice.");
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
