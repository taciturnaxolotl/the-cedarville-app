/*
 * Building a degree out of majors and minors.
 *
 * The other views answer questions about a program you are already in. This
 * one answers the question that comes first: given these majors and minors,
 * what is left to decide, and what does each decision cost?
 *
 * Two things make that answerable. Every selected program is solved against a
 * single cover, so a course bought for one counts for the rest — which is the
 * whole reason to double major and the thing a degree audit will never tell
 * you. And every course in every remaining pool is priced by re-solving the
 * plan with it pinned, so "one laboratory science, forty-one options" becomes
 * an ordered list where the top entry is usually free.
 */

import { type Candidate, type RankedChoice, rankChoices } from "../../choices";
import { type Season, termsFrom } from "../../planner";
import { buildGraph, type CourseNode, parseRequisite } from "../../prereqs";
import {
  completedCourses,
  groupKey,
  inProgressCourses,
  type ProgramTree,
} from "../../requirements";
import { offeringsFromListing } from "../../schedule";
import type { ProgramSummary } from "../../types";
import { capture, installed, programs, resolveRules } from "../bridge";
import type { Ctx } from "../ctx";
import { el, tag } from "../dom";
import { createStore, Subscriptions } from "../store";

interface State {
  /** Program codes the student wants, beyond the ones they are enrolled in. */
  wanted: string[];
  /** Courses chosen from a pool, which the solver then treats as bought. */
  pinned: string[];
  /**
   * Tracks and concentrations the student has settled on, keyed by branch.
   * A key absent means "whichever is cheapest", which is the right default
   * and a wrong thing to decide without saying so.
   */
  tracks: Record<string, string>;
  available: ProgramSummary[];
  /** Rule pools once the server has asked Colleague what qualifies. */
  resolved: Map<string, string[]>;
  busy: string;
}

const PINS = "cedarville:pins";
const TRACKS = "cedarville:tracks";

/**
 * What a program is, in the student's words.
 *
 * Colleague lists the majors and minors an enrolment covers separately from
 * its code, and the code alone hides them: a student with an honors minor
 * sees only "BS.CYOPR" and reasonably asks where their minor went. Falls back
 * to the code for programs that name nothing.
 */
function namesOf(tree: ProgramTree): string[] {
  const named = [...tree.majors, ...tree.minors];
  return named.length ? named : [tree.title || tree.code];
}

/**
 * Colleague's requirement text, minus what the interface already shows.
 *
 * "Technical electives selected from the following (6 credit hours):" is
 * written to sit above a printed list, so it ends in a colon that leads
 * nowhere here, and states a credit count shown beside it anyway.
 */
function tidy(text: string): string {
  return (
    text
      // The count is often buried in a longer aside — "(3 credit hours
      // selected from the list of courses identified in the catalog)" — so the
      // whole parenthetical goes once it opens with a credit count.
      .replace(/\s*\(\s*\d+(?:\.\d+)?\s*credit hours?\b[^)]*\)\s*/gi, " ")
      .replace(/\s*selected from the following\b/gi, "")
      .replace(/\s+/g, " ")
      .replace(/[\s:.]+$/, "")
      .trim()
  );
}

/** "+2 terms" reads better than a bare number, and null is not a number. */
function priceOf(candidate: Candidate): { text: string; kind: string; why: string } {
  if (candidate.forced) {
    return {
      text: "already required",
      kind: "free",
      why: "another part of your degree requires this outright, so it costs nothing here",
    };
  }
  if (candidate.chosen) {
    return {
      text: "cheapest",
      kind: "free",
      why: "nothing forces this, but it is the cheapest way to close this requirement",
    };
  }
  if (candidate.addedTerms === null) {
    return {
      text: "won't schedule",
      kind: "bad",
      why:
        "no term fits this course or its prerequisites, or taking it pushes " +
        "something else past the end of the plan",
    };
  }
  if (candidate.addedTerms === 0) {
    return candidate.addedCredits === 0
      ? { text: "free", kind: "free", why: "it fits in credits you are already spending" }
      : {
          text: `+${candidate.addedCredits} cr`,
          kind: "cheap",
          why: "extra credits, but the finish term does not move",
        };
  }
  const terms = `+${candidate.addedTerms} term${candidate.addedTerms === 1 ? "" : "s"}`;
  return {
    text: `${terms}, +${candidate.addedCredits} cr`,
    kind: "bad",
    why: "choosing this pushes your finish date out",
  };
}

export function mount(root: HTMLElement, ctx: Ctx) {
  const subs = new Subscriptions();
  const { trees, sections: catalog } = ctx;

  // A program evaluated but not enrolled in is a what-if the student added.
  // Seeding the picker with them is what lets the same control take one away.
  const enrolled = new Set(ctx.enrolled ?? trees.map((t) => t.code));
  const added = trees.map((t) => t.code).filter((code) => !enrolled.has(code));

  const store = createStore<State>({
    wanted: added,
    pinned: JSON.parse(localStorage.getItem(PINS) ?? "[]"),
    tracks: JSON.parse(localStorage.getItem(TRACKS) ?? "{}"),
    available: [],
    resolved: new Map(),
    busy: "",
  });

  // ---- what we know about courses --------------------------------------

  const records = ctx.allCourses?.length ? ctx.allCourses : (catalog?.courses ?? []);
  const credits = new Map(
    records.map((c) => [`${c.SubjectCode}-${c.Number}`, c.MinimumCredits ?? 0]),
  );
  const titles = new Map(records.map((c) => [`${c.SubjectCode}-${c.Number}`, c.Title]));
  const graph = buildGraph(
    records.map(
      (c) =>
        ({
          code: `${c.SubjectCode}-${c.Number}`,
          title: c.Title,
          requisites: (c.CourseRequisites ?? []).map(parseRequisite),
        }) as CourseNode,
    ),
  );

  const seen = new Set(offeringsFromListing(catalog?.sections ?? []).map((o) => o.courseName));
  const thisSeason: Season = (catalog?.term ?? "").includes("SU")
    ? "summer"
    : (catalog?.term ?? "").includes("SP")
      ? "spring"
      : "fall";
  const offeredIn = (code: string, season: Season) =>
    !seen.size || season !== thisSeason || seen.has(code);

  // ---- layout ----------------------------------------------------------

  const picker = el("section", "picker");
  const summary = el("p", "credits");
  const body = el("div");
  root.replaceChildren(picker, summary, body);

  if (trees.length === 0) {
    summary.textContent = "capture your requirements first, then add majors and minors here.";
    return { destroy: () => root.replaceChildren() };
  }

  const have = new Set([
    ...completedCourses(trees[0] as ProgramTree),
    ...inProgressCourses(trees[0] as ProgramTree),
  ]);
  const price = (c: string) => credits.get(c) ?? 3;

  // ---- fetching --------------------------------------------------------

  // `programs` throws synchronously when the extension is absent, which a
  // `.catch` would not see — and an uncaught throw here blanks the page. The
  // ranking needs no extension at all, so this is genuinely optional.
  if (installed()) {
    void programs()
      .then((list) => store.set({ available: list.filter((p) => p.IsActive) }))
      .catch(() => {
        /* Signed out: the picker stays empty, the ranking still works. */
      });
  }

  /** Ask the server to expand the rule groups, then re-rank with their pools. */
  function expandRules(current: ProgramTree[]) {
    const ranking = rank(current, new Map());
    const ids = ranking.unenumerable.filter((u) => !u.bucket).map((u) => u.ids);
    if (!ids.length) return;
    void resolveRules(ids)
      .then((answers) => {
        const resolved = new Map<string, string[]>();
        for (const key of Object.keys(answers)) {
          const pool = answers[key]?.filter((c) => !have.has(c));
          if (pool?.length) resolved.set(key, pool);
        }
        if (resolved.size) store.set({ resolved });
      })
      .catch(() => {
        /* Leave the group listed as unresolved rather than guessing. */
      });
  }

  const rank = (current: ProgramTree[], resolved: Map<string, string[]>) =>
    rankChoices(current, {
      credits: price,
      have,
      resolved,
      pinned: new Set(store.get().pinned),
      tracks: new Map(Object.entries(store.get().tracks).map(([k, v]) => [k, [v]])),
      graph,
      offeredIn,
      slots: termsFrom({ year: 2027, season: "spring" }, 12, { capacity: 15 }),
    });

  expandRules(trees);

  // ---- the program picker ----------------------------------------------

  /** Re-evaluate against a set of what-if programs. An empty list is valid. */
  async function evaluate(codes: string[]) {
    store.set({ wanted: codes, busy: "evaluating…" });
    try {
      ctx.adopt?.(await capture(codes));
    } catch {
      store.set({ busy: "" });
    }
  }

  subs.add(
    store.watch(
      (s) => `${s.available.length}:${s.wanted.join(",")}:${s.busy}`,
      () => {
        const { available, wanted, busy } = store.get();
        picker.replaceChildren();
        picker.append(el("h2", undefined, "majors and minors"));

        // One label per kind, then bare codes. Repeating a word on every chip
        // says it as many times as you have programs.
        const chips = el("div", "chips");
        const mine = trees.filter((t) => enrolled.has(t.code));
        const theirs = trees.filter((t) => !enrolled.has(t.code));
        if (mine.length) {
          chips.append(el("span", "muted", "enrolled"));
          // One enrolment covers several credentials: BS.CYOPR is a cyber
          // operations major and the honors program, and the code says
          // neither. Showing what Colleague named is what makes a student
          // recognise their own degree.
          for (const t of mine) {
            for (const name of namesOf(t)) chips.append(tag(name, "on"));
          }
        }
        if (theirs.length) {
          chips.append(el("span", "muted", "trying"));
          for (const t of theirs) {
            // Removable in place. Hunting for the row in a multi-select and
            // ctrl-clicking it is not a way to undo something.
            const chip = el("span", "tag trying", namesOf(t).join(" + "));
            const drop = el("button", "drop", "×");
            drop.type = "button";
            drop.title = `stop considering ${t.code}`;
            drop.disabled = Boolean(busy);
            drop.addEventListener("click", () =>
              evaluate(theirs.filter((o) => o.code !== t.code).map((o) => o.code)),
            );
            chip.append(drop);
            chips.append(chip);
          }
        }
        picker.append(chips);

        if (!available.length) {
          picker.append(
            el("p", "muted", "connect the extension to add programs you are not enrolled in."),
          );
          return;
        }

        const select = el("select");
        select.multiple = true;
        select.size = 8;
        for (const p of available) {
          if (enrolled.has(p.Code)) continue;
          const option = el("option", undefined, `${p.Code} — ${p.Title}`);
          option.value = p.Code;
          option.selected = wanted.includes(p.Code);
          select.append(option);
        }
        select.addEventListener("change", () =>
          store.set({ wanted: Array.from(select.selectedOptions).map((o) => o.value) }),
        );
        picker.append(select);

        // Enabled whenever the selection differs from what is loaded, which
        // includes clearing it back to the enrolled programs alone.
        const same =
          wanted.length === theirs.length && theirs.every((t) => wanted.includes(t.code));
        const go = el("button", "primary", busy || "evaluate this combination");
        go.type = "button";
        go.disabled = Boolean(busy) || same;
        go.addEventListener("click", () => void evaluate(store.get().wanted));
        picker.append(go);
      },
    ),
  );

  // ---- the choices -----------------------------------------------------

  const label = (code: string) => titles.get(code) ?? "";

  /**
   * A choice already answered by coursework the plan requires anyway.
   *
   * When the courses another requirement forces on you already meet this
   * group's credits, there is no decision left. Offering the rest of the pool
   * invites a student to buy a second course for a requirement that is
   * finished, which is exactly the mistake the whole cover exists to avoid.
   */
  const settledBy = (choice: RankedChoice) => {
    const forced = choice.candidates.filter((c) => c.forced);
    const covered = forced.reduce((n, c) => n + c.credits, 0);
    return covered >= choice.credits ? forced : [];
  };

  function candidateRow(candidate: Candidate, settled: boolean) {
    const { pinned } = store.get();
    // A settled group shows its forced courses as the answer, and offers no
    // way to pick around them.
    const isPinned = settled ? candidate.forced : pinned.includes(candidate.code);
    const row = el("div", `candidate${isPinned ? " picked" : ""}${settled ? " settled" : ""}`);

    const pick = el("button", "pick");
    pick.type = "button";
    pick.textContent = isPinned ? "✓" : "+";
    if (settled) {
      pick.disabled = true;
      pick.title = candidate.forced
        ? "required by another part of your degree, so it settles this one"
        : "this requirement is already met";
    } else {
      pick.title = isPinned ? "unpick" : "pick this course";
      pick.addEventListener("click", () =>
        store.set({
          pinned: isPinned
            ? pinned.filter((c) => c !== candidate.code)
            : [...pinned, candidate.code],
        }),
      );
    }
    row.append(pick);

    row.append(el("b", undefined, candidate.code));
    row.append(el("span", "title", label(candidate.code)));

    const cost = priceOf(candidate);
    const badge = tag(cost.text, cost.kind);
    badge.title = cost.why;
    row.append(badge);

    // A course paying into two programs is the finding worth surfacing.
    const across = [...new Set(candidate.satisfies.map((s) => s.program))];
    if (across.length > 1) row.append(tag(`counts for ${across.join(" + ")}`, "free"));
    if (candidate.requires.length) {
      row.append(el("span", "muted", `needs ${candidate.requires.join(", ")} first`));
    }
    return row;
  }

  subs.add(
    store.watch(
      (s) =>
        `${s.pinned.join(",")}:${JSON.stringify(s.tracks)}:${s.resolved.size}:${trees.map((t) => t.code).join(",")}`,
      () => {
        localStorage.setItem(PINS, JSON.stringify(store.get().pinned));
        localStorage.setItem(TRACKS, JSON.stringify(store.get().tracks));
        const ranking = rank(trees, store.get().resolved);

        summary.replaceChildren();
        summary.append(
          document.createTextNode(
            `${trees.map((t) => t.code).join(" + ")} · finishes ${ranking.baseline.finishes ?? "beyond the horizon"} · ` +
              `${ranking.baseline.totalCredits} credits · ${ranking.choices.length} choices left`,
          ),
        );
        if (ranking.shared.length) {
          summary.append(
            el(
              "span",
              "shared",
              ` · ${ranking.shared.length} courses count toward more than one program`,
            ),
          );
        }

        body.replaceChildren();

        // Tracks first. Choosing the AI track over technical electives moves
        // more than any single elective inside either of them.
        const open = ranking.branches.filter((b) =>
          b.options.some((o) => o.status.completion !== "Completed"),
        );
        for (const branch of open) {
          const box = el("div", "choice branch");
          const head = el("h3");
          head.append(document.createTextNode(tidy(branch.text)));
          head.append(tag(branch.program, "prog"));
          box.append(head);

          for (const option of branch.options) {
            const row = el("div", `candidate${option.taken ? " picked" : ""}`);
            const pick = el("button", "pick");
            pick.type = "button";
            pick.textContent = option.taken ? "●" : "○";
            pick.title = option.taken ? "currently chosen" : `choose ${option.label}`;
            pick.addEventListener("click", () =>
              store.set({ tracks: { ...store.get().tracks, [branch.key]: option.id } }),
            );
            row.append(pick);
            row.append(el("span", "label", option.label));

            if (option.status.completion === "Completed") {
              row.append(tag("already met", "free"));
            } else if (option.addedTerms === null) {
              row.append(tag("won't schedule", "bad"));
            } else if (option.addedTerms === 0 && option.addedCredits === 0) {
              row.append(tag("cheapest", "free"));
            } else {
              const terms = option.addedTerms
                ? `+${option.addedTerms} term${option.addedTerms === 1 ? "" : "s"}, `
                : "";
              row.append(
                tag(`${terms}+${option.addedCredits} cr`, option.addedTerms ? "bad" : "cheap"),
              );
            }
            box.append(row);
          }

          if (store.get().tracks[branch.key]) {
            const reset = el("button", "reset", "use the cheapest instead");
            reset.type = "button";
            reset.addEventListener("click", () => {
              const { [branch.key]: _dropped, ...rest } = store.get().tracks;
              store.set({ tracks: rest });
            });
            box.append(reset);
          }
          body.append(box);
        }

        if (!ranking.choices.length) {
          body.append(el("p", "muted", "nothing left to choose — every requirement is decided."));
        }

        for (const choice of ranking.choices) {
          const settled = settledBy(choice);
          const box = el("div", `choice${settled.length ? " settled" : ""}`);
          const head = el("h3");
          head.append(document.createTextNode(tidy(choice.text)));
          head.append(el("span", "cr", `${choice.credits} cr`));
          head.append(tag(choice.program, "prog"));
          if (settled.length) head.append(tag("settled", "free"));
          box.append(head);

          if (settled.length) {
            box.append(
              el(
                "p",
                "muted",
                `${settled.map((c) => c.code).join(" and ")} covers this, and your degree ` +
                  "requires it anyway — nothing to decide here.",
              ),
            );
          }

          // A pool that cannot close its own requirement is almost always a
          // course meant to be taken twice, which a set of codes cannot say.
          const short = ranking.shortfalls.find((s) => groupKey(s.ids) === groupKey(choice.ids));
          if (short) {
            const warn = el(
              "p",
              "shortfall",
              `these add up to ${short.wanted - short.short} of the ${short.wanted} credits needed — ` +
                "the remainder is likely a course taken twice; check with your advisor",
            );
            box.append(warn);
          }

          for (const candidate of choice.candidates)
            box.append(candidateRow(candidate, settled.length > 0));
          if (!choice.candidates.length) {
            box.append(el("p", "muted", "no course in this pool is still available to you."));
          }
          body.append(box);
        }

        const pending = ranking.unenumerable.filter((u) => !u.bucket);
        if (pending.length) {
          const box = el("div", "choice unenumerable");
          box.append(el("h3", undefined, "Colleague would not expand these"));
          box.append(el("p", "muted", "ask your advisor what qualifies."));
          for (const u of pending) {
            box.append(
              el("div", "candidate muted", `${u.credits ? `${u.credits}cr  ` : ""}${u.text}`),
            );
          }
          body.append(box);
        }
      },
    ),
  );

  return {
    destroy() {
      subs.clear();
      root.replaceChildren();
    },
  };
}
