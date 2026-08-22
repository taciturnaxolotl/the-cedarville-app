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

/**
 * The term under a point on the picture.
 *
 * A term's heading is anchored at the start of its band and the bands are laid
 * out in order along one axis, so the band a point falls in is the last
 * heading before it. Which means the picture needs no hit-boxes: the layout it
 * already published is enough to say where a course was dropped.
 */
export function termAt(map: CourseMap, point: { x: number; y: number }) {
  const axis = map.flow === "down" ? "y" : "x";
  const value = point[axis];
  let found: CourseMap["terms"][number] | null = null;
  for (const term of map.terms) {
    if (term[axis] <= value) found = term;
  }
  return found;
}

/** SVG has no ellipsis, and a course name is longer than any box. */
const fit = (text: string, chars: number) =>
  text.length <= chars ? text : `${text.slice(0, Math.max(0, chars - 1)).trimEnd()}…`;

export function mountGraph(
  root: HTMLElement,
  plan: Plan,
  planning: Planning,
  options: {
    /**
     * Called when a course is dragged into another term. Absent, the picture
     * is read-only — which is what every other caller of this file wants.
     */
    onMove?: (code: string, term: string) => void;
    /**
     * Called to unpin a course, handing it back to the projection. A box two
     * lines tall has no room for a button, so it is a double click on the
     * pinned course, and the course says as much on hover.
     */
    onRelease?: (code: string) => void;
  } = {},
) {
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

  /*
   * Dragging a course into another term.
   *
   * The list rendering gets this for free from HTML drag and drop, which SVG
   * does not join in with. So the picture does it by hand: press, move, and
   * the band under the pointer lights up as the term the course would land
   * in. The geometry is the layout's own, so nothing here has to agree with
   * `buildMap` about where anything is.
   */
  let held: {
    code: string;
    term: string;
    box: SVGGElement;
    home: { x: number; y: number };
    at: { x: number; y: number };
    moved: boolean;
  } | null = null;
  let canvas: SVGSVGElement | null = null;
  let band: SVGRectElement | null = null;

  /** Page coordinates in the picture's own units. */
  const local = (event: MouseEvent) => {
    const box = canvas?.getBoundingClientRect();
    // A picture the browser has scaled still reports its own width, so the
    // ratio is the only honest way from a click to a coordinate.
    const scale = box?.width ? (drawn?.map.width ?? box.width) / box.width : 1;
    return {
      x: (event.clientX - (box?.left ?? 0)) * scale,
      y: (event.clientY - (box?.top ?? 0)) * scale,
    };
  };

  /** The band a term occupies, from its heading to the next one's. */
  function lightBand(term: CourseMap["terms"][number] | null) {
    if (!band || !drawn) return;
    if (!term || term.past) {
      band.style.display = "none";
      return;
    }
    const { map } = drawn;
    const down = map.flow === "down";
    const at = map.terms.indexOf(term);
    const next = map.terms[at + 1];
    const start = down ? term.y : term.x;
    const end = (down ? next?.y : next?.x) ?? (down ? map.height : map.width);
    band.style.display = "";
    band.setAttribute("x", String(down ? 0 : start - 6));
    band.setAttribute("y", String(down ? start - 6 : 0));
    band.setAttribute("width", String(down ? map.width : end - start));
    band.setAttribute("height", String(down ? end - start : map.height));
  }

  const letGo = () => {
    if (held) {
      held.box.classList.remove("dragging");
      held.box.setAttribute("transform", `translate(${held.home.x}, ${held.home.y})`);
    }
    held = null;
    lightBand(null);
  };

  const onPointerMove = (event: Event) => {
    if (!held) return;
    const at = local(event as MouseEvent);
    const dx = at.x - held.at.x;
    const dy = at.y - held.at.y;
    // A click is a press that went nowhere, and it should stay a click.
    if (!held.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    held.moved = true;
    held.box.classList.add("dragging");
    held.box.setAttribute("transform", `translate(${held.home.x + dx}, ${held.home.y + dy})`);
    if (drawn) lightBand(termAt(drawn.map, at));
  };

  const onPointerUp = (event: Event) => {
    if (!held) return;
    const { code, moved } = held;
    const target = drawn ? termAt(drawn.map, local(event as MouseEvent)) : null;
    letGo();
    if (moved && target && !target.past) options.onMove?.(code, target.name);
  };

  document.addEventListener("mousemove", onPointerMove);
  document.addEventListener("mouseup", onPointerUp);

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
    letGo();
    canvas = svg("svg", { width: map.width, height: map.height, class: "graph" });
    // Behind everything, so the term a course is headed for reads as ground
    // rather than as another box.
    band = svg("rect", { class: "band", x: 0, y: 0, width: 0, height: 0, rx: 4 });
    band.style.display = "none";
    canvas.append(band);

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
        class: `node${node.past ? ` ${node.past}` : ""}${node.moved ? " moved" : ""}${node.conflicts ? " clashes" : ""}`,
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
        node.moved ? `pinned to ${node.termName} — double click to unpin` : "",
        node.unlocks ? `${node.unlocks} later courses wait on this` : "",
        node.caution ?? "",
        node.conflicts ? `moved here, but it ${node.conflicts.join(", and ")}` : "",
      ]
        .filter(Boolean)
        .join(" — ");
      if (hint) {
        g.append(Object.assign(svg("title", {}), { textContent: hint }));
      }
      if (options.onRelease && node.moved) {
        g.addEventListener("dblclick", () => options.onRelease?.(node.code));
      }
      if (options.onMove && !node.past) {
        g.addEventListener("mousedown", (event) => {
          held = {
            code: node.code,
            term: node.termName,
            box: g,
            home: { x: node.x, y: node.y },
            at: local(event as MouseEvent),
            moved: false,
          };
          // Otherwise the browser starts its own text selection and the
          // picture smears blue behind the course being moved.
          event.preventDefault();
        });
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
      document.removeEventListener("mousemove", onPointerMove);
      document.removeEventListener("mouseup", onPointerUp);
      subs.clear();
      root.replaceChildren();
    },
  };
}
