/*
 * Requirement tree view. One <details> per requirement, one per subrequirement,
 * and a flat row per group — because the group is where the actual choice lives
 * and burying it a third level down would hide the only interactive part.
 *
 * Completion rides on a colour dot, planning on a tag. Keeping them visually
 * separate mirrors the data: Colleague tracks the two independently, and a
 * partly-done requirement whose remainder is planned is a different thing from
 * one that is a gap.
 */

import { type Group, gaps, openGroups, type ProgramTree } from "../../requirements";
import { el, tag } from "../dom";

function renderGroup(group: Group): HTMLElement {
  const row = el("div", "group");

  const head = el("div");
  head.append(el("span", `dot ${group.status.completion}`));
  head.append(document.createTextNode(group.text || group.code));

  const wants = [
    group.min.credits !== undefined ? `${group.min.credits} cr` : null,
    group.min.courses !== undefined ? `${group.min.courses} courses` : null,
  ].filter(Boolean) as string[];
  if (wants.length) head.append(tag(wants.join(", ")));

  if (group.constraint.kind === "rule-based") head.append(tag("check with advisor", "rule"));
  if (group.status.planning !== "NotPlanned" && group.status.completion !== "Completed") {
    head.append(tag("on your plan", "planned"));
  }
  row.append(head);

  const c = group.constraint;
  if (c.kind === "filter") {
    const bits = [
      c.subjects.length ? c.subjects.join("/") : null,
      c.levels.length ? `${c.levels.join("/")} level` : null,
      c.departments.length ? `dept ${c.departments.join("/")}` : null,
    ].filter(Boolean);
    row.append(el("div", "courses muted", `any ${bits.join(", ")}`));
  } else {
    // Colleague's own gap list when it has one, otherwise the whole pool.
    const pool = c.kind === "take-all" || c.kind === "choose-from" ? c.courses : [];
    const remaining = group.needed.length ? group.needed : pool;
    if (remaining.length) {
      const names = remaining.map((x) => x.CourseName);
      const head14 = names.slice(0, 14).join("  ");
      row.append(
        el("div", "courses", names.length > 14 ? `${head14}  +${names.length - 14} more` : head14),
      );
    }
  }

  if (group.applied.length) {
    const done = group.applied.map(
      (a) => `${a.CourseName}${a.VerifiedGrade ? ` ${a.VerifiedGrade}` : ""}`,
    );
    row.append(el("div", "courses muted", `done: ${done.join("  ")}`));
  }
  return row;
}

function renderTree(tree: ProgramTree): HTMLElement {
  const box = el("div", "program");
  box.append(el("h2", undefined, `${tree.title}  ·  ${tree.code}  ·  catalog ${tree.catalog}`));
  box.append(
    el(
      "p",
      "credits",
      `${tree.credits.completed} completed, ${tree.credits.inProgress} in progress of ` +
        `${tree.credits.minimum} · ${openGroups(tree).length} open, ${gaps(tree).length} unplanned`,
    ),
  );

  for (const req of tree.requirements) {
    const reqBox = el("details");
    const sum = el("summary");
    sum.append(el("span", `dot ${req.status.completion}`));
    sum.append(document.createTextNode(req.text));
    reqBox.append(sum);

    for (const sub of req.subrequirements) {
      const subBox = el("details");
      // Finished work starts folded; the open items are why you came.
      subBox.open = sub.status.completion !== "Completed";

      const subSum = el("summary");
      subSum.append(el("span", `dot ${sub.status.completion}`));
      subSum.append(document.createTextNode(sub.text || sub.code));
      if (sub.minGroups !== null) {
        subSum.append(tag(`any ${sub.minGroups} of ${sub.groups.length}`));
      }
      subBox.append(subSum);
      for (const g of sub.groups) subBox.append(renderGroup(g));
      reqBox.append(subBox);
    }
    box.append(reqBox);
  }
  return box;
}

export function mount(root: HTMLElement, trees: ProgramTree[]) {
  root.replaceChildren(...trees.map(renderTree));
  return {
    destroy() {
      root.replaceChildren();
    },
  };
}
