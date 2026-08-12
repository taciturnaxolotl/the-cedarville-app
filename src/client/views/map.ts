/*
 * The plan as a graph: terms across, prerequisites drawn between them.
 *
 * This is the view for a plan you have already made. The build view answers
 * "what should I choose"; this one answers "what is holding up what", which is
 * the question you ask once the choosing is done and you are looking at a
 * five-term chain wondering which end of it to attack.
 *
 * It reads the same pins and tracks the build view writes, so the picture is
 * of the degree you have actually assembled rather than the cheapest one.
 */

import { runsIn, seasonsOffered, yearsOffered } from "../../catalog";
import { buildMap, type CourseMap } from "../../map";
import { projectPlan, type Season, type TermSlot, termsFrom } from "../../planner";
import { buildGraph, type CourseNode, parseRequisite, prerequisitesOf } from "../../prereqs";
import {
  completedCourses,
  coursesNeededAcross,
  coursesTaken,
  expectedCredits,
  inProgressCourses,
  type ProgramTree,
} from "../../requirements";
import { offeringsFromListing } from "../../schedule";
import { catalogStatus, fetchCatalog, resolveRules } from "../bridge";
import type { Ctx } from "../ctx";
import { el } from "../dom";
import { FULL_TIME, readLoad } from "../load";
import { createStore, Subscriptions } from "../store";

const PINS = "cedarville:pins";
const TRACKS = "cedarville:tracks";
const SVG = "http://www.w3.org/2000/svg";

interface State {
  resolved: Map<string, string[]>;
  seasonsAt: number;
  /** The course under the pointer, whose chain is lit up. */
  focus: string | null;
}

const svg = <K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number>,
) => {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
};

const read = <T>(key: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "") as T;
  } catch {
    return fallback;
  }
};

export function mount(root: HTMLElement, ctx: Ctx) {
  const subs = new Subscriptions();
  const { trees, sections: catalog } = ctx;
  const store = createStore<State>({ resolved: new Map(), seasonsAt: 0, focus: null });

  if (trees.length === 0) {
    root.replaceChildren(el("p", "muted", "capture your requirements to see the plan as a graph."));
    return { destroy: () => root.replaceChildren() };
  }

  // ---- the same inputs the build view solves with ----------------------

  const records = ctx.allCourses?.length ? ctx.allCourses : (catalog?.courses ?? []);
  const credits = new Map(
    records.map((c) => [`${c.SubjectCode}-${c.Number}`, c.MinimumCredits ?? 0]),
  );
  const maxima = new Map<string, number>(
    records.flatMap((c) =>
      c.MaximumCredits
        ? [[`${c.SubjectCode}-${c.Number}`, c.MaximumCredits] as [string, number]]
        : [],
    ),
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

  // Which seasons a course runs in, as the registrar states it rather than as
  // one term's section listing implies. See the note in the build view.
  const seasons = new Map<string, ReturnType<typeof seasonsOffered>>(
    records.map((c) => [`${c.SubjectCode}-${c.Number}`, seasonsOffered(c)]),
  );
  const cycles = new Map<string, ReturnType<typeof yearsOffered>>(
    records.map((c) => [`${c.SubjectCode}-${c.Number}`, yearsOffered(c)]),
  );
  const offeredIn = (code: string, slot: TermSlot) => {
    const stated = seasons.get(code);
    if (stated?.length && !stated.includes(slot.season)) return false;
    // 268 courses run in alternate academic years, and a plan that ignores
    // that puts a student in a classroom that is not running.
    return runsIn(cycles.get(code) ?? "all", slot.year, slot.season);
  };

  const stretched = expectedCredits(trees, (c) => ({
    min: credits.get(c) ?? 3,
    max: maxima.get(c) ?? credits.get(c) ?? 3,
  }));
  const price = (c: string) => stretched.get(c) ?? credits.get(c) ?? 3;
  const have = new Set([
    ...completedCourses(trees[0] as ProgramTree),
    ...inProgressCourses(trees[0] as ProgramTree),
  ]);

  const pinned = new Set(read<string[]>(PINS, []));
  const tracks = new Map(
    Object.entries(read<Record<string, string>>(TRACKS, {})).map(([k, v]) => [k, [v]]),
  );
  const pursuing = new Set(trees.flatMap((t) => [...t.majors, ...t.minors]));

  const solve = (resolved: Map<string, string[]>) =>
    coursesNeededAcross(trees, { credits: price, have, resolved, pinned, tracks, pursuing });

  const first = solve(new Map());
  void resolveRules(first.unenumerable.filter((u) => !u.bucket).map((u) => u.ids))
    .then((answers) => {
      const resolved = new Map<string, string[]>();
      for (const key of Object.keys(answers)) {
        const pool = answers[key]?.filter((c) => !have.has(c));
        if (pool?.length) resolved.set(key, pool);
      }
      if (resolved.size) store.set({ resolved });
    })
    .catch(() => {
      /* Leave the rule groups out rather than guessing at them. */
    });

  // ---- layout ----------------------------------------------------------

  // The same load the build view is set to, so the two never disagree about
  // when the degree finishes.
  const load = readLoad();
  const slots = termsFrom({ year: 2027, season: "spring" }, 12, {
    capacity: load.perTerm,
    summerCapacity: load.summer,
    includeSummers: load.summer > 0,
    minimum: FULL_TIME,
  });
  const legend = el("p", "credits");
  const board = el("div", "board");
  root.replaceChildren(legend, board);

  /** Everything the focused course waits on, and everything waiting on it. */
  function related(map: CourseMap, code: string): Set<string> {
    const lit = new Set([code]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const e of map.edges) {
        if (lit.has(e.from) && !lit.has(e.to)) lit.add(e.to), (grew = true);
        if (lit.has(e.to) && !lit.has(e.from)) lit.add(e.from), (grew = true);
      }
    }
    return lit;
  }

  function draw() {
    const solved = solve(store.get().resolved);
    const need = new Set(solved.courses);
    for (const code of [...need]) {
      for (const p of prerequisitesOf(graph, code, have, need)) need.add(p);
    }

    const plan = projectPlan({ need, completed: have, graph, credits: price, offeredIn, slots });
    const map = buildMap(plan, {
      graph,
      have,
      history: coursesTaken(trees[0] as ProgramTree),
      title: (c) => titles.get(c) ?? "",
    });
    const { focus } = store.get();
    const lit = focus ? related(map, focus) : null;

    legend.replaceChildren();
    legend.append(
      document.createTextNode(
        `${map.nodes.length} courses across ${map.terms.length} terms · finishes ${plan.finishes ?? "beyond the horizon"} · ` +
          `${map.edges.length} prerequisite links · ${map.nodes.filter((n) => n.past).length} already taken`,
      ),
    );
    if (focus) legend.append(el("span", "shared", ` · tracing ${focus}`));

    board.replaceChildren();
    const canvas = svg("svg", { width: map.width, height: map.height, class: "graph" });

    for (const term of map.terms) {
      canvas.append(
        Object.assign(
          svg("text", { x: term.x, y: 14, class: `term-label${term.past ? " past" : ""}` }),
          { textContent: `${term.name} · ${term.credits}cr` },
        ),
      );
    }

    // Edges under the nodes, so a line never crosses a course code.
    for (const edge of map.edges) {
      const dim = lit && !(lit.has(edge.from) && lit.has(edge.to));
      canvas.append(
        svg("path", {
          d: edge.path,
          class: `edge${edge.critical ? " critical" : ""}${dim ? " dim" : ""}`,
          fill: "none",
        }),
      );
    }

    for (const node of map.nodes) {
      const dim = lit && !lit.has(node.code);
      const g = svg("g", {
        class: `node${node.past ? ` ${node.past}` : ""}${node.critical ? " critical" : ""}${dim ? " dim" : ""}`,
        transform: `translate(${node.x}, ${node.y})`,
      });
      g.append(svg("rect", { width: 168, height: 32, rx: 3 }));
      g.append(
        Object.assign(svg("text", { x: 8, y: 13, class: "code" }), { textContent: node.code }),
      );
      g.append(
        Object.assign(svg("text", { x: 8, y: 25, class: "sub" }), {
          textContent: `${node.credits}cr${node.past === "running" ? " · now" : ""}${node.unlocks ? ` · gates ${node.unlocks}` : ""}`,
        }),
      );
      const hint = [
        node.title,
        node.unlocks ? `${node.unlocks} later courses wait on this` : "",
        node.caution ?? "",
      ]
        .filter(Boolean)
        .join(" — ");
      if (hint) {
        g.append(Object.assign(svg("title", {}), { textContent: hint }));
      }
      g.addEventListener("mouseenter", () => store.set({ focus: node.code }));
      g.addEventListener("mouseleave", () => store.set({ focus: null }));
      canvas.append(g);
    }

    board.append(canvas);

    if (plan.unscheduled.length) {
      const box = el("div", "choice");
      box.append(el("h3", undefined, "not placed"));
      for (const u of plan.unscheduled) {
        box.append(el("div", "candidate muted", `${u.code} — ${u.why}`));
      }
      board.append(box);
    }
  }

  subs.add(
    store.watch(
      (s) => `${s.resolved.size}:${s.seasonsAt}:${s.focus ?? ""}`,
      () => draw(),
    ),
  );

  return {
    destroy() {
      subs.clear();
      root.replaceChildren();
    },
  };
}
