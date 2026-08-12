/*
 * Dual-major overlap. One row per pair of requirements that draw on a common
 * course, sorted by how much they share, plus an explicit list of what could
 * not be checked.
 *
 * The unresolved list is not an appendix. A planner that quietly omits the
 * requirements it could not evaluate is lying by omission, and those are
 * exactly the ones ("one laboratory course from the biological sciences") a
 * student most needs to go ask about.
 */

import { merge } from "../../merge";
import type { ProgramTree } from "../../requirements";
import { el } from "../dom";

const WHY: Record<string, string> = {
  rule: "eligible courses live in a Colleague rule",
  "missing-attributes": "filters by department, which no evaluation returns",
};

const HEADING: Record<string, string> = {
  guaranteed: "counts twice automatically",
  elective: "counts twice if you pick the right course",
  "catch-all": "technically shared",
};

const BLURB: Record<string, string> = {
  guaranteed: "both majors require these outright. this is the dual-major discount.",
  elective: "both sides let you choose, and these choices satisfy each of them.",
  "catch-all": "one side accepts almost any course, so the overlap says little.",
};

export function mount(root: HTMLElement, trees: ProgramTree[]) {
  if (trees.length < 2) {
    root.replaceChildren(el("p", "muted", "capture a second major to compare."));
    return { destroy: () => root.replaceChildren() };
  }

  const [a, b] = trees as [ProgramTree, ProgramTree];
  const result = merge(a, b);
  const box = el("div");

  box.append(
    el(
      "p",
      "credits",
      `${a.code} + ${b.code} · ${result.shared.length} shared requirement pairs · ` +
        `${result.certainSharedCourses.length} distinct courses count toward both`,
    ),
  );

  let section = "";
  for (const pool of result.shared) {
    if (pool.significance !== section) {
      section = pool.significance;
      box.append(el("h2", undefined, HEADING[section]));
      box.append(el("p", "muted", BLURB[section]));
    }

    const row = el("div", "pool");
    const sides = el("div", "sides");
    for (const side of [pool.a, pool.b]) {
      const d = el("div", "side");
      d.append(el("b", undefined, side.program));
      d.append(document.createTextNode(side.group.text || side.requirement));
      sides.append(d);
    }
    row.append(sides);
    row.append(el("div", "courses", pool.courses.map((c) => c.CourseName).join("  ")));
    row.append(el("div", "count", `${pool.courses.length} shared`));
    box.append(row);
  }

  if (result.unresolved.length) {
    box.append(el("h2", undefined, "cannot be checked automatically"));
    const ul = el("ul", "unresolved");
    for (const u of result.unresolved) {
      ul.append(
        el(
          "li",
          undefined,
          `[${u.at.program}] ${u.at.group.text || u.at.group.code} — ${WHY[u.reason]}`,
        ),
      );
    }
    box.append(ul);
  }

  root.replaceChildren(box);
  return { destroy: () => root.replaceChildren() };
}
