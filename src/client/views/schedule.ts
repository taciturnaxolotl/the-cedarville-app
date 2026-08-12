/*
 * Schedule builder, organised around courses rather than sections.
 *
 * The old layout listed every section flat under its requirement, which
 * answered "when does this meet" and nothing else. The two questions that
 * actually decide a term are "can I take this yet" and "what does taking it
 * unlock", so those lead: each course carries its eligibility and the size of
 * its downstream, and sections are the detail you open once you have chosen.
 *
 * Ordering follows the same logic. A course that gates eleven others is worth
 * taking before one that gates none, so open courses sort first and, within
 * those, the ones with the longest tail behind them.
 *
 * Every visible thing is a subscription to a slice of state. Nothing pokes the
 * DOM from an event handler.
 */

import {
  buildGraph,
  type CourseNode,
  depth,
  downstream,
  eligibility,
  parseRequisite,
} from "../../prereqs";
import {
  completedCourses,
  enumeratedCourseIds,
  inProgressCourses,
  openGroups,
} from "../../requirements";
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
/** Half-hour rows, in pixels. The grid is legible and not enormous. */
const ROW = 20;

interface Seats {
  available: number;
  capacity: number;
  status: string;
}

interface State {
  picked: ReadonlySet<string>;
  seats: Readonly<Record<string, Seats>>;
  loadingSeats: boolean;
  /** Hide courses whose prerequisites are not met. */
  hideBlocked: boolean;
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

  // ---- what blocks what ------------------------------------------------

  const nodes: CourseNode[] = (catalog.courses ?? []).map((c) => ({
    code: `${c.SubjectCode}-${c.Number}`,
    title: c.Title,
    requisites: (c.CourseRequisites ?? []).map(parseRequisite),
  }));
  const graph = buildGraph(nodes);
  const nodeFor = (offering: Offering) => graph.courses.get(offering.courseName);

  const completed = new Set<string>();
  const enrolled = new Set<string>();
  for (const tree of trees) {
    for (const code of completedCourses(tree)) completed.add(code);
    for (const code of inProgressCourses(tree)) enrolled.add(code);
  }

  const store = createStore<State>({
    picked: restore(),
    seats: {},
    loadingSeats: true,
    hideBlocked: false,
  });

  const chosen = (picked: ReadonlySet<string>) =>
    [...picked].map((id) => byId.get(id)).filter(Boolean) as Offering[];

  /** Courses picked this term also satisfy a corequisite. */
  const alsoTaking = (picked: ReadonlySet<string>) =>
    new Set([...enrolled, ...chosen(picked).map((o) => o.courseName)]);

  function toggle(id: string) {
    store.set((s) => {
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
      (s) => (s.loadingSeats ? -1 : Object.keys(s.seats).length),
      (count) => {
        freshness.textContent =
          count < 0
            ? "checking current seat counts…"
            : count === 0
              ? "seat counts are from the cached catalog"
              : `${count} seat counts live as of ${new Date().toLocaleTimeString()}`;
      },
    ),
  );

  // ---- a section row ---------------------------------------------------

  function sectionRow(offering: Offering): HTMLElement {
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
    label.append(box, el("span", "when", `${offering.number}  ${when}`));
    if (offering.meetings[0]?.room) label.append(el("span", "room", offering.meetings[0].room));
    if (offering.instructors.length)
      label.append(el("span", "who", offering.instructors.join(", ")));
    label.append(seatTag);
    if (offering.nonStandardDates) label.append(tag("partial term", "rule"));

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
          seatTag.textContent = `${seats.available}/${seats.capacity}`;
          seatTag.className = `tag seats ${seats.available > 0 ? "open" : "full"}${live ? " live" : ""}`;
          seatTag.title = `${seats.available} of ${seats.capacity} seats open, ${
            live ? "live from Self-Service" : "from the cached catalog"
          }`;
        },
      ),
    );
    return label;
  }

  const clashKey = (picked: ReadonlySet<string>, offering: Offering) =>
    chosen(picked).some((other) => conflictsBetween(offering, other).length > 0) ? "clash" : "free";

  // ---- a course card ---------------------------------------------------

  function courseCard(offerings: Offering[]): HTMLElement {
    const first = offerings[0]!;
    const node = nodeFor(first);
    const unlocks = node ? downstream(graph, node.code).size : 0;
    const chain = node ? depth(graph, node.code) : 0;

    const card = el("details", "course");
    const head = el("summary");

    head.append(el("b", "code", first.courseName));
    head.append(el("span", "title", first.title));
    head.append(el("span", "cr", `${first.credits.min} cr`));

    const status = el("span", "gate");
    head.append(status);
    if (unlocks > 0) {
      const t = tag(`unlocks ${unlocks}`, "unlocks");
      t.title =
        `${unlocks} later course${unlocks === 1 ? "" : "s"} depend on this one` +
        (chain ? `, and it sits ${chain} deep in its own chain` : "");
      head.append(t);
    }
    head.append(
      el("span", "count", `${offerings.length} section${offerings.length === 1 ? "" : "s"}`),
    );
    card.append(head);

    // Why it is blocked, spelled out rather than implied by a colour.
    const reason = el("p", "gate-why");
    card.append(reason);
    for (const offering of offerings) card.append(sectionRow(offering));

    subs.add(
      store.watch(
        (s) => {
          if (!node) return "open";
          const verdict = eligibility(node, completed, alsoTaking(s.picked), {
            exists: (c) => graph.courses.has(c),
          });
          return verdict.state === "open"
            ? "open"
            : `${verdict.state}:${verdict.blockedBy.join(",")}`;
        },
        (key) => {
          const [state, blocked] = key.split(":");
          card.dataset.state = state;
          status.textContent =
            state === "open" ? "ready" : state === "blocked" ? "blocked" : "check";
          status.className = `gate ${state}`;

          if (state === "open") {
            reason.textContent = "";
            reason.hidden = true;
            return;
          }
          reason.hidden = false;
          if (state === "blocked") {
            reason.textContent = `needs ${blocked?.split(",").filter(Boolean).join(", ")}`;
          } else {
            const verdict =
              node &&
              eligibility(node, completed, alsoTaking(store.get().picked), {
                exists: (c) => graph.courses.has(c),
              });
            reason.textContent =
              verdict && verdict.state === "unknown"
                ? verdict.why.join(" ")
                : "has a condition we cannot check";
          }
        },
      ),
      store.watch(
        (s) => s.hideBlocked && card.dataset.state === "blocked",
        (hide) => {
          card.hidden = hide;
        },
      ),
    );
    return card;
  }

  // ---- the requirement list --------------------------------------------

  const list = el("div");
  const onScreen = new Set<string>();

  for (const tree of trees) {
    for (const { requirement, group } of openGroups(tree)) {
      const ids = enumeratedCourseIds(group);
      if (!ids) continue;

      const courses = [...ids].map((id) => byCourse.get(id)).filter(Boolean) as Offering[][];
      if (courses.length === 0) continue;
      for (const offerings of courses) onScreen.add(offerings[0]!.courseId);

      // Ready first, then whatever gates the most.
      courses.sort((a, b) => {
        const rank = (o: Offering[]) => {
          const node = nodeFor(o[0]!);
          return node && eligibility(node, completed, enrolled).state !== "open" ? 1 : 0;
        };
        const byReady = rank(a) - rank(b);
        if (byReady !== 0) return byReady;
        const tail = (o: Offering[]) => {
          const node = nodeFor(o[0]!);
          return node ? downstream(graph, node.code).size : 0;
        };
        return tail(b) - tail(a) || a[0]!.courseName.localeCompare(b[0]!.courseName);
      });

      const box = el("details", "req");
      box.open = true;
      const sum = el("summary");
      sum.append(el("span", `dot ${group.status.completion}`));
      sum.append(document.createTextNode(group.text || requirement.text));
      sum.append(tag(`${courses.length} courses`));
      box.append(sum);
      for (const offerings of courses) box.append(courseCard(offerings));
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

  // ---- chrome ----------------------------------------------------------

  const filter = el("label", "toggle");
  const hide = el("input");
  hide.type = "checkbox";
  hide.addEventListener("change", () => store.set({ hideBlocked: hide.checked }));
  filter.append(hide, el("span", undefined, "hide courses I cannot take yet"));

  const weekBox = el("div", "week");
  weekBox.append(summary, freshness, clashes, gridBox, filter);
  root.replaceChildren(weekBox, list);

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

/** A weekday grid with an hour gutter, positioned straight off the clock. */
function renderGrid(schedule: Offering[]): HTMLElement {
  const bounds = span(schedule);
  const table = el("div", "grid");
  if (!bounds) return table;

  const from = Math.floor(bounds.start / 60) * 60;
  const to = Math.ceil(bounds.end / 60) * 60;
  const height = ((to - from) / 30) * ROW;
  const place = (minutes: number) => ((minutes - from) / 30) * ROW;

  const gutter = el("div", "gutter");
  for (let minute = from; minute <= to; minute += 60) {
    const mark = el("span", "hour", formatTime(minute));
    mark.style.top = `${place(minute)}px`;
    gutter.append(mark);
  }
  gutter.style.height = `${height + 26}px`;
  table.append(gutter);

  for (const column of week(schedule)) {
    const col = el("div", "day");
    col.append(el("h3", undefined, DAY_NAMES[column.day]));
    for (const item of column.items) {
      const block = el("div", "block");
      block.style.top = `${place(item.meeting.start) + 26}px`;
      block.style.height = `${Math.max(place(item.meeting.end) - place(item.meeting.start), 18)}px`;
      block.append(el("b", undefined, item.offering.courseName));
      block.append(
        el("span", undefined, `${formatTime(item.meeting.start)} ${item.meeting.room}`.trim()),
      );
      col.append(block);
    }
    col.style.height = `${height + 26}px`;
    table.append(col);
  }
  return table;
}
