/*
 * Schedule builder. The week you are assembling above, open requirements below.
 *
 * The organising idea is that you never browse a course catalogue in the
 * abstract — you browse it to close a specific requirement. So every section
 * here is reachable only underneath the requirement it would satisfy.
 *
 * Every visible thing is a subscription to a slice of state. Nothing pokes
 * the DOM from an event handler: ticking a section sets `picked`, and the
 * grid, the credit count, and only the affected rows repaint themselves.
 * That keeps hundreds of rows responsive with no diffing machinery.
 */

import { enumeratedCourseIds, openGroups } from "../../requirements";
import {
  conflictsBetween,
  DAY_NAMES,
  formatTime,
  type Offering,
  offeringsFromListing,
  span,
  week,
} from "../../schedule";
import { liveSeats } from "../bridge";
import type { Ctx } from "../ctx";
import { el, tag } from "../dom";
import { createStore, Subscriptions } from "../store";

const PICKED = "cedarville:picked-sections";

interface LiveSeats {
  available: number;
  capacity: number;
  status: string;
}

interface State {
  picked: ReadonlySet<string>;
  /** Live availability by section id, overriding the cached crawl. */
  seats: Readonly<Record<string, LiveSeats>>;
  loadingSeats: boolean;
}

const restore = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(PICKED) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
};

export function mount(root: HTMLElement, ctx: Ctx) {
  const { trees, sections: catalog } = ctx;
  const subs = new Subscriptions();

  if (!catalog) {
    root.replaceChildren(el("p", "muted", "pick a term to build a schedule."));
    return { destroy: () => root.replaceChildren() };
  }

  const all = offeringsFromListing(catalog.sections);
  const byId = new Map(all.map((o) => [o.id, o]));
  const byCourse = new Map<string, Offering[]>();
  for (const offering of all) {
    byCourse.set(offering.courseId, [...(byCourse.get(offering.courseId) ?? []), offering]);
  }

  const store = createStore<State>({ picked: restore(), seats: {}, loadingSeats: true });
  const chosen = (picked: ReadonlySet<string>) =>
    [...picked].map((id) => byId.get(id)).filter(Boolean) as Offering[];

  function toggle(id: string) {
    store.set((s) => {
      // A fresh Set every time, so Object.is sees the change.
      const picked = new Set(s.picked);
      if (picked.has(id)) picked.delete(id);
      else picked.add(id);
      localStorage.setItem(PICKED, JSON.stringify([...picked]));
      return { picked };
    });
  }

  // ---- the week --------------------------------------------------------

  const summary = el("p", "credits");
  const freshness = el("p", "muted seats-note");
  const clashes = el("div");
  const gridBox = el("div");

  subs.add(
    store.watch(
      (s) => s.picked,
      (picked) => {
        const schedule = chosen(picked);
        const credits = schedule.reduce((n, o) => n + o.credits.min, 0);
        summary.textContent = schedule.length
          ? `${schedule.length} sections · ${credits} credits`
          : "nothing picked yet";

        const found = schedule.flatMap((a, i) =>
          schedule.slice(i + 1).flatMap((b) => conflictsBetween(a, b)),
        );
        clashes.replaceChildren(
          ...found.map((clash) => {
            const [x, y] = clash.meetings;
            const day = x.days.find((d) => y.days.includes(d)) ?? 0;
            return el(
              "p",
              "clash",
              `${clash.a.courseName} and ${clash.b.courseName} overlap ${DAY_NAMES[day]} ` +
                `${formatTime(Math.max(x.start, y.start))}–${formatTime(Math.min(x.end, y.end))}`,
            );
          }),
        );
        gridBox.replaceChildren(...(schedule.length ? [renderGrid(schedule)] : []));
      },
    ),
    store.watch(
      (s) => (s.loadingSeats ? "loading" : Object.keys(s.seats).length),
      (state) => {
        freshness.textContent =
          state === "loading"
            ? "checking current seat counts…"
            : state === 0
              ? "seat counts are from the cached catalog"
              : `${state} seat counts live as of ${new Date().toLocaleTimeString()}`;
      },
    ),
  );

  /** "clash" when this section collides with anything already picked. */
  const clashKey = (picked: ReadonlySet<string>, offering: Offering) =>
    chosen(picked).some((other) => conflictsBetween(offering, other).length > 0) ? "clash" : "free";

  function row(offering: Offering): HTMLElement {
    const label = el("label", "section");
    label.dataset.section = offering.id;

    const box = el("input");
    box.type = "checkbox";
    box.addEventListener("change", () => toggle(offering.id));

    const when = offering.meetings.length
      ? offering.meetings
          .map(
            (m) =>
              `${m.days.map((d) => DAY_NAMES[d]).join("")} ` +
              `${formatTime(m.start)}–${formatTime(m.end)}`,
          )
          .join("; ")
      : "no set meeting time";

    const seatTag = tag("");
    label.append(box, el("span", "when", `${offering.courseName}-${offering.number}  ${when}`));
    if (offering.instructors.length) label.append(tag(offering.instructors.join(", ")));
    label.append(seatTag);
    if (offering.nonStandardDates) label.append(tag("partial term", "rule"));

    // One subscription per row, so picking a section repaints the rows it
    // actually affects rather than the whole list.
    subs.add(
      store.watch(
        (s) => (s.picked.has(offering.id) ? "picked" : clashKey(s.picked, offering)),
        (state) => {
          box.checked = state === "picked";
          label.classList.toggle("clashes", state === "clash");
        },
      ),
      store.watch(
        (s) => s.seats[offering.id] ?? null,
        (live) => {
          const seats = live ?? offering.seats;
          seatTag.textContent = `${seats.available} of ${seats.capacity} open`;
          seatTag.className = `tag ${seats.available > 0 ? "open" : "full"}${live ? " live" : ""}`;
          seatTag.title = live ? "live from Self-Service" : "from the cached catalog";
        },
      ),
    );
    return label;
  }

  // ---- the requirement list --------------------------------------------

  const list = el("div");
  const onScreen = new Set<string>();

  for (const tree of trees) {
    for (const { requirement, group } of openGroups(tree)) {
      const ids = enumeratedCourseIds(group);
      if (!ids) continue;

      const offerings = [...ids].flatMap((id) => byCourse.get(id) ?? []);
      if (offerings.length === 0) continue;
      for (const o of offerings) onScreen.add(o.courseId);

      const box = el("details", "req");
      const sum = el("summary");
      sum.append(el("span", `dot ${group.status.completion}`));
      sum.append(document.createTextNode(group.text || requirement.text));
      sum.append(tag(`${offerings.length} sections`));
      box.append(sum);
      for (const offering of offerings) box.append(row(offering));
      list.append(box);
    }
  }

  if (onScreen.size === 0) {
    list.append(
      el(
        "p",
        "muted",
        `none of your open requirements have a section in ${catalog.term}. ` +
          `the catalog holds ${all.length} sections for that term.`,
      ),
    );
  }

  const weekBox = el("div", "week");
  weekBox.append(summary, freshness, clashes, gridBox);
  root.replaceChildren(weekBox, list);

  // Only the courses actually on screen, which is a handful, not the term.
  void liveSeats(catalog.term, [...onScreen])
    .then((seats) => store.set({ seats, loadingSeats: false }))
    .catch(() => store.set({ loadingSeats: false }));

  return {
    destroy() {
      subs.clear();
      root.replaceChildren();
    },
  };
}

function renderGrid(schedule: Offering[]): HTMLElement {
  const bounds = span(schedule);
  const table = el("div", "grid");
  if (!bounds) return table;

  for (const column of week(schedule)) {
    const col = el("div", "day");
    col.append(el("h3", undefined, DAY_NAMES[column.day]));
    for (const item of column.items) {
      const block = el("div", "block");
      // Position and height read straight off the clock.
      block.style.top = `${((item.meeting.start - bounds.start) / 30) * 18}px`;
      block.style.height = `${Math.max(((item.meeting.end - item.meeting.start) / 30) * 18, 20)}px`;
      block.append(el("b", undefined, item.offering.courseName));
      block.append(
        el("span", undefined, `${formatTime(item.meeting.start)} ${item.meeting.room}`.trim()),
      );
      col.append(block);
    }
    col.style.height = `${((bounds.end - bounds.start) / 30) * 18 + 30}px`;
    table.append(col);
  }
  return table;
}
