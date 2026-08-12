/*
 * The term-by-term projection.
 *
 * The other two views answer "what do I still owe" and "when does this meet".
 * This one answers "when do I finish", which is the question that actually
 * decides things — and the honest answer depends on two knobs the student
 * controls, so both are on screen: credits per term, and whether summers
 * count. Changing either reprojects immediately.
 *
 * The critical path is shown above the plan rather than below it, because a
 * chain of prerequisites is the one constraint no amount of credit load will
 * shorten, and it is the first thing worth knowing.
 */

import { criticalPath, projectPlan, type Season, termsFrom } from "../../planner";
import { buildGraph, type CourseNode, parseRequisite } from "../../prereqs";
import {
  completedCourses,
  coursesNeeded,
  inProgressCourses,
  type ProgramTree,
} from "../../requirements";
import { offeringsFromListing } from "../../schedule";
import { resolveRules } from "../bridge";
import type { Ctx } from "../ctx";
import { el, tag } from "../dom";
import { createStore, Subscriptions } from "../store";

interface State {
  perTerm: number;
  summers: boolean;
  /** Bumped when rule groups come back, to reproject with their courses. */
  resolvedAt: number;
}

export function mount(root: HTMLElement, ctx: Ctx) {
  const { trees, sections: catalog } = ctx;
  const subs = new Subscriptions();

  if (!catalog || trees.length === 0) {
    root.replaceChildren(
      el("p", "muted", "capture your requirements and load a term to project a plan."),
    );
    return { destroy: () => root.replaceChildren() };
  }

  const records = catalog.courses ?? [];
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

  // We hold one term's catalog, so seasons are a guess: a course seen in this
  // term is assumed to recur, and anything else is assumed to be elsewhere.
  const seen = new Set(offeringsFromListing(catalog.sections).map((o) => o.courseName));
  const thisSeason: Season = catalog.term.includes("SU")
    ? "summer"
    : catalog.term.includes("SP")
      ? "spring"
      : "fall";
  const offeredIn = (code: string, season: Season) =>
    season === thisSeason ? seen.has(code) : true;

  const tree = trees[0] as ProgramTree;
  const have = new Set([...completedCourses(tree), ...inProgressCourses(tree)]);
  const price = (c: string) => credits.get(c) ?? 3;

  const { courses: need, unenumerable } = coursesNeeded(tree, { credits: price, have });

  // Ask the server to expand the groups the evaluation would not enumerate.
  // Until it answers they stay listed as unplannable, which is honest; once it
  // does, their courses join the projection like any other requirement.
  void resolveRules(unenumerable.filter((u) => !u.bucket).map((u) => u.ids)).then((resolved) => {
    let added = 0;
    for (const u of unenumerable) {
      if (u.bucket) continue; // a catch-all, satisfied by other coursework
      const key = `${u.ids.requirement}/${u.ids.subrequirement}/${u.ids.group}`;
      const options = resolved[key];
      if (!options?.length) continue;

      // Cheapest first, up to the credits the group asks for.
      let want = u.credits ?? 3;
      for (const code of options.filter((c) => !have.has(c)).sort((a, b) => price(a) - price(b))) {
        if (want <= 0) break;
        need.add(code);
        want -= price(code);
        added++;
      }
      u.resolved = options;
    }
    if (added) store.set({ resolvedAt: Date.now() });
  });

  const store = createStore<State>({ perTerm: 15, summers: true, resolvedAt: 0 });

  // ---- chrome ----------------------------------------------------------

  const controls = el("div", "plan-controls");
  const perTerm = el("input");
  perTerm.type = "range";
  perTerm.min = "9";
  perTerm.max = "21";
  perTerm.value = "15";
  const perTermLabel = el("span", "cr");
  perTerm.addEventListener("input", () => store.set({ perTerm: Number(perTerm.value) }));

  const summers = el("input");
  summers.type = "checkbox";
  summers.checked = true;
  summers.addEventListener("change", () => store.set({ summers: summers.checked }));
  const summerLabel = el("label", "toggle");
  summerLabel.append(summers, el("span", undefined, "use summers"));

  controls.append(el("label", undefined, "credits per term"), perTerm, perTermLabel, summerLabel);

  const verdict = el("p", "credits");
  const chain = el("div", "chain");
  const body = el("div");
  root.replaceChildren(controls, verdict, chain, body);

  // The critical path depends on the transcript, not the knobs, so it is
  // computed once rather than on every slider tick.
  const path = criticalPath(graph, need, have);
  if (path.length) {
    chain.append(el("h3", undefined, `critical path — ${path.length} terms minimum`));
    const row = el("div", "chain-row");
    path.forEach((code: string, i: number) => {
      if (i) row.append(el("span", "arrow", "→"));
      const node = el("span", "chain-node", code);
      node.title = titles.get(code) ?? "";
      row.append(node);
    });
    chain.append(row);
    chain.append(el("p", "muted", "no credit load shortens this."));
  }

  subs.add(
    store.watch(
      (s) => `${s.perTerm}:${s.summers}:${s.resolvedAt}`,
      () => {
        const { perTerm: cap, summers: useSummers } = store.get();
        perTermLabel.textContent = `${cap}`;

        const plan = projectPlan({
          need,
          completed: have,
          graph,
          credits: price,
          offeredIn,
          slots: termsFrom({ year: 2027, season: "spring" }, 12, {
            capacity: cap,
            includeSummers: useSummers,
          }),
        });

        const toGo = tree.credits.minimum - tree.credits.completed - tree.credits.inProgress;
        verdict.textContent =
          `${tree.code}: ${toGo} credits left · finishes ${plan.finishes ?? "beyond the horizon"}` +
          ` · ${plan.terms.length} terms`;

        body.replaceChildren();
        if (plan.totalCredits > toGo) {
          body.append(
            el(
              "p",
              "muted",
              `Schedules ${plan.totalCredits} credits against a ${toGo}-credit gap, so the date is an ` +
                `upper bound: requirement pools overlap and one course often fills two slots.`,
            ),
          );
        }

        for (const term of plan.terms) {
          const box = el("div", `term ${term.slot.season}`);
          const head = el("h3");
          head.append(document.createTextNode(term.slot.name));
          head.append(el("span", "cr", `${term.credits} cr`));
          box.append(head);
          for (const c of term.courses) {
            const row = el("div", "plan-course");
            row.append(el("b", undefined, c.code));
            row.append(el("span", undefined, titles.get(c.code) ?? ""));
            if (c.caution) {
              const flag = tag("verify", "rule");
              flag.title = c.caution;
              row.append(flag);
            }
            box.append(row);
          }
          body.append(box);
        }

        if (plan.unscheduled.length) {
          const box = el("div", "term unplaced");
          box.append(el("h3", undefined, "not placed"));
          for (const u of plan.unscheduled) {
            box.append(el("div", "plan-course muted", `${u.code} — ${u.why}`));
          }
          body.append(box);
        }

        if (unenumerable.length) {
          const box = el("div", "term unenumerable");
          const pending = unenumerable.filter((u) => !u.bucket && !u.resolved?.length);
          if (pending.length) {
            box.append(el("h3", undefined, "not plannable"));
            box.append(
              el("p", "muted", "Colleague did not expand these; ask your advisor what qualifies."),
            );
            for (const u of pending) {
              box.append(
                el("div", "plan-course muted", `${u.credits ? `${u.credits}cr  ` : ""}${u.text}`),
              );
            }
            body.append(box);
          }
        }

        body.append(
          el(
            "p",
            "muted",
            "Class standing is not modelled, so senior capstones may land early. " +
              "Seasons are inferred from the one term of catalog we hold.",
          ),
        );
      },
    ),
  );

  return {
    destroy() {
      subs.clear();
      root.replaceChildren();
    },
  };
}
