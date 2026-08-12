/*
 * Schedule builder. Open requirements on the left, the week you are assembling
 * on top.
 *
 * The organising idea is that you never browse a course catalogue in the
 * abstract — you browse it in order to close a specific requirement. So every
 * section on this page is reachable only underneath the requirement it would
 * satisfy, and picking one immediately shows what it collides with.
 */

import { enumeratedCourseIds, openGroups, type ProgramTree } from "../../requirements";
import {
  conflictsBetween,
  DAY_NAMES,
  formatTime,
  type Offering,
  offeringsFromListing,
  span,
  week,
} from "../../schedule";
import type { Ctx } from "../ctx";
import { el, tag } from "../dom";

const PICKED = "cedarville:picked-sections";

const loadPicked = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(PICKED) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
};

export function mount(root: HTMLElement, ctx: Ctx) {
  const { trees, sections: capture } = ctx;
  if (!capture) {
    root.replaceChildren(el("p", "muted", "pick a term to build a schedule."));
    return { destroy: () => root.replaceChildren() };
  }

  const all = offeringsFromListing(capture.sections);
  const byCourse = new Map<string, Offering[]>();
  for (const offering of all) {
    const bucket = byCourse.get(offering.courseId) ?? [];
    bucket.push(offering);
    byCourse.set(offering.courseId, bucket);
  }
  const byId = new Map(all.map((o) => [o.id, o]));

  const picked = loadPicked();
  const chosen = () => [...picked].map((id) => byId.get(id)).filter(Boolean) as Offering[];

  const grid = el("div", "week");
  const list = el("div");
  root.replaceChildren(grid, list);

  function save() {
    localStorage.setItem(PICKED, JSON.stringify([...picked]));
  }

  function renderGrid() {
    const schedule = chosen();
    grid.replaceChildren();

    const credits = schedule.reduce((n, o) => n + o.credits.min, 0);
    grid.append(
      el(
        "p",
        "credits",
        schedule.length === 0
          ? "nothing picked yet"
          : `${schedule.length} sections · ${credits} credits`,
      ),
    );

    // Clashes first: the whole reason to look at a grid.
    const clashes = schedule.flatMap((a, i) =>
      schedule.slice(i + 1).flatMap((b) => conflictsBetween(a, b)),
    );
    for (const clash of clashes) {
      const [x, y] = clash.meetings;
      grid.append(
        el(
          "p",
          "clash",
          `${clash.a.courseName} and ${clash.b.courseName} overlap ` +
            `${DAY_NAMES[x.days.find((d) => y.days.includes(d)) ?? 0]} ` +
            `${formatTime(Math.max(x.start, y.start))}–${formatTime(Math.min(x.end, y.end))}`,
        ),
      );
    }

    const bounds = span(schedule);
    if (!bounds) return;

    const table = el("div", "grid");
    for (const column of week(schedule)) {
      const col = el("div", "day");
      col.append(el("h3", undefined, DAY_NAMES[column.day]));
      for (const item of column.items) {
        const block = el("div", "block");
        // Position and height read straight off the clock.
        const top = ((item.meeting.start - bounds.start) / 30) * 18;
        const height = Math.max(((item.meeting.end - item.meeting.start) / 30) * 18, 20);
        block.style.top = `${top}px`;
        block.style.height = `${height}px`;
        block.append(el("b", undefined, item.offering.courseName));
        block.append(
          el("span", undefined, `${formatTime(item.meeting.start)} ${item.meeting.room}`.trim()),
        );
        col.append(block);
      }
      col.style.height = `${((bounds.end - bounds.start) / 30) * 18 + 30}px`;
      table.append(col);
    }
    grid.append(table);
  }

  function sectionRow(offering: Offering): HTMLElement {
    const row = el("label", "section");
    const box = el("input");
    box.type = "checkbox";
    box.checked = picked.has(offering.id);
    box.addEventListener("change", () => {
      if (box.checked) picked.add(offering.id);
      else picked.delete(offering.id);
      save();
      renderGrid();
      // A pick can newly clash with anything already chosen.
      for (const other of Array.from(list.querySelectorAll<HTMLElement>(".section"))) {
        other.classList.remove("clashes");
      }
      for (const chosenOne of chosen()) {
        for (const candidate of all) {
          if (picked.has(candidate.id)) continue;
          if (conflictsBetween(candidate, chosenOne).length === 0) continue;
          for (const node of Array.from(
            list.querySelectorAll<HTMLElement>(`[data-section="${candidate.id}"]`),
          )) {
            node.classList.add("clashes");
          }
        }
      }
    });
    row.dataset.section = offering.id;
    row.append(box);

    const when = offering.meetings.length
      ? offering.meetings
          .map(
            (m) =>
              `${m.days.map((d) => DAY_NAMES[d]).join("")} ` +
              `${formatTime(m.start)}–${formatTime(m.end)}`,
          )
          .join("; ")
      : "no set meeting time";

    row.append(el("span", "when", `${offering.courseName}-${offering.number}  ${when}`));
    if (offering.instructors.length) row.append(tag(offering.instructors.join(", ")));
    row.append(
      tag(
        `${offering.seats.available} of ${offering.seats.capacity} open`,
        offering.seats.available > 0 ? "open" : "full",
      ),
    );
    if (offering.nonStandardDates) row.append(tag("partial term", "rule"));
    return row;
  }

  // One block per open requirement, holding only the sections that close it.
  let shown = 0;
  for (const tree of trees) {
    for (const { requirement, group } of openGroups(tree)) {
      const ids = enumeratedCourseIds(group);
      if (!ids) continue;

      const offerings = [...ids].flatMap((id) => byCourse.get(id) ?? []);
      if (offerings.length === 0) continue;
      shown++;

      const box = el("details", "req");
      const sum = el("summary");
      sum.append(el("span", `dot ${group.status.completion}`));
      sum.append(document.createTextNode(group.text || requirement.text));
      sum.append(tag(`${offerings.length} sections`));
      box.append(sum);
      for (const offering of offerings) box.append(sectionRow(offering));
      list.append(box);
    }
  }

  if (shown === 0) {
    list.append(
      el(
        "p",
        "muted",
        `none of your open requirements have a section in ${capture.term}. ` +
          `the catalog holds ${all.length} sections for that term.`,
      ),
    );
  }

  renderGrid();
  return { destroy: () => root.replaceChildren() };
}
