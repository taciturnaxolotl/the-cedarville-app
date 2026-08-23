/*
 * The term-by-term projection.
 *
 * The other two views answer "what do I still owe" and "when does this meet".
 * This one answers "when do I finish", which is the question that actually
 * decides things — and the honest answer depends on two knobs the student
 * controls, so both are on screen: credits per term, and whether summers
 * count. Changing either reprojects immediately.
 *
 * And the plan is a draft, not a verdict. A generated term-by-term is the
 * start of the conversation a student has with their advisor, so this view
 * lets them argue with it: drag a course into another term, add one the
 * degree never asked for, drop one to see what it was costing. Every edit is
 * a pin the next projection arranges itself around, which is what makes
 * "regenerate" mean something — the moves stay, everything else reflows.
 */

import { termCodeOf } from "../../catalog";
import { prerequisitesOf } from "../../prereqs";
import { groupKey, type ProgramTree } from "../../requirements";
import { type Change, mark, type Sitting, describe as sayChange, syncPlan } from "../../sync";
import { applyPlan, colleaguePlan, installed } from "../bridge";
import type { Ctx } from "../ctx";
import { el, tag } from "../dom";
import { CEILING, FULL_TIME, type Load, readLoad, SUMMERS, verdictOf, writeLoad } from "../load";
import { type Edits, editsOf, type Moves, OUT, readMoves, writeMoves } from "../moves";
import { baseCode, planningFrom, read } from "../planning";
import { createStore, Subscriptions } from "../store";
import { mountGraph } from "./graph";

type Shape = "graph" | "list";

interface State {
  /** The same knobs the build view sets, so the two never disagree. */
  load: Load;
  /** Bumped when rule groups come back, to reproject with their courses. */
  resolvedAt: number;
  /**
   * Drawn or listed. One projection either way: the graph answers what is
   * holding up what, the list answers what you are taking in spring.
   */
  shape: Shape;
  /** The student's own edits to the generated plan. */
  moves: Moves;
}

const SHAPE = "cedarville:plan-shape";

export function mount(root: HTMLElement, ctx: Ctx) {
  const { trees } = ctx;
  const subs = new Subscriptions();

  // A projection needs the requirements and the course records, not a term's
  // section listing: seasons come from the catalog's own statement now, so
  // making a student load a timetable to see a graduation date was a leftover.
  if (trees.length === 0) {
    root.replaceChildren(el("p", "muted", "capture your requirements to project a plan."));
    return { destroy: () => root.replaceChildren() };
  }

  // One projection, assembled where every view can share it. This tab used to
  // build its own and quietly disagreed with the other two about the date.
  const planning = planningFrom(ctx);
  const { graph, have, title } = planning;

  // First pass names the groups the evaluation will not enumerate; the server
  // asks Colleague what qualifies; the second pass runs one cover over
  // everything, so a course bought for one requirement can pay for a
  // rule-based one too.
  /** A pool names what satisfies it, never what that costs to reach. */
  const closed = (courses: Set<string>) => {
    for (const code of [...courses]) {
      for (const p of prerequisitesOf(graph, code, have, courses)) courses.add(p);
    }
    return courses;
  };

  const first = planning.solve();
  let need = closed(first.courses);
  let unenumerable = first.unenumerable;
  /**
   * Requirements their own pool cannot close, which is nearly always a course
   * meant to be taken twice: "Honors Integrative Seminars (4 credit hours)"
   * draws on a pool whose seminar is worth two. Colleague can say that; a set
   * of course codes cannot, so the plan says it in words and offers the
   * second sitting as something to add.
   */
  let shortfalls = first.shortfalls;

  void planning.expandRules(first.unenumerable).then((resolved) => {
    if (resolved.size === 0) return;
    for (const u of first.unenumerable) {
      const pool = resolved.get(groupKey(u.ids));
      if (pool?.length) u.resolved = pool;
    }
    const second = planning.solve({ resolved });
    need = closed(second.courses);
    unenumerable = second.unenumerable;
    shortfalls = second.shortfalls;
    store.set({ resolvedAt: Date.now() });
  });

  const store = createStore<State>({
    load: readLoad(),
    resolvedAt: 0,
    shape: read<Shape>(SHAPE, "graph"),
    moves: readMoves(),
  });

  /**
   * What the plan schedules once the student has had their say.
   *
   * An inserted course brings its prerequisites with it — asking for a
   * capstone and being handed only the capstone would be a lie — and a
   * dropped one leaves even if something else's chain wants it back, because
   * a drop is a decision and the closure is only an inference.
   */
  const scheduled = ({ placements, dropped }: Edits) => {
    // A sitting the student added is only plannable once the graph can answer
    // for it, and the moves outlive the session that made them.
    for (const code of placements.keys()) {
      if (code.includes("#")) planning.sitting(code, Number(code.split("#")[1]));
    }
    const set = closed(new Set([...need, ...placements.keys()]));
    for (const code of dropped) set.delete(code);
    return set;
  };

  const projectWith = (moves: Moves, load: Load) => {
    const edits = editsOf(moves);
    return planning.project(scheduled(edits), load, edits.placements);
  };

  // ---- chrome ----------------------------------------------------------

  const set = (patch: Partial<Load>) => {
    const load = { ...store.get().load, ...patch };
    writeLoad(load);
    store.set({ load });
  };

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

  /** A slider that reports as it moves, and remembers where it was left. */
  function slider(
    label: string,
    value: number,
    range: { min: number; max: number; step: number },
    onChange: (n: number) => void,
  ) {
    const input = el("input");
    input.type = "range";
    input.min = String(range.min);
    input.max = String(range.max);
    input.step = String(range.step);
    input.value = String(value);
    input.addEventListener("input", () => onChange(Number(input.value)));
    return [el("label", undefined, label), input] as const;
  }

  const controls = el("div", "plan-controls");
  const perTermLabel = el("span", "cr");
  const summersLabel = el("span", "cr");

  const full = el("input");
  full.type = "checkbox";
  full.checked = store.get().load.fullSemesters;
  full.title =
    "Keeps every semester at twelve credits or more, holding work back from a summer and " +
    "moving courses between terms to do it. Better an even thirteen twice than sixteen " +
    "and then nine.";
  full.addEventListener("change", () => set({ fullSemesters: full.checked }));
  const fullLabel = el("label", "toggle");
  fullLabel.append(full, el("span", undefined, "keep semesters full"));

  const shape = el("button", "export");
  shape.type = "button";
  shape.title = "The same plan, drawn or listed.";
  shape.addEventListener("click", () => {
    const next: Shape = store.get().shape === "graph" ? "list" : "graph";
    localStorage.setItem(SHAPE, JSON.stringify(next));
    store.set({ shape: next });
  });

  const regenerate = el("button", "export regenerate");
  regenerate.type = "button";
  regenerate.title = "Throws away every move and takes the plan the projection would make.";
  regenerate.addEventListener("click", () => {
    writeMoves({});
    store.set({ moves: {} });
  });

  const push = el("button", "export");
  push.type = "button";
  push.textContent = "send to Colleague";
  push.title =
    "Shows what this would change on your real degree plan, and writes nothing until you say so. " +
    "Your advisor sees that plan.";
  push.addEventListener("click", () => void preview());

  controls.append(
    ...slider(
      "credits per term",
      store.get().load.perTerm,
      { min: FULL_TIME, max: CEILING, step: 0.5 },
      (perTerm) => set({ perTerm }),
    ),
    perTermLabel,
    ...slider("summers", store.get().load.summers, { min: 0, max: SUMMERS, step: 1 }, (summers) =>
      set({ summers }),
    ),
    summersLabel,
    fullLabel,
    shape,
    regenerate,
    ...(installed() ? [push] : []),
  );

  const verdict = el("p", "credits");
  const panel = el("div", "sync");
  const body = el("div");
  root.replaceChildren(controls, verdict, panel, body);

  /** The graph rendering, when it is the one on screen. */
  let picture: { destroy(): void } | null = null;

  // ---- sending it to Colleague -----------------------------------------

  /*
   * The only thing this application writes anywhere. Everything above reads a
   * registrar's data and reasons about it; this puts the answer back where an
   * advisor will see it, so it happens on purpose, once, after being shown in
   * full — and it keeps a note of what it wrote so a later run can take its
   * own work back without touching anybody else's.
   */
  const PUSHED = "cedarville:pushed";

  /** The projection as course ids and term codes, one entry per sitting. */
  function sittings(): { wanted: Sitting[]; unknown: string[] } {
    const { load, moves } = store.get();
    const plan = projectWith(moves, load);
    const wanted: Sitting[] = [];
    const unknown: string[] = [];
    for (const term of plan.terms) {
      for (const course of term.courses) {
        const id = planning.courseId(course.code);
        // A course no catalog we hold lists cannot be named to Colleague.
        if (!id) {
          unknown.push(baseCode(course.code));
          continue;
        }
        wanted.push({
          code: baseCode(course.code),
          courseId: id,
          termId: termCodeOf(term.slot),
          credits: course.credits,
        });
      }
    }
    return { wanted, unknown };
  }

  const line = (text: string, kind = "muted") => el("p", kind, text);

  async function preview() {
    panel.replaceChildren(line("reading your plan in Colleague…"));
    let theirs: Awaited<ReturnType<typeof colleaguePlan>>;
    try {
      theirs = await colleaguePlan();
    } catch (err) {
      // One sentence, and only the remedy that fits. Stacking a generic
      // "sign in and try again" under every failure taught a student to read
      // neither line.
      const why = err instanceof Error ? err.message : String(err);
      panel.replaceChildren(el("h3", undefined, "could not read your plan"), line(why, "why"));
      if (/sign|session|unauthor/i.test(why)) {
        panel.append(line("open Self-Service in another tab and sign in, then try again."));
      }
      return;
    }

    if (theirs.locked) {
      panel.replaceChildren(line("your degree plan is protected; an advisor has to unlock it."));
      return;
    }

    const { wanted, unknown } = sittings();
    const { changes, skipped } = syncPlan({
      wanted,
      planned: theirs.planned,
      terms: theirs.terms,
      addable: theirs.addable,
      ours: new Set(read<string[]>(PUSHED, [])),
    });

    panel.replaceChildren();
    const head = el("h3", undefined, changes.length ? "this would change" : "nothing to change");
    panel.append(head);

    for (const change of changes) panel.append(el("div", "sync-change", sayChange(change)));
    for (const miss of skipped) {
      panel.append(el("div", "sync-change muted", `${miss.code ?? ""} — ${miss.why}`.trim()));
    }
    for (const code of unknown) {
      panel.append(
        el("div", "sync-change muted", `${code} — no catalog record, so it is left out`),
      );
    }

    if (!changes.length) {
      panel.append(line("Colleague already agrees with this plan."));
      return;
    }

    const go = el("button", "export");
    go.type = "button";
    go.textContent = `send ${changes.length} change${changes.length === 1 ? "" : "s"}`;
    go.addEventListener("click", () => void commit(changes));

    const cancel = el("button", "export");
    cancel.type = "button";
    cancel.textContent = "cancel";
    cancel.addEventListener("click", () => panel.replaceChildren());

    const row = el("div", "sync-actions");
    row.append(go, cancel);
    panel.append(row);
  }

  /**
   * Writes the changes, one at a time, saying where it has got to.
   *
   * One at a time because thirty round trips is long enough that a student
   * needs to see it moving, and a single call across the bridge can only
   * answer once. The extension keeps the plan Colleague handed back between
   * them, which is what the next write has to carry.
   */
  async function commit(changes: Change[]) {
    const bar = el("progress");
    bar.max = changes.length;
    bar.value = 0;
    const doing = el("p", "muted");
    panel.replaceChildren(el("h3", undefined, "writing to your degree plan"), bar, doing);

    const done: Change[] = [];
    let stopped: { change: Change; why: string } | null = null;

    for (const change of changes) {
      doing.textContent = `${done.length + 1} of ${changes.length} · ${sayChange(change)}`;
      try {
        const result = await applyPlan([change]);
        done.push(...result.applied);
        if (result.stopped) {
          stopped = result.stopped;
          break;
        }
      } catch (err) {
        stopped = { change, why: err instanceof Error ? err.message : String(err) };
        break;
      }
      bar.value = done.length;
    }

    await settle(changes, done, stopped);
  }

  /**
   * Says what happened, having gone and looked.
   *
   * Counting the calls that came back is not the same as counting what
   * landed: a write that succeeded and then failed to be *read* reported
   * itself as nothing written while the course sat on the plan. So the report,
   * and the ledger under it, come from Colleague's own answer afterwards
   * rather than from what this end believes it did.
   */
  async function settle(
    changes: Change[],
    done: Change[],
    stopped: { change: Change; why: string } | null,
  ) {
    const wanted = new Set(
      changes.flatMap((c) =>
        c.kind === "add"
          ? [mark(c.courseId, c.termId)]
          : c.kind === "move"
            ? [mark(c.courseId, c.to)]
            : [],
      ),
    );

    let landed = new Set<string>();
    try {
      const theirs = await colleaguePlan();
      landed = new Set(theirs.planned.map((c) => mark(c.courseId, c.termId)));
    } catch {
      /* Cannot check, so the count below falls back to what the calls said. */
    }

    const confirmed = [...wanted].filter((entry) => landed.has(entry));
    const pushed = new Set(read<string[]>(PUSHED, []));
    for (const entry of confirmed) pushed.add(entry);
    for (const change of done) {
      if (change.kind === "remove") pushed.delete(mark(change.courseId, change.termId));
      if (change.kind === "move") pushed.delete(mark(change.courseId, change.from));
    }
    localStorage.setItem(PUSHED, JSON.stringify([...pushed]));

    const count = landed.size ? confirmed.length : done.length;
    panel.replaceChildren(el("h3", undefined, `${count} of ${changes.length} on your degree plan`));
    if (stopped) {
      panel.append(line(`stopped at "${sayChange(stopped.change)}" — ${stopped.why}`, "why"));
      panel.append(line("nothing after that was tried."));
      const again = el("button", "export");
      again.type = "button";
      again.textContent = "work out what is left";
      again.addEventListener("click", () => void preview());
      const row = el("div", "sync-actions");
      row.append(again);
      panel.append(row);
    }
  }

  // ---- dragging --------------------------------------------------------

  /*
   * A drag is the one piece of state that must not go through the store:
   * re-rendering mid-drag replaces the node being dragged, and the browser
   * cancels the drag with it. So the hints are painted onto the boxes the
   * last render left behind, and wiped when the drag ends.
   */
  const boxes = new Map<string, HTMLElement>();
  /** Where each term says what taking this course would do to it. */
  const notes = new Map<string, HTMLElement>();
  let dragging: string | null = null;

  /**
   * What moving this course into each term would do, tried rather than
   * reasoned about: the projection is the only authority on whether a term
   * works, so ask it. Twelve greedy passes, which is the same price the build
   * view already pays to put a number on a single choice.
   */
  function hint(code: string) {
    const { moves, load } = store.get();
    const now = projectWith(moves, load);
    for (const [name, box] of boxes) {
      const trial = projectWith({ ...moves, [code]: name }, load);
      const term = trial.terms.find((t) => t.slot.name === name);
      const landed = term?.courses.find((c) => c.code === code);
      const missed = trial.unscheduled.find((u) => u.code === code);

      // Three things the student is weighing, in the order they matter: does
      // it work, what does the term become, and what does the degree become.
      // A native tooltip would say it better and never appears during a drag,
      // so it is written into the term itself.
      const wrong = landed?.conflicts ?? (missed ? [missed.why] : []);
      const later =
        trial.finishes === now.finishes
          ? "same finish"
          : `finishes ${trial.finishes ?? "past the horizon"}`;
      const said = wrong.length ? wrong.join(", and ") : `${term?.credits ?? 0} cr · ${later}`;

      box.classList.add(wrong.length ? "drop-bad" : "drop-ok");
      box.title = wrong.length ? `${code} ${said}.` : `${code} here: ${said}.`;
      const note = notes.get(name);
      if (note) note.textContent = said;
    }
  }

  const unhint = () => {
    dragging = null;
    for (const box of boxes.values()) {
      box.classList.remove("drop-ok", "drop-bad", "over");
      box.removeAttribute("title");
    }
    for (const note of notes.values()) note.textContent = "";
  };

  /** Every course code the catalog knows, offered to the term that asks. */
  let catalogue: HTMLDataListElement | null = null;
  const options = () => {
    if (catalogue) return catalogue;
    catalogue = el("datalist");
    catalogue.id = "cedarville-courses";
    for (const record of planning.records) {
      const code = `${record.SubjectCode}-${record.Number}`;
      const option = el("option");
      option.value = code;
      option.label = record.Title ?? "";
      catalogue.append(option);
    }
    root.append(catalogue);
    return catalogue;
  };

  /** The one control that adds work rather than rearranging it. */
  function adder(name: string) {
    const add = el("button", "add");
    add.type = "button";
    add.textContent = "+";
    add.title = `Add a course to ${name}.`;

    const input = el("input", "add-course");
    input.type = "text";
    input.placeholder = "CS-1210";
    input.hidden = true;
    input.setAttribute("list", options().id);

    const take = () => {
      const asked = baseCode(input.value.trim().toUpperCase());
      // Adding a course nothing in the catalog lists would plan a ghost.
      if (!graph.courses.has(asked)) {
        input.hidden = true;
        return;
      }
      // Asking for a course the plan already holds means another sitting of
      // it, which is the only way to say "two Honors Seminars" in a language
      // whose nouns are course codes.
      const { moves } = store.get();
      const held = scheduled(editsOf(moves));
      let nth = 1;
      while (held.has(planning.sitting(asked, nth))) nth++;
      place(planning.sitting(asked, nth), name);
    };

    add.addEventListener("click", () => {
      input.hidden = !input.hidden;
      if (!input.hidden) input.focus();
    });
    input.addEventListener("change", take);
    input.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key === "Enter") take();
      if ((event as KeyboardEvent).key === "Escape") input.hidden = true;
    });
    return [add, input] as const;
  }

  /** A course as it sits in a term, with the two ways to change its mind. */
  function row(code: string, extras: { moved?: boolean; caution?: string; conflicts?: string[] }) {
    const line = el("div", `plan-course${extras.moved ? " moved" : ""}`);
    line.draggable = true;
    line.dataset.code = code;
    line.addEventListener("dragstart", (event) => {
      dragging = code;
      (event as DragEvent).dataTransfer?.setData("text/plain", code);
      hint(code);
    });
    line.addEventListener("dragend", unhint);

    line.append(el("b", undefined, baseCode(code)));
    line.append(el("span", undefined, title(code)));
    const nth = Number(code.split("#")[1] ?? 1);
    if (nth > 1) {
      const again = tag(`sitting ${nth}`, "rule");
      again.title =
        "The same course again, because the requirement asks for more of it than one sitting " +
        "gives: the honours seminars are four credits of a two-credit seminar, taken twice on " +
        "different topics. Worth confirming with your advisor.";
      line.append(again);
    }

    if (extras.conflicts) {
      const flag = tag("clashes", "bad");
      flag.title = `Moved here, but it ${extras.conflicts.join(", and ")}.`;
      line.append(flag);
    }
    if (extras.caution) {
      const flag = tag("verify", "rule");
      flag.title = extras.caution;
      line.append(flag);
    }

    if (extras.moved) {
      const back = el("button", "release");
      back.type = "button";
      back.textContent = "⤺";
      back.title = "Let the projection place this one again.";
      back.addEventListener("click", () => release(code));
      line.append(back);
    }

    const out = el("button", "release");
    out.type = "button";
    out.textContent = "×";
    out.title = "Take this out of the plan and see what it was costing.";
    out.addEventListener("click", () => place(code, OUT));
    line.append(out);

    return line;
  }

  subs.add(
    store.watch(
      (s) => `${JSON.stringify(s.load)}:${s.resolvedAt}:${s.shape}:${JSON.stringify(s.moves)}`,
      () => {
        const { load, moves, shape: drawn } = store.get();
        const edits = editsOf(moves);
        const count = Object.keys(moves).length;

        shape.textContent = drawn === "graph" ? "list it" : "draw it";
        perTermLabel.textContent = `${load.perTerm}`;
        perTermLabel.title = verdictOf(load.perTerm).text;
        summersLabel.textContent = load.summers === 0 ? "none" : `${load.summers}`;
        regenerate.hidden = count === 0;
        regenerate.textContent = `regenerate (${count} move${count === 1 ? "" : "s"})`;

        const plan = projectWith(moves, load);

        // Two majors on one bachelor's share a single credit total, so the
        // requirement is the largest of them and never their sum. Earned
        // credit reads the same way: an evaluation counts only what its own
        // requirements consumed.
        const largest = (pick: (t: ProgramTree) => number) => Math.max(...trees.map(pick));
        const toGo =
          largest((t) => t.credits.minimum) -
          largest((t) => t.credits.completed) -
          largest((t) => t.credits.inProgress);
        verdict.textContent =
          `${trees.map((t) => t.code).join(" + ")}: ${toGo} credits left · ` +
          `finishes ${plan.finishes ?? "beyond the horizon"} · ${plan.terms.length} terms`;

        picture?.destroy();
        picture = null;
        boxes.clear();
        notes.clear();
        dragging = null;
        body.replaceChildren();

        if (drawn === "graph") {
          // The picture is the tab's own default, so the moves have to work
          // there too: a feature that only exists after you find a button is
          // a feature most people never find.
          picture = mountGraph(body, plan, planning, { onMove: place, onRelease: release });
          return;
        }

        if (plan.totalCredits > toGo) {
          body.append(
            el(
              "p",
              "muted",
              `Schedules ${plan.totalCredits} credits against a ${toGo}-credit gap, so the date is an ` +
                `upper bound: requirement pools overlap and one course often fills two slots.`,
            ),
          );
        }

        // Every slot up to one past the last with work in it, so there is
        // always a term ahead to drag something into — and so an empty term
        // in the middle stays visible rather than closing the gap silently.
        const placed = new Map(plan.terms.map((t) => [t.slot.name, t]));
        const slots = planning.slots(load);
        let last = -1;
        slots.forEach((s, at) => {
          if (placed.has(s.name)) last = at;
        });

        for (const slot of slots.slice(0, last + 2)) {
          const term = placed.get(slot.name);
          const credits = term?.credits ?? 0;
          const box = el("div", `term ${slot.season}${term ? "" : " empty"}`);
          box.dataset.slot = slot.name;
          boxes.set(slot.name, box);

          const head = el("h3");
          head.append(document.createTextNode(slot.name));
          // Against the cap rather than alone: a term is read by how much
          // room is left in it, and that is the number a drag is deciding.
          const meter = el("span", "cr", `${credits} / ${slot.capacity} cr`);
          meter.title = `${credits} credits scheduled of the ${slot.capacity} this term allows${
            slot.minimum ? `, and ${slot.minimum} is full time` : ""
          }.`;
          head.append(meter);
          const note = el("span", "note");
          notes.set(slot.name, note);
          head.append(note);
          if (credits > slot.capacity) {
            const over = tag("over cap", "bad");
            over.title = `${credits} credits against a ${slot.capacity}-credit cap.`;
            head.append(over);
          } else if (term?.short) {
            const light = tag("part time", "cheap");
            light.title = `Under ${slot.minimum} credits, which is full time here.`;
            head.append(light);
          }
          head.append(...adder(slot.name));
          box.append(head);

          for (const c of term?.courses ?? []) {
            box.append(
              row(c.code, {
                ...(c.moved ? { moved: true } : {}),
                ...(c.caution ? { caution: c.caution } : {}),
                ...(c.conflicts ? { conflicts: c.conflicts } : {}),
              }),
            );
            // A move that breaks something says so where it broke it. This is
            // the one thing on the plan the student has to act on, and a
            // hover tooltip is no place to keep it.
            if (c.conflicts) {
              box.append(el("div", "plan-course why", `↳ ${c.conflicts.join(", and ")}`));
            }
          }

          box.addEventListener("dragover", (event) => {
            if (!dragging) return;
            event.preventDefault();
            box.classList.add("over");
          });
          box.addEventListener("dragleave", () => box.classList.remove("over"));
          box.addEventListener("drop", (event) => {
            event.preventDefault();
            const code = dragging ?? (event as DragEvent).dataTransfer?.getData("text/plain");
            unhint();
            if (code) place(code, slot.name);
          });

          body.append(box);
        }

        // A pool that cannot close its own requirement is a hole in the date
        // above, so the plan owns up to it here rather than only in the build
        // tab — and says what to do about it, since the student can now do it.
        if (shortfalls.length) {
          const box = el("div", "term unenumerable");
          box.append(el("h3", undefined, "not closed by its own list"));
          for (const short of shortfalls) {
            const held = short.pool.filter((c) =>
              plan.terms.some((t) => t.courses.some((c2) => baseCode(c2.code) === c)),
            );
            box.append(
              el(
                "p",
                "muted",
                `${short.text}: ${short.pool.join(", ")} add up to ${short.wanted - short.short} ` +
                  `of the ${short.wanted} credits it asks for, and nothing here says what closes ` +
                  `the rest. Often it is one of them taken again — add ${held[0] ?? short.pool[0]} ` +
                  "to a term with + to plan a second sitting — but ask your advisor first.",
              ),
            );
          }
          body.append(box);
        }

        if (edits.dropped.size) {
          const box = el("div", "term dropped");
          box.append(el("h3", undefined, "dropped"));
          box.append(
            el("p", "muted", "Out of the plan by your hand. The date above is without them."),
          );
          for (const code of edits.dropped) {
            const line = el("div", "plan-course muted");
            line.append(el("b", undefined, code));
            line.append(el("span", undefined, title(code)));
            const back = el("button", "release");
            back.type = "button";
            back.textContent = "⤺";
            back.title = "Put it back and reproject.";
            back.addEventListener("click", () => release(code));
            line.append(back);
            box.append(line);
          }
          body.append(box);
        }

        if (plan.unscheduled.length) {
          const box = el("div", "term unplaced");
          box.append(el("h3", undefined, "not placed"));
          for (const u of plan.unscheduled) {
            box.append(el("div", "plan-course muted", `${u.code} — ${u.why}`));
          }
          body.append(box);
        }

        if (unenumerable.length) {
          const box = el("div", "term unenumerable");
          const pending = unenumerable.filter((u) => !u.bucket && !u.resolved?.length);
          if (pending.length) {
            box.append(el("h3", undefined, "not plannable"));
            box.append(
              el("p", "muted", "Colleague did not expand these; ask your advisor what qualifies."),
            );
            for (const u of pending) {
              box.append(
                el("div", "plan-course muted", `${u.credits ? `${u.credits}cr  ` : ""}${u.text}`),
              );
            }
            body.append(box);
          }
        }

        body.append(
          el(
            "p",
            "muted",
            "Drag a course into another term to pin it there, and the rest of the plan will " +
              "arrange itself around it. Spring terms are modelled rather than read: Colleague " +
              "publishes a term or two ahead, so a course is placed on the season the catalog " +
              "states for it.",
          ),
        );
      },
    ),
  );

  return {
    destroy() {
      picture?.destroy();
      subs.clear();
      root.replaceChildren();
    },
  };
}
