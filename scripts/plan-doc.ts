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
import {
  completedCourses,
  inProgressCourses,
  normalize,
  type ProgramTree,
  walkGroups,
} from "../src/requirements";
import { offeringsFromListing } from "../src/schedule";
import { CatalogStore } from "../src/server/store";

const store = new CatalogStore();
const fall = store.read("2026FA");
const summer = store.read("2026SU");

const records = [...(fall.courses ?? []), ...(summer.courses ?? [])];
const credits = new Map(
  records.map((c) => [`${c.SubjectCode}-${c.Number}`, c.MinimumCredits ?? 0]),
);
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
const offeredIn = (code: string, season: Season) =>
  season === "summer" ? inSummer.has(code) : season === "fall" ? inFall.has(code) : true;

const snapshot = await Bun.file(".data/evaluations.json").json();
const cy = normalize(snapshot.evaluations["BS.CYOPR"]);
const csFile = Bun.file(".data/whatif-BS.CMPSC.json");
const cs = (await csFile.exists()) ? normalize(await csFile.json()) : null;

const done = completedCourses(cy);
const inProgress = inProgressCourses(cy);
const have = new Set([...done, ...inProgress]);

/** Named requirements, plus enough of each choose-from pool to meet its minimum. */
function requiredCourses(tree: ProgramTree): Set<string> {
  const need = new Set<string>();
  for (const { requirement, group } of walkGroups(tree)) {
    const label = group.text || requirement.text;
    if (/Graphic Design|Linguistics|Video Game|Artificial Intelligence Track/i.test(label))
      continue;
    const c = group.constraint;
    if (c.kind === "take-all") {
      for (const x of c.courses) need.add(x.CourseName);
    } else if (c.kind === "choose-from" && group.status.completion !== "Completed") {
      let want = group.min.credits ?? 3;
      const pool = c.courses
        .filter((x) => !have.has(x.CourseName))
        .sort((a, b) => (credits.get(a.CourseName) ?? 3) - (credits.get(b.CourseName) ?? 3));
      for (const x of pool) {
        if (want <= 0) break;
        need.add(x.CourseName);
        want -= credits.get(x.CourseName) ?? 3;
      }
    }
  }
  return need;
}

const label = (code: string) => `${code}${titles.has(code) ? ` — ${titles.get(code)}` : ""}`;
const out: string[] = [];
const w = (line = "") => out.push(line);

w("# Degree plan");
w();
w(`Generated ${new Date().toISOString().slice(0, 10)} from the captured evaluations and the`);
w("cached Fall 2026 / Summer 2026 catalog. Regenerate with `bun scripts/plan-doc.ts`.");
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

for (const [name, tree, cap] of [
  ["Cyber Operations only", cy, 15],
  ...(cs ? ([["Cyber Operations + CS major", cs, 15]] as const) : []),
] as const) {
  const need = new Set([...requiredCourses(cy), ...(tree === cy ? [] : requiredCourses(tree))]);
  const plan = projectPlan({
    need,
    completed: have,
    graph,
    credits: (c) => credits.get(c) ?? 3,
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
  if (plan.unscheduled.length) {
    w("Not placed:");
    w();
    for (const u of plan.unscheduled) w(`- ${label(u.code)} — ${u.why}`);
    w();
  }
}

const path = criticalPath(graph, requiredCourses(cy), have);
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
for (const code of [...requiredCourses(cy)].filter((c) => !have.has(c)).sort()) {
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
