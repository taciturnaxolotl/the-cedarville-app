/*
 * The projection drawn as the graph it actually is.
 *
 * One of two renderings the plan tab offers, and the one that answers "what is
 * holding up what" — the question you ask once the choosing is done and you
 * are looking at a five-term chain wondering which end of it to attack. The
 * list rendering answers "what am I taking in spring".
 *
 * The plan is handed in already solved. This file decides nothing about the
 * degree; it only draws one.
 */

import { buildMap, type CourseMap, type Flow } from "../../map";
import type { Plan } from "../../planner";
import { coursesTaken } from "../../requirements";
import { el } from "../dom";
import { type Planning, read } from "../planning";
import { createStore, Subscriptions } from "../store";

const FLOW = "cedarville:map-flow";
const SVG = "http://www.w3.org/2000/svg";

interface State {
  /** The course under the pointer, whose chain is lit up. */
  focus: string | null;
  /** Which way time runs. Remembered, because it is a matter of taste. */
  flow: Flow;
}

const svg = <K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number>,
) => {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
};

/** SVG has no ellipsis, and a course name is longer than any box. */
const fit = (text: string, chars: number) =>
  text.length <= chars ? text : `${text.slice(0, Math.max(0, chars - 1)).trimEnd()}…`;

export function mountGraph(root: HTMLElement, plan: Plan, planning: Planning) {
  const subs = new Subscriptions();
  const { graph, have, title, trees } = planning;
  const store = createStore<State>({
    focus: null,
    // Down by default: a degree is long and a term is not, so the picture is
    // tall and thin, and a browser scrolls that way without being asked.
    flow: read<Flow>(FLOW, "down"),
  });

  // ---- layout ----------------------------------------------------------

  const legend = el("p", "credits");
  // Kept across highlights: only its text changes, so tracing a chain never
  // touches the picture itself.
  const trace = el("span", "shared");
  const board = el("div", "board");

  const turn = el("button", "export");
  turn.type = "button";
  turn.title = "Turn the picture: a term to a row, or a term to a column.";
  turn.addEventListener("click", () => {
    const flow: Flow = store.get().flow === "down" ? "across" : "down";
    localStorage.setItem(FLOW, JSON.stringify(flow));
    store.set({ flow });
  });

  root.replaceChildren(legend, turn, board);

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

  /**
   * What the last draw produced.
   *
   * Tracing a chain used to rebuild the whole picture, which pulled the box
   * out from under the pointer: the element that would have fired mouseleave
   * no longer existed, so the highlight stuck until another course was
   * hovered. Structure is drawn once; the highlight only toggles a class.
   */
  let drawn: {
    map: CourseMap;
    nodes: Map<string, SVGGElement>;
    edges: { from: string; to: string; el: SVGPathElement }[];
  } | null = null;

  function highlight() {
    if (!drawn) return;
    const { focus } = store.get();
    const lit = focus ? related(drawn.map, focus) : null;
    for (const [code, box] of drawn.nodes) {
      box.classList.toggle("dim", Boolean(lit && !lit.has(code)));
    }
    for (const edge of drawn.edges) {
      edge.el.classList.toggle("dim", Boolean(lit && !(lit.has(edge.from) && lit.has(edge.to))));
    }
    trace.textContent = focus ? ` · tracing ${focus}` : "";
  }

  function draw() {
    const map = buildMap(plan, {
      graph,
      have,
      history: coursesTaken(trees),
      title,
      flow: store.get().flow,
    });
    legend.replaceChildren();
    legend.append(
      document.createTextNode(
        // The finish date belongs to the tab, which says it above this. Here
        // it would be the second copy of the same three words.
        `${map.nodes.length} courses across ${map.terms.length} terms · ` +
          `${map.edges.length} prerequisite links · ${map.nodes.filter((n) => n.past).length} already taken · ` +
          `longest chain ${map.nodes.filter((n) => n.critical).length} courses`,
      ),
    );
    legend.append(trace);
    turn.textContent = store.get().flow === "down" ? "lay it across" : "lay it down";

    board.replaceChildren();
    const canvas = svg("svg", { width: map.width, height: map.height, class: "graph" });

    const shortTerms = new Set(plan.terms.filter((t) => t.short).map((t) => t.slot.name));
    for (const term of map.terms) {
      canvas.append(
        Object.assign(
          svg("text", {
            x: term.x,
            y: term.y,
            class: `term-label${term.past ? " past" : ""}${shortTerms.has(term.name) ? " short" : ""}`,
          }),
          {
            textContent: `${term.name} · ${term.credits}cr${shortTerms.has(term.name) ? " · part time" : ""}`,
          },
        ),
      );
    }

    // Edges under the nodes, so a line never crosses a course code.
    const edges: { from: string; to: string; el: SVGPathElement }[] = [];
    for (const edge of map.edges) {
      const el = svg("path", {
        d: edge.path,
        class: "edge",
        fill: "none",
      });
      edges.push({ from: edge.from, to: edge.to, el });
      canvas.append(el);
    }

    const boxes = new Map<string, SVGGElement>();
    for (const node of map.nodes) {
      const g = svg("g", {
        class: `node${node.past ? ` ${node.past}` : ""}`,
        transform: `translate(${node.x}, ${node.y})`,
      });
      boxes.set(node.code, g);
      g.append(svg("rect", { width: map.node.width, height: map.node.height, rx: 3 }));

      // Two lines, and every one of the four things on them is laid out
      // against a measured budget. The page is monospace throughout, so a
      // character is 0.6 of its font size and the arithmetic is honest —
      // which is the only way a right-aligned label cannot land on a
      // left-aligned one when a course turns out to gate eleven others.
      const inner = map.node.width - 16;
      const now = node.past === "running" ? " · now" : "";
      const gates = node.unlocks ? `gates ${node.unlocks}` : "";

      g.append(
        Object.assign(svg("text", { x: 8, y: 17, class: "code" }), {
          textContent: fit(
            node.code,
            Math.floor((inner - (`${node.credits}cr${now}`.length + 1) * 5.4) / 6.6),
          ),
        }),
      );
      g.append(
        Object.assign(
          svg("text", { x: map.node.width - 8, y: 17, class: "sub", "text-anchor": "end" }),
          { textContent: `${node.credits}cr${now}` },
        ),
      );
      g.append(
        Object.assign(svg("text", { x: 8, y: 32, class: "name" }), {
          textContent: fit(node.title, Math.floor(inner / 5.4) - (gates ? gates.length + 2 : 0)),
        }),
      );
      if (gates) {
        g.append(
          Object.assign(
            svg("text", { x: map.node.width - 8, y: 32, class: "sub", "text-anchor": "end" }),
            { textContent: gates },
          ),
        );
      }
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

    // A pointer can leave the picture without leaving a box: out of the window,
    // or straight onto the scrollbar. Then no box ever hears mouseleave.
    canvas.addEventListener("mouseleave", () => store.set({ focus: null }));

    board.append(canvas);
    drawn = { map, nodes: boxes, edges };
    highlight();

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
      (s) => s.flow,
      () => draw(),
    ),
    store.watch(
      (s) => s.focus,
      () => highlight(),
    ),
  );

  return {
    destroy() {
      subs.clear();
      root.replaceChildren();
    },
  };
}
