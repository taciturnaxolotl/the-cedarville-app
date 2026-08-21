/*
 * Your record, as the registrar holds it.
 *
 * The other tabs are about a degree you have not finished. This one is about
 * the one you are actually enrolled in: what you are reading for, where you
 * stand, what an advisor has changed by hand, and then the audit itself.
 *
 * It used to open as six collapsed requirements and 55 groups flat, with two
 * paragraphs of proficiency prose at the top and finished work taking the same
 * room as live work. The order here is the order the questions are asked in:
 * who am I, how far along, what was changed for me, and only then the tree.
 * Finished requirements fold away, because a degree audit is read for its gaps.
 */

import { STANDING_CREDITS } from "../../planner";
import {
  type Group,
  gaps,
  openGroups,
  type ProgramTree,
  type Requirement,
  stillRequiring,
  substitutionsIn,
  unreadModifications,
} from "../../requirements";
import type { Ctx } from "../ctx";
import { el, tag } from "../dom";

/** Where the catalog's classification table puts a student. */
function standingAt(credits: number): string {
  if (credits >= STANDING_CREDITS.senior) return "senior";
  if (credits >= STANDING_CREDITS.junior) return "junior";
  if (credits >= STANDING_CREDITS.sophomore) return "sophomore";
  return "freshman";
}

/** How far off the next one is, which is the part worth acting on. */
function nextStanding(credits: number): string {
  for (const [name, at] of [
    ["sophomore", STANDING_CREDITS.sophomore],
    ["junior", STANDING_CREDITS.junior],
    ["senior", STANDING_CREDITS.senior],
  ] as const) {
    if (credits < at) return `${at - credits} credits to ${name}`;
  }
  return "";
}

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

  if (group.constraint.kind === "rule-based") {
    // Not "ask someone": the school evaluates this correctly on its own. We
    // simply cannot show the options, because Colleague keeps the eligible
    // course list inside a server-side rule and never sends it.
    const label = tag("no course list", "rule");
    label.title =
      `Colleague decides this with rule ${group.constraint.ruleIds.join(", ") || "(unnamed)"} ` +
      `and does not publish which courses qualify. Self-Service still counts it correctly; ` +
      `this planner just cannot list your choices.`;
    head.append(label);
  }
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

function renderRequirement(requirement: Requirement): HTMLElement {
  const done = requirement.status.completion === "Completed";
  const box = el("details", done ? "met" : undefined);
  // Open on what is unfinished. A record is read for its gaps, and six closed
  // rows make you click six times to find out you have none.
  box.open = !done;

  const sum = el("summary");
  sum.append(el("span", `dot ${requirement.status.completion}`));
  sum.append(document.createTextNode(requirement.text));
  const open = requirement.subrequirements.flatMap((s) =>
    s.groups.filter(
      (g) => g.constraint.kind !== "print-only" && g.status.completion !== "Completed",
    ),
  );
  sum.append(tag(done ? "met" : `${open.length} open`, done ? "free" : ""));
  box.append(sum);

  for (const sub of requirement.subrequirements) {
    const subBox = el("details");
    subBox.open = sub.status.completion !== "Completed";

    const subSum = el("summary");
    subSum.append(el("span", `dot ${sub.status.completion}`));
    subSum.append(document.createTextNode(sub.text || sub.code));
    if (sub.minGroups !== null) {
      subSum.append(tag(`any ${sub.minGroups} of ${sub.groups.length}`));
    }
    subBox.append(subSum);
    for (const g of sub.groups) subBox.append(renderGroup(g));
    box.append(subBox);
  }
  return box;
}

/** The credentials one enrolment covers, which its code never says. */
function credentials(tree: ProgramTree): HTMLElement {
  const line = el("p", "chips");
  for (const major of tree.majors) line.append(tag(major, "on"));
  for (const minor of tree.minors) line.append(tag(minor, "on"));
  if (!tree.majors.length && !tree.minors.length) line.append(tag(tree.title || tree.code, "on"));
  return line;
}

function renderTree(tree: ProgramTree, all: readonly ProgramTree[]): HTMLElement {
  const box = el("div", "program");
  box.append(el("h2", undefined, `${tree.title}  ·  ${tree.code}  ·  catalog ${tree.catalog}`));
  box.append(credentials(tree));

  const held = tree.credits.completed + tree.credits.inProgress;
  const ahead = nextStanding(held);
  box.append(
    el(
      "p",
      "credits",
      `${tree.credits.completed} completed, ${tree.credits.inProgress} in progress of ` +
        `${tree.credits.minimum} · ${standingAt(held)}${ahead ? `, ${ahead}` : ""} · ` +
        `${openGroups(tree).length} open, ${gaps(tree).length} unplanned`,
    ),
  );

  // What a person changed on purpose comes before what the system generated.
  const have = new Set(
    [...tree.requirements].flatMap((r) =>
      r.subrequirements.flatMap((s) => s.groups.flatMap((g) => g.applied.map((a) => a.CourseName))),
    ),
  );
  for (const swap of substitutionsIn(tree)) {
    const note = el("p", "swap");
    note.append(el("b", undefined, swap.taken));
    note.append(document.createTextNode(` replaces ${swap.waives} for ${swap.requirement}`));
    note.title = swap.text;
    const asking = stillRequiring(all, swap.waives, have).filter(
      (r) => r.requirement !== swap.requirement,
    );
    if (asking.length) {
      note.append(
        el(
          "span",
          "carries",
          ` — ${asking.map((r) => r.requirement).join(" and ")} still lists it`,
        ),
      );
    }
    box.append(note);
  }
  for (const unread of unreadModifications(tree)) {
    box.append(el("p", "swap muted", unread.text));
  }

  for (const requirement of tree.requirements) box.append(renderRequirement(requirement));
  return box;
}

export function mount(root: HTMLElement, ctx: Ctx) {
  if (ctx.trees.length === 0) {
    root.replaceChildren(el("p", "muted", "capture your requirements to see your record."));
    return { destroy: () => root.replaceChildren() };
  }
  root.replaceChildren(...ctx.trees.map((tree) => renderTree(tree, ctx.trees)));
  return {
    destroy() {
      root.replaceChildren();
    },
  };
}
