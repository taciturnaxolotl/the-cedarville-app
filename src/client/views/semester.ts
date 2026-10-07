/*
 * One semester, on the clock.
 *
 * The other tabs answer "what do I still owe" and "when do I finish". This one
 * answers the question between them and registration: of the courses the plan
 * put in this term, which section of each am I in?
 *
 * The week is the object here, not a summary of one. `src/timetable.ts` picks
 * one section per course so that nothing collides, preferring seats you can
 * get, days you can have off and hours you are not waiting around, and the
 * grid shows that the moment the tab opens. The course list beside it is one
 * line each, because a list of every section's days, room, instructor and seat
 * count is a timetable rendered as prose, and the timetable is right there.
 *
 * Changing it is a radio button, which is what choosing one of several things
 * has always been. A course opens to its sections, hovering one draws it on
 * the week so you can see where it would fall, and taking it keeps it — never
 * weighed again, with the rest of the week arranged around it. The first
 * option in every group hands the choice back to the arranger, so "whose
 * decision was this" is a thing you can see and change rather than infer.
 *
 * An earlier draft asked for a drag onto the week. It read well written down
 * and badly in the hand: the thing being dragged has a fixed time, so the
 * only honest drop targets were the few places it could already go.
 */

import { compareTerms, shortTerm, termCodeOf } from "../../catalog";
import type { Plan, PlannedTerm, TermSlot } from "../../planner";
import { downstream, eligibility } from "../../prereqs";
import {
  conflictsBetween,
  DAY_NAMES,
  formatTime,
  type Meeting,
  type Offering,
  offeringsFromListing,
  type Weekday,
} from "../../schedule";
import { type Arrangement, arrange, type SectionChoice, type Shape } from "../../timetable";
import { liveSeats } from "../bridge";
import type { Ctx } from "../ctx";
import { el, tag } from "../dom";
import { olderThan, since, TERM_HOURS } from "../freshness";
import { readLoad } from "../load";
import { type Moves, OUT, readMoves, writeMoves } from "../moves";
import { baseCode, planningFrom, projectionFrom, read } from "../planning";
import { createStore, Subscriptions } from "../store";

const PINNED = "cedarville:picked-sections";
const SHAPE = "cedarville:week-shape";
/** Half-hour rows, in pixels. The grid is legible and not enormous. */
const ROW = 20;
/** Room for the weekday heading above the first block. */
const HEAD = 26;
/**
 * The hours the week always shows. A grid that fits itself to whatever is
 * taken moves every block each time one is added, so the day is a fixed frame
 * that only ever grows.
 */
const DAY_START = 8 * 60;
const DAY_END = 17 * 60;
/** Columns that are always there, even in a week with nothing on them. */
const WEEKDAYS: Weekday[] = [1, 2, 3, 4, 5];
/** Terms to offer. Six is three years, which is further than any timetable. */
const AHEAD = 6;

const SHAPES: { value: Shape; label: string; title: string }[] = [
  {
    value: "compact",
    label: "fewest days",
    title: "Packs the week into as few days as it can, then closes the gaps between classes.",
  },
  {
    value: "early",
    label: "finish early",
    title: "Takes the earliest sections, so the afternoons are yours.",
  },
  {
    value: "late",
    label: "no early mornings",
    title: "Starts the day as late as the timetable allows.",
  },
];

interface State {
  /** Section ids the student chose. Everything else is the arranger's. */
  pinned: ReadonlySet<string>;
  shape: Shape;
  /**
   * A section id or course code the pointer is over, drawn on the week as a
   * ghost. The question it answers is "where would this fall", which is the
   * one thing a list of times cannot show.
   */
  showing: string | null;
  /** When live seat counts landed, which the arranger weighs. */
  seatsAt: number;
  liveSeats: number;
  loadingSeats: boolean;
  /** The student's own edits to the generated plan, shared with the plan tab. */
  moves: Moves;
  /** Bumped when the rule groups come back, to reproject with their courses. */
  resolvedAt: number;
}

/**
 * Pins are kept per term. They were once a single flat list, from before the
 * view knew which term it was looking at, and a list like that quietly counted
 * last autumn's sections against this spring's credits.
 */
function restore(term: string): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(PINNED) ?? "null") as unknown;
    if (Array.isArray(raw)) return new Set(raw as string[]);
    const list = (raw as Record<string, string[]> | null)?.[term];
    return new Set(Array.isArray(list) ? list : []);
  } catch {
    return new Set();
  }
}

function save(term: string, pinned: ReadonlySet<string>) {
  let all: Record<string, string[]> = {};
  try {
    const raw = JSON.parse(localStorage.getItem(PINNED) ?? "null") as unknown;
    if (raw && !Array.isArray(raw)) all = raw as Record<string, string[]>;
  } catch {
    /* A record we cannot read is a record we replace. */
  }
  all[term] = [...pinned];
  localStorage.setItem(PINNED, JSON.stringify(all));
}

/** A course as this term presents it: what it costs, and what you can take. */
interface Row {
  /** The plan's code, which carries a "#2" for a second sitting. */
  code: string;
  credits: number;
  offerings: Offering[];
  caution?: string;
  conflicts?: string[];
}

/** Everything one render needs, worked out once. */
interface Shown {
  planned: PlannedTerm | undefined;
  rows: Row[];
  arranged: Arrangement;
  /** What the student will have passed by the time this term opens. */
  held: Set<string>;
}

export function mount(root: HTMLElement, ctx: Ctx) {
  const { trees, sections: catalog } = ctx;
  const subs = new Subscriptions();

  if (!catalog) {
    root.replaceChildren(el("p", "muted", "pick a term and load its catalog to plan a semester."));
    return { destroy: () => root.replaceChildren() };
  }
  if (trees.length === 0) {
    root.replaceChildren(
      el(
        "p",
        "muted",
        "capture your requirements to plan a semester. the catalog holds " +
          `${catalog.sections.length} sections for ${catalog.term}.`,
      ),
    );
    return { destroy: () => root.replaceChildren() };
  }

  const term = catalog.term;
  /** Captured here, where the guard above has already narrowed the catalog. */
  const crawledAt = catalog.fetchedAt;
  const all = offeringsFromListing(catalog.sections);
  const byId = new Map(all.map((o) => [o.id, o]));
  /** Keyed on "CS-1210", which is the language the projection speaks. */
  const byCourse = new Map<string, Offering[]>();
  for (const offering of all) {
    byCourse.set(offering.courseName, [...(byCourse.get(offering.courseName) ?? []), offering]);
  }
  // Sections in a stable order, so the arranger's answer never depends on the
  // order the crawl happened to return them in.
  for (const list of byCourse.values()) list.sort((a, b) => a.number.localeCompare(b.number));

  // ---- the projection -----------------------------------------------------

  const planning = planningFrom(ctx);
  const projection = projectionFrom(planning);
  const { graph } = planning;
  const load = readLoad();
  const slots = planning.slots(load);

  /** "2027SP" as the projection names it: "SP27". */
  const slotName = shortTerm(term);
  const slot: TermSlot | null = slots.find((s) => s.name === slotName) ?? null;
  const index = slots.findIndex((s) => s.name === slotName);

  const store = createStore<State>({
    pinned: restore(term),
    shape: read<Shape>(SHAPE, "compact"),
    showing: null,
    seatsAt: 0,
    liveSeats: 0,
    loadingSeats: true,
    moves: readMoves(),
    resolvedAt: 0,
  });

  void projection.refine().then((changed) => {
    if (changed) store.set({ resolvedAt: Date.now() });
  });

  const edit = (change: (moves: Moves) => Moves) => {
    const moves = change({ ...store.get().moves });
    writeMoves(moves);
    store.set({ moves });
  };
  const place = (code: string, at: string) => edit((m) => ({ ...m, [code]: at }));
  const release = (code: string) =>
    edit((m) => {
      delete m[code];
      return m;
    });

  /**
   * What the student will hold by the time this term starts: the transcript,
   * the term under way, and everything the plan schedules before this one.
   * Judging a spring course against today's transcript alone reports half a
   * degree as blocked by courses the plan already has in hand.
   */
  function heldBefore(plan: Plan): Set<string> {
    const held = new Set(planning.have);
    if (index < 0) return held;
    for (const planned of plan.terms) {
      const at = slots.findIndex((s) => s.name === planned.slot.name);
      if (at >= 0 && at < index) for (const c of planned.courses) held.add(baseCode(c.code));
    }
    return held;
  }

  const choicesOf = (rows: Row[]): SectionChoice[] =>
    rows.map((row) => ({ code: baseCode(row.code), offerings: row.offerings }));

  /** The term the plan made, and the week that fits it. */
  function termOf(moves: Moves, pinned: ReadonlySet<string>, shape: Shape): Shown {
    const plan = projection.project(moves, load);
    const planned = slot ? plan.terms.find((t) => t.slot.name === slotName) : undefined;

    const rows: Row[] = (planned?.courses ?? []).map((course) => ({
      code: course.code,
      credits: course.credits,
      offerings: byCourse.get(baseCode(course.code)) ?? [],
      ...(course.caution ? { caution: course.caution } : {}),
      ...(course.conflicts ? { conflicts: course.conflicts } : {}),
    }));

    return {
      planned,
      rows,
      arranged: arrange(choicesOf(rows), { pinned, shape }),
      held: heldBefore(plan),
    };
  }

  // ---- taking a section ---------------------------------------------------

  const chosenIn = (shown: Shown) => [...shown.arranged.chosen.values()];

  /** A course holds one section, so taking a second lets the first go. */
  function take(offering: Offering) {
    store.set((s) => {
      const pinned = new Set(s.pinned);
      for (const id of [...pinned]) {
        if (byId.get(id)?.courseName === offering.courseName) pinned.delete(id);
      }
      pinned.add(offering.id);
      save(term, pinned);
      return { pinned };
    });
  }

  /** Hands it back to the arranger, which may well choose it again. */
  function unpin(offering: Offering) {
    store.set((s) => {
      const pinned = new Set(s.pinned);
      pinned.delete(offering.id);
      save(term, pinned);
      return { pinned };
    });
  }

  /** The same, for a course rather than a section: the "auto" option. */
  function unpinCourse(code: string) {
    store.set((s) => {
      const pinned = new Set(s.pinned);
      for (const id of [...pinned]) {
        if (byId.get(id)?.courseName === code) pinned.delete(id);
      }
      save(term, pinned);
      return { pinned };
    });
  }

  const toggle = (offering: Offering) =>
    store.get().pinned.has(offering.id) ? unpin(offering) : take(offering);

  // ---- chrome -------------------------------------------------------------

  const controls = el("div", "plan-controls");

  /**
   * Which term is on screen.
   *
   * The shell owns the fetching, so this asks rather than loading: there is
   * one term control, one status line and one copy of the catalog, and a view
   * that fetched its own would be a second answer to which term this is.
   */
  const terms = el("select");
  /*
   * Terms the plan reaches, narrowed to the ones worth asking for. Colleague
   * publishes a term or two ahead, so offering the autumn after next is
   * offering a crawl that comes back empty; when the shell has not said what
   * exists, the plan's own slots are the best guess there is.
   */
  const reachable = slots.slice(0, AHEAD).map(termCodeOf);
  const known = ctx.terms?.length
    ? reachable.filter((code) => ctx.terms?.includes(code))
    : reachable;
  const offerable = known.includes(term) ? known : [...known, term];
  for (const code of [...new Set(offerable)].sort(compareTerms)) {
    const option = el("option");
    option.value = code;
    option.textContent = `${shortTerm(code)} · ${code}`;
    terms.append(option);
  }
  terms.value = term;
  terms.disabled = !ctx.loadTerm || offerable.length < 2;
  terms.title = ctx.loadTerm
    ? "Another term of the plan, laid out on the clock. One that nobody has crawled yet is " +
      "crawled on the way."
    : "This page was handed one term's timetable and cannot fetch another.";
  terms.addEventListener("change", () => {
    if (terms.value !== term) ctx.loadTerm?.(terms.value);
  });

  const shape = el("select");
  for (const option of SHAPES) {
    const node = el("option");
    node.value = option.value;
    node.textContent = option.label;
    node.title = option.title;
    shape.append(node);
  }
  shape.value = store.get().shape;
  shape.title = "What to aim for when choosing between weeks that both work.";
  shape.addEventListener("change", () => {
    const next = shape.value as Shape;
    localStorage.setItem(SHAPE, JSON.stringify(next));
    store.set({ shape: next });
  });

  const unpinAll = el("button", "export regenerate");
  unpinAll.type = "button";
  unpinAll.title = "Throws away every section you chose and takes the week the arranger makes.";
  unpinAll.addEventListener("click", () => {
    save(term, new Set());
    store.set({ pinned: new Set() });
  });

  controls.append(
    el("label", undefined, "term"),
    terms,
    el("label", undefined, "aim for"),
    shape,
    unpinAll,
  );

  const summary = el("p", "credits");
  const freshness = el("p", "muted seats-note");
  const head = el("div", "term-bar");
  const clashes = el("div");
  const gridBox = el("div");
  const body = el("div", "here");
  const week = el("div", "week");
  week.append(summary, freshness, clashes, gridBox);
  root.replaceChildren(controls, head, week, body);

  /** The term the list was last built from, so the grid can repaint alone. */
  let shown: Shown = termOf(store.get().moves, store.get().pinned, store.get().shape);
  /** The pins the current render was built against. */
  let pinnedNow: ReadonlySet<string> = store.get().pinned;
  /** Sections whose seat count came from Self-Service just now. */
  const liveIds = new Set<string>();
  /**
   * What each row says about itself once the week has been arranged again.
   *
   * Rebuilding the list on every choice was simpler and wrong: it closes
   * every accordion the student opened and replaces the radio under their
   * cursor. So the list is rebuilt only when the term's courses change, and
   * taking a section repaints these in place.
   */
  let repainters: (() => void)[] = [];

  // ---- the week -----------------------------------------------------------

  /** The arrangement, plus the sections of whatever course is being offered up. */
  const blocks = (showing: string | null): Block[] => {
    const held = chosenIn(shown);
    const clashing = new Set(
      held.flatMap((a, i) =>
        held.slice(i + 1).flatMap((b) => (conflictsBetween(a, b).length ? [a.id, b.id] : [])),
      ),
    );

    const out: Block[] = held.flatMap((offering) =>
      offering.meetings.map((meeting) => ({
        offering,
        meeting,
        kind: pinnedNow.has(offering.id) ? ("pinned" as const) : ("suggested" as const),
        clash: clashing.has(offering.id),
      })),
    );

    // A section id previews itself; a course code previews all of its
    // sections, which is how an accordion full of times becomes a picture.
    const ghosts = showing
      ? byId.has(showing)
        ? [byId.get(showing)!]
        : (byCourse.get(baseCode(showing)) ?? [])
      : [];
    for (const offering of ghosts) {
      if (held.some((o) => o.id === offering.id)) continue;
      for (const meeting of offering.meetings) {
        out.push({
          offering,
          meeting,
          kind: "ghost",
          // What it would cost: a clash with anything except the section of
          // its own course that it would be replacing.
          clash: held.some(
            (other) =>
              other.courseName !== offering.courseName &&
              conflictsBetween(offering, other).length > 0,
          ),
        });
      }
    }
    return out;
  };

  function paintWeek() {
    gridBox.replaceChildren(renderGrid(blocks(store.get().showing), { onToggle: toggle }));

    const held = chosenIn(shown);
    const found = held.flatMap((a, i) => held.slice(i + 1).flatMap((b) => conflictsBetween(a, b)));
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
      ...shown.arranged.unplaced.map((miss) => el("p", "clash", `${miss.code}: ${miss.why}`)),
    );
  }

  // ---- one line per course ------------------------------------------------

  /** When a section meets, in the fewest words that are still true. */
  const whenOf = (offering: Offering) =>
    offering.meetings.length
      ? offering.meetings
          .map(
            (m) =>
              `${m.days.map((d) => DAY_NAMES[d]).join("")} ` +
              `${formatTime(m.start)}–${formatTime(m.end)}`,
          )
          .join("; ")
      : "no set meeting time";

  const seatsOf = (offering: Offering) => {
    const seats = offering.seats;
    const live = liveIds.has(offering.id);
    const node = tag(
      `${seats.available}/${seats.capacity}`,
      `seats ${seats.available > 0 ? "open" : "full"}${live ? " live" : ""}`,
    );
    node.title = `${seats.available} of ${seats.capacity} seats open, ${
      live ? "live from Self-Service" : "from the cached catalog"
    }`;
    return node;
  };

  /**
   * One course, open to its sections.
   *
   * Closed, it says the one thing that matters: which section you are in and
   * when it meets. Open, it is a radio group — the first option hands the
   * choice back to the arranger, and hovering any of them draws it on the
   * week before it is taken.
   */
  function courseAccordion(row: Row, held: ReadonlySet<string>, inTerm: Set<string>): HTMLElement {
    const code = baseCode(row.code);
    const node = graph.courses.get(code);
    const card = el("details", "course");
    card.dataset.code = code;

    const line = el("summary", "course-head");
    line.append(el("b", "code", code));
    line.append(el("span", "title", planning.title(code) || row.offerings[0]?.title || ""));
    line.append(el("span", "cr", `${row.credits} cr`));

    const nth = Number(row.code.split("#")[1] ?? 1);
    if (nth > 1) {
      const again = tag(`sitting ${nth}`, "rule");
      again.title =
        "The same course again, because the requirement asks for more of it than one sitting " +
        "gives. Worth confirming with your advisor.";
      line.append(again);
    }

    /** The section the week holds, which is the only one worth spelling out. */
    const slotChip = el("span", "slot");
    const seatBox = el("span", "slot-seats");
    line.append(slotChip, seatBox);

    // A gate is only worth saying when it is shut. "Ready" on every line is
    // six lines of reassurance in place of the one thing that matters.
    const verdict = node
      ? eligibility(node, held, new Set([...inTerm, ...planning.running]), {
          exists: (c) => graph.courses.has(c),
        })
      : { state: "open" as const };
    if (verdict.state !== "open") {
      const gate = el(
        "span",
        `gate ${verdict.state}`,
        verdict.state === "blocked" ? `needs ${verdict.blockedBy.join(", ")}` : "check",
      );
      gate.title =
        verdict.state === "blocked"
          ? `${verdict.blockedBy.join(", ")} has to come first.`
          : verdict.why.join(" ") || "Has a condition we cannot check.";
      line.append(gate);
    }

    if (row.offerings.length === 0) {
      const none = tag(`not taught in ${term}`, "bad");
      none.title =
        "The plan wants this course this term and the timetable does not offer it. " +
        "Move it on the plan tab, or ask the department.";
      line.append(none);
    } else if (row.offerings.length > 1) {
      line.append(el("span", "count", `${row.offerings.length} sections`));
    }

    // Both buttons sit inside the summary, so both have to say that they are
    // not the thing that opens and closes it.
    if (store.get().moves[code] === slotName) {
      const back = el("button", "release");
      back.type = "button";
      back.textContent = "⤺";
      back.title = "Unpin it from this term and let the projection place it again.";
      back.addEventListener("click", (event) => {
        event.preventDefault();
        release(code);
      });
      line.append(back);
    }
    const out = el("button", "release");
    out.type = "button";
    out.textContent = "×";
    out.title = "Take this out of the plan and see what it was costing.";
    out.addEventListener("click", (event) => {
      event.preventDefault();
      place(code, OUT);
    });
    line.append(out);

    line.addEventListener("mouseenter", () => store.set({ showing: code }));
    line.addEventListener("mouseleave", () =>
      store.set((s) => (s.showing === code ? { showing: null } : {})),
    );
    card.append(line);

    // ---- the radio group
    const group = `section-${code}`;
    const options = el("div", "options");

    /** Hands the choice back, which is a choice in its own right. */
    const auto = el("label", "option auto");
    const autoBox = el("input");
    autoBox.type = "radio";
    autoBox.name = group;
    autoBox.addEventListener("change", () => {
      if (autoBox.checked) unpinCourse(code);
    });
    const autoSays = el("span", "when");
    auto.append(autoBox, autoSays);
    auto.title = "Let the arranger choose, and change its mind when something else moves.";
    if (row.offerings.length > 1) options.append(auto);

    for (const offering of row.offerings) {
      const option = el("label", "option");
      option.dataset.section = offering.id;
      const box = el("input");
      box.type = "radio";
      box.name = group;
      box.addEventListener("change", () => {
        if (box.checked) take(offering);
      });

      const mark = el("span", "mark");
      option.append(box, el("b", "num", offering.number), el("span", "when", whenOf(offering)));
      if (offering.meetings[0]?.room) option.append(el("span", "room", offering.meetings[0].room));
      if (offering.instructors.length)
        option.append(el("span", "who", offering.instructors.join(", ")));
      option.append(mark, seatsOf(offering));
      if (offering.nonStandardDates) option.append(tag("partial term", "rule"));

      // Hovering an option is the whole reason the week is next to the list.
      option.addEventListener("mouseenter", () => store.set({ showing: offering.id }));
      option.addEventListener("mouseleave", () =>
        store.set((s) => (s.showing === offering.id ? { showing: code } : {})),
      );
      options.append(option);

      repainters.push(() => {
        const mine = pinnedNow.has(offering.id);
        const inWeek = shown.arranged.chosen.get(offering.courseName)?.id === offering.id;
        box.checked = mine;
        option.classList.toggle("mine", mine);
        option.classList.toggle("in", inWeek && !mine);
        mark.textContent = mine ? "yours" : inWeek ? "chosen for you" : "";
        // What taking this one would cost, said before it is taken.
        const against = chosenIn(shown).filter(
          (other) =>
            other.courseName !== offering.courseName &&
            conflictsBetween(offering, other).length > 0,
        );
        option.classList.toggle("clashes", against.length > 0);
        option.title = against.length
          ? `Overlaps ${against.map((o) => o.courseName).join(" and ")}.`
          : "";
      });
    }
    card.append(options);

    repainters.push(() => {
      const chosen = shown.arranged.chosen.get(code);
      const mine = Boolean(chosen && pinnedNow.has(chosen.id));
      autoBox.checked = !mine;
      autoSays.textContent = chosen
        ? `whichever fits best — ${chosen.number} today`
        : "whichever fits best";
      slotChip.textContent = chosen ? `${chosen.number} · ${whenOf(chosen)}` : "nowhere it fits";
      slotChip.className = `slot${mine ? " mine" : chosen ? "" : " none"}`;
      slotChip.title = chosen
        ? mine
          ? "The section you chose."
          : "The arranger's choice, which will move if something else does."
        : "No section of this course fits the rest of the week.";
      seatBox.replaceChildren(...(chosen ? [seatsOf(chosen)] : []));
      card.classList.toggle("mine", mine);
    });

    // Open where there is something to decide: a course with no section, one
    // that clashes, or one the student has already taken charge of.
    card.open =
      row.offerings.length === 0 ||
      shown.arranged.unplaced.some((u) => u.code === code) ||
      row.offerings.some((o) => store.get().pinned.has(o.id));

    return card;
  }

  // ---- the page -----------------------------------------------------------

  /** The numbers and the week, which change with every pin. */
  function settle() {
    const { pinned } = store.get();
    pinnedNow = pinned;
    unpinAll.hidden = pinned.size === 0;
    unpinAll.textContent = `start over (${pinned.size} chosen)`;

    const { rows, arranged } = shown;
    const credits = chosenIn(shown).reduce((n, o) => n + o.credits.min, 0);
    const teachable = rows.filter((r) => r.offerings.length > 0).length;
    // The credits here are the sections', which can differ from what the plan
    // priced the course at: a variable-credit course is registered for at a
    // number, and the term bar above says what the projection assumed.
    summary.textContent = rows.length
      ? `${arranged.chosen.size} of ${teachable} courses placed · ${credits} cr of sections · ` +
        `${arranged.days} day${arranged.days === 1 ? "" : "s"} a week` +
        (arranged.gapMinutes ? ` · ${Math.round(arranged.gapMinutes / 60)}h of gaps` : "")
      : "nothing planned for this term";

    for (const repaint of repainters) repaint();
    paintWeek();
  }

  /** The same courses, arranged again around a changed pin or aim. */
  function rearrange() {
    const { pinned, shape: aim } = store.get();
    shown = { ...shown, arranged: arrange(choicesOf(shown.rows), { pinned, shape: aim }) };
    settle();
  }

  /** The term itself changed: different courses, so a different list. */
  function paintList() {
    const { moves, pinned, shape: aim } = store.get();
    shown = termOf(moves, pinned, aim);
    repainters = [];

    const { planned, rows } = shown;
    const inTerm = new Set(rows.map((r) => baseCode(r.code)));

    head.replaceChildren();
    head.append(el("h2", undefined, slot ? `${slotName} · ${term}` : term));
    const scheduled = planned?.credits ?? 0;
    if (slot) {
      const meter = el("span", "cr", `${scheduled} / ${slot.capacity} cr planned`);
      meter.title =
        `The plan puts ${scheduled} credits in this term, against the ${slot.capacity} ` +
        "your chosen load allows.";
      head.append(meter);
    } else {
      const aside = tag("not in your plan", "rule");
      aside.title =
        `${slotName} is either under way or past the horizon this plan projects, so there is ` +
        "no generated term to lay out. Pick a later term, or change the load on the plan tab.";
      head.append(aside);
    }

    /*
     * When this timetable was read.
     *
     * Everything on this screen is only as true as the crawl behind it, and
     * nothing else on the page says when that was: a section cancelled this
     * morning still draws, and the only tell was a seat count the student had
     * no reason to distrust. Marked when it is past the day the shell waits
     * before re-crawling, so stale is visible rather than merely stated.
     */
    const stale = olderThan(TERM_HOURS, crawledAt);
    const age = tag(`read ${since(crawledAt)}`, stale ? "bad" : "rule");
    age.title =
      `${term} was crawled ${new Date(crawledAt).toLocaleString()}.` +
      (stale
        ? " Sections open and close through registration, so this is worth refreshing: press" +
          " load catalog above."
        : " Pressing load catalog re-crawls it whatever its age.");
    head.append(age);

    body.replaceChildren();
    // What gates the most, first: the same order the plan itself takes them in.
    const ordered = [...rows].sort(
      (a, b) =>
        downstream(graph, baseCode(b.code)).size - downstream(graph, baseCode(a.code)).size ||
        baseCode(a.code).localeCompare(baseCode(b.code)),
    );
    for (const row of ordered) body.append(courseAccordion(row, shown.held, inTerm));

    if (rows.length === 0) {
      body.append(
        el(
          "p",
          "muted",
          slot
            ? `the plan has nothing in ${slotName}. add a course to it on the plan tab, or pick ` +
                "another term above."
            : `${term} is not a term this plan reaches. pick a later one above.`,
        ),
      );
    } else {
      body.append(
        el(
          "p",
          "muted",
          "Open a course to choose between its sections, and hover one to see where it would " +
            "fall. Anything you choose is kept; the rest of the week arranges itself around it.",
        ),
      );
    }

    settle();
  }

  subs.add(
    // Two levels, because they cost different amounts and happen at different
    // rates: the plan changes rarely and rebuilds the list, a pin changes
    // constantly and only rearranges the week.
    store.watch(
      (s) => `${JSON.stringify(s.moves)}:${s.resolvedAt}`,
      () => paintList(),
    ),
    store.watch(
      (s) => `${[...s.pinned].sort().join(",")}:${s.shape}:${s.seatsAt}`,
      () => rearrange(),
    ),
    // The ghost follows the pointer, which must not rebuild the list: moving
    // between two options would replace the row under the cursor.
    store.watch(
      (s) => s.showing,
      () => paintWeek(),
    ),
    store.watch(
      (s) => (s.loadingSeats ? -1 : s.liveSeats),
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

  // Only the courses the degree still needs. Asking for the whole catalog
  // would be a two-thousand-id query answering a question about five courses.
  const watching = new Set<string>();
  for (const code of projection.need) {
    for (const o of byCourse.get(baseCode(code)) ?? []) watching.add(o.courseId);
  }
  /*
   * Live availability is not decoration here: "prefer a section you can
   * actually get into" is only true if the arranger knows which those are. So
   * the counts are written onto this view's own offerings and the term is
   * arranged again.
   */
  void liveSeats(term, [...watching])
    .then((live) => {
      for (const [id, seats] of Object.entries(live)) {
        const offering = byId.get(id);
        if (!offering) continue;
        offering.seats = {
          ...offering.seats,
          available: seats.available,
          capacity: seats.capacity,
          status: seats.status,
        };
        liveIds.add(id);
      }
      store.set({ seatsAt: Date.now(), liveSeats: liveIds.size, loadingSeats: false });
    })
    .catch(() => store.set({ loadingSeats: false }));

  return {
    destroy() {
      subs.clear();
      root.replaceChildren();
    },
  };
}

// ---- the grid ------------------------------------------------------------

interface Block {
  offering: Offering;
  meeting: Meeting;
  /** The student's choice, the arranger's, or a section being hovered. */
  kind: "pinned" | "suggested" | "ghost";
  clash: boolean;
}

interface GridHandlers {
  /** A block in the week is the shortest way to change your mind about one. */
  onToggle(offering: Offering): void;
}

/**
 * A weekday grid with an hour gutter, positioned straight off the clock.
 *
 * Blocks that overlap sit side by side rather than on top of one another: two
 * classes at nine on a Monday is the single most important thing this view can
 * tell a student, and a stack hides it.
 */
function renderGrid(blocks: Block[], handlers: GridHandlers): HTMLElement {
  const table = el("div", "grid");

  const times = blocks.flatMap((b) => [b.meeting.start, b.meeting.end]);
  const from = Math.floor(Math.min(DAY_START, ...times) / 60) * 60;
  const to = Math.ceil(Math.max(DAY_END, ...times) / 60) * 60;
  const height = ((to - from) / 30) * ROW;
  const place = (minutes: number) => ((minutes - from) / 30) * ROW;

  const gutter = el("div", "gutter");
  for (let minute = from; minute <= to; minute += 60) {
    const mark = el("span", "hour", formatTime(minute));
    mark.style.top = `${place(minute)}px`;
    gutter.append(mark);
  }
  gutter.style.height = `${height + HEAD}px`;
  table.append(gutter);

  const used = new Set<Weekday>(WEEKDAYS);
  for (const block of blocks) for (const day of block.meeting.days) used.add(day);

  for (const day of [...used].sort((a, b) => a - b)) {
    const col = el("div", "day");
    col.append(el("h3", undefined, DAY_NAMES[day]));

    const today = blocks
      .filter((b) => b.meeting.days.includes(day))
      .sort((a, b) => a.meeting.start - b.meeting.start);

    // First lane whose last block has already ended, which is as much layout
    // as a week of five classes ever needs.
    const ends: number[] = [];
    const lanes = today.map((block) => {
      let lane = ends.findIndex((end) => end <= block.meeting.start);
      if (lane < 0) lane = ends.length;
      ends[lane] = block.meeting.end;
      return lane;
    });
    const across = Math.max(1, ends.length);

    today.forEach((item, at) => {
      const width = 100 / across;
      const node = el("div", `block ${item.kind}${item.clash ? " clash" : ""}`);
      node.dataset.section = item.offering.id;
      node.style.top = `${place(item.meeting.start) + HEAD}px`;
      node.style.height = `${Math.max(place(item.meeting.end) - place(item.meeting.start), 18)}px`;
      node.style.left = `${(lanes[at] ?? 0) * width}%`;
      node.style.width = `${width}%`;
      node.append(el("b", undefined, item.offering.courseName));
      node.append(
        el(
          "span",
          undefined,
          `${formatTime(item.meeting.start)} ${item.meeting.room || (item.meeting.online ? "online" : "")}`.trim(),
        ),
      );
      node.title =
        `${item.offering.courseName} ${item.offering.number} · ` +
        `${formatTime(item.meeting.start)}–${formatTime(item.meeting.end)}` +
        (item.offering.instructors.length ? ` · ${item.offering.instructors.join(", ")}` : "") +
        (item.kind === "ghost"
          ? item.clash
            ? " · taking it would cost something else its place"
            : " · click to take it"
          : item.kind === "pinned"
            ? " · yours; click to hand it back"
            : " · chosen for you; click to keep it");
      node.addEventListener("click", () => handlers.onToggle(item.offering));

      col.append(node);
    });

    col.style.height = `${height + HEAD}px`;
    table.append(col);
  }
  return table;
}
