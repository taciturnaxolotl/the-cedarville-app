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

import { criticalPath } from "../../planner";
import { groupKey, type ProgramTree } from "../../requirements";
import type { Ctx } from "../ctx";
import { el, tag } from "../dom";
import { CEILING, FULL_TIME, type Load, readLoad, SUMMERS, verdictOf, writeLoad } from "../load";
import { planningFrom } from "../planning";
import { createStore, Subscriptions } from "../store";

interface State {
  /** The same knobs the build view sets, so the two never disagree. */
  load: Load;
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

  // One projection, assembled where every view can share it. This tab used to
  // build its own and quietly disagreed with the other two about the date.
  const planning = planningFrom(ctx);
  const { graph, have, price, title } = planning;

  // First pass names the groups the evaluation will not enumerate; the server
  // asks Colleague what qualifies; the second pass runs one cover over
  // everything, so a course bought for one requirement can pay for a
  // rule-based one too.
  const first = planning.solve();
  let need = first.courses;
  let unenumerable = first.unenumerable;

  void planning.expandRules(first.unenumerable).then((resolved) => {
    if (resolved.size === 0) return;
    for (const u of first.unenumerable) {
      const pool = resolved.get(groupKey(u.ids));
      if (pool?.length) u.resolved = pool;
    }
    const second = planning.solve({ resolved });
    need = second.courses;
    unenumerable = second.unenumerable;
    store.set({ resolvedAt: Date.now() });
  });

  const store = createStore<State>({ load: readLoad(), resolvedAt: 0 });

  // ---- chrome ----------------------------------------------------------

  const set = (patch: Partial<Load>) => {
    const load = { ...store.get().load, ...patch };
    writeLoad(load);
    store.set({ load });
  };

  /** A slider that reports as it moves, and remembers where it was left. */
  function slider(
    label: string,
    value: number,
    range: { min: number; max: number; step: number },
    onChange: (n: number) => void,
  ) {
    const input = el("input");
    input.type = "range";
    input.min = String(range.min);
    input.max = String(range.max);
    input.step = String(range.step);
    input.value = String(value);
    input.addEventListener("input", () => onChange(Number(input.value)));
    return [el("label", undefined, label), input] as const;
  }

  const controls = el("div", "plan-controls");
  const perTermLabel = el("span", "cr");
  const summersLabel = el("span", "cr");

  const full = el("input");
  full.type = "checkbox";
  full.checked = store.get().load.fullSemesters;
  full.title =
    "Keeps every semester at twelve credits or more, holding work back from a summer and " +
    "moving courses between terms to do it. Better an even thirteen twice than sixteen " +
    "and then nine.";
  full.addEventListener("change", () => set({ fullSemesters: full.checked }));
  const fullLabel = el("label", "toggle");
  fullLabel.append(full, el("span", undefined, "keep semesters full"));

  controls.append(
    ...slider(
      "credits per term",
      store.get().load.perTerm,
      { min: FULL_TIME, max: CEILING, step: 0.5 },
      (perTerm) => set({ perTerm }),
    ),
    perTermLabel,
    ...slider("summers", store.get().load.summers, { min: 0, max: SUMMERS, step: 1 }, (summers) =>
      set({ summers }),
    ),
    summersLabel,
    fullLabel,
  );

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
      node.title = title(code);
      row.append(node);
    });
    chain.append(row);
    chain.append(el("p", "muted", "no credit load shortens this."));
  }

  subs.add(
    store.watch(
      (s) => `${JSON.stringify(s.load)}:${s.resolvedAt}`,
      () => {
        const { load } = store.get();
        perTermLabel.textContent = `${load.perTerm}`;
        perTermLabel.title = verdictOf(load.perTerm).text;
        summersLabel.textContent = load.summers === 0 ? "none" : `${load.summers}`;

        const plan = planning.project(need, load);

        // Two majors on one bachelor's share a single credit total, so the
        // requirement is the largest of them and never their sum. Earned
        // credit reads the same way: an evaluation counts only what its own
        // requirements consumed.
        const largest = (pick: (t: ProgramTree) => number) => Math.max(...trees.map(pick));
        const toGo =
          largest((t) => t.credits.minimum) -
          largest((t) => t.credits.completed) -
          largest((t) => t.credits.inProgress);
        verdict.textContent =
          `${trees.map((t) => t.code).join(" + ")}: ${toGo} credits left · ` +
          `finishes ${plan.finishes ?? "beyond the horizon"} · ${plan.terms.length} terms`;

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
            row.append(el("span", undefined, title(c.code)));
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

        if (first.unenumerable.length) {
          const box = el("div", "term unenumerable");
          const pending = first.unenumerable.filter((u) => !u.bucket && !u.resolved?.length);
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
