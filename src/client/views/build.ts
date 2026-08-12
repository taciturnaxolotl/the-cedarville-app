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

import type { TermCatalog } from "../../catalog";
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
import { capture, catalogStatus, fetchCatalog, installed, programs, resolveRules } from "../bridge";
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
  /** Bumped when another term's seasons land, to reproject against them. */
  seasonsAt: number;
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
  return delta(candidate.addedTerms, candidate.addedCredits);
}

/** Signs the numbers, so a saving reads as one rather than as "free". */
function delta(terms: number, credits: number): { text: string; kind: string; why: string } {
  const signed = (n: number, unit: string) =>
    `${n > 0 ? "+" : "−"}${Math.abs(n)} ${unit}${unit === "term" && Math.abs(n) !== 1 ? "s" : ""}`;

  if (terms === 0 && credits === 0) {
    return { text: "free", kind: "free", why: "it fits in credits you are already spending" };
  }
  if (terms === 0) {
    return credits < 0
      ? {
          text: signed(credits, "cr"),
          kind: "free",
          why: "switching to this gives you those credits back",
        }
      : { text: signed(credits, "cr"), kind: "cheap", why: "extra credits, but the date holds" };
  }
  const both = `${signed(terms, "term")}, ${signed(credits, "cr")}`;
  return terms < 0
    ? { text: both, kind: "free", why: "switching to this brings your finish date in" }
    : { text: both, kind: "bad", why: "choosing this pushes your finish date out" };
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
    seasonsAt: 0,
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

  /**
   * Which courses run in which season, as far as we have actually looked.
   *
   * Colleague publishes a term or two ahead, so this is never complete. The
   * distinction that matters is between a season we hold a listing for — where
   * absence means the course is not taught then — and one we do not, where
   * absence means nothing at all. Collapsing those two lets a fall-only course
   * be scheduled in spring and calls it a plan.
   */
  const seasonOf = (term: string): Season =>
    term.includes("SU") ? "summer" : term.includes("SP") ? "spring" : "fall";

  const known = new Map<Season, Set<string>>();
  const learn = (term: string, sections: TermCatalog["sections"]) => {
    const season = seasonOf(term);
    const set = known.get(season) ?? new Set<string>();
    for (const o of offeringsFromListing(sections)) set.add(o.courseName);
    known.set(season, set);
  };
  if (catalog?.sections?.length) learn(catalog.term, catalog.sections);

  const offeredIn = (code: string, season: Season) => known.get(season)?.has(code) ?? true;

  // ---- layout ----------------------------------------------------------

  const picker = el("section", "picker");
  const summary = el("p", "credits");
  const body = el("div");
  root.replaceChildren(picker, summary, body);

  if (trees.length === 0) {
    summary.textContent = "capture your requirements first, then add majors and minors here.";
    return { destroy: () => root.replaceChildren() };
  }

  const passed = completedCourses(trees[0] as ProgramTree);
  const running = inProgressCourses(trees[0] as ProgramTree);
  // A plan starts after this term, so a course under way counts as held — but
  // telling a student they "already passed" something they sit for in December
  // is simply untrue, so the two are kept apart for the wording.
  const have = new Set([...passed, ...running]);
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

  /**
   * Learn the seasons from every term the server has crawled, not just the one
   * loaded on screen. Two terms in hand makes "not taught in summer" a fact
   * rather than an assumption, and costs one request each.
   */
  void catalogStatus()
    .then(async (status) => {
      const missing = status.terms
        .map((t) => t.term)
        .filter((t) => t !== "ALL" && t !== catalog?.term && t.length);
      for (const term of missing) {
        try {
          const fetched = await fetchCatalog(term);
          if (fetched.sections?.length) learn(term, fetched.sections);
        } catch {
          // One term short is a weaker projection, not a broken one.
        }
      }
      if (missing.length) store.set({ seasonsAt: Date.now() });
    })
    .catch(() => {
      /* No server: every season stays unknown, which `offeredIn` allows. */
    });

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
   * Courses that already meet this requirement because the degree requires
   * them anyway.
   *
   * Worth saying on the heading, and worth saying no more than that. A met
   * requirement is not a closed one: a student may still want a second
   * literature course, and a planner that greys out the rest of the pool has
   * decided on their behalf that they should not.
   */
  const metBy = (choice: RankedChoice) => {
    // A course already passed counts as much as one the degree forces on you,
    // and counts more plainly: HON-1010 met the humanities slot two years ago,
    // and listing HUM-1400 at "+1 term" implies work that is behind you.
    const done = choice.satisfiedBy.map((c) => ({
      code: c.code,
      credits: c.credits,
      done: passed.has(c.code),
      running: running.has(c.code) && !passed.has(c.code),
    }));
    const forced = choice.candidates
      .filter((c) => c.forced)
      .map((c) => ({ code: c.code, credits: c.credits, done: false, running: false }));
    const covering = [...done, ...forced];
    const covered = covering.reduce((n, c) => n + c.credits, 0);
    return covered >= choice.credits ? covering : [];
  };

  function candidateRow(candidate: Candidate) {
    const { pinned } = store.get();
    // A course the degree requires outright is not a choice, so it shows as
    // taken and cannot be unpicked. Its neighbours stay pickable: the group
    // being met is no reason to stop someone taking a second one.
    const isPinned = candidate.forced || pinned.includes(candidate.code);
    const row = el("div", `candidate${isPinned ? " picked" : ""}`);

    const pick = el("button", "pick");
    pick.type = "button";
    pick.textContent = isPinned ? "✓" : "+";
    if (candidate.forced) {
      pick.disabled = true;
      pick.title = "required outright by your degree — not something you choose";
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
        `${s.pinned.join(",")}:${JSON.stringify(s.tracks)}:${s.resolved.size}:${s.seasonsAt}:${trees.map((t) => t.code).join(",")}`,
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
        // Which seasons the projection actually checked. A season with no
        // listing lets every course through, and a date resting on that is
        // worth less than one that does not.
        const guessed = (["fall", "spring", "summer"] as Season[]).filter((s) => !known.has(s));
        if (guessed.length) {
          const note = el(
            "span",
            "guessed",
            ` · ${guessed.join(" and ")} unpublished, so anything is assumed to run then`,
          );
          note.title =
            "Colleague publishes a term or two ahead. Courses are only checked against " +
            "the seasons we hold a listing for; the rest are assumed available.";
          summary.append(note);
        }

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
          // A route already walked ends the decision. Two years of high-school
          // language met the global-awareness requirement, and offering the
          // other five ways to meet it invites work that is already done.
          const finished = branch.options.filter((o) => o.status.completion === "Completed");
          const box = el("div", `choice branch${finished.length ? " met" : ""}`);
          const head = el("h3");
          head.append(document.createTextNode(tidy(branch.text)));
          head.append(tag(branch.program, "prog"));
          if (finished.length) head.append(tag("met", "free"));
          box.append(head);

          for (const option of branch.options) {
            const done = option.status.completion === "Completed";
            // With one route finished the others are moot, not merely unchosen.
            const settled = finished.length > 0;
            const row = el(
              "div",
              `candidate${done || (!settled && option.taken) ? " picked" : ""}`,
            );
            const pick = el("button", "pick");
            pick.type = "button";
            pick.textContent = done || (!settled && option.taken) ? "●" : "○";
            if (settled) {
              pick.disabled = true;
              pick.title = done
                ? "you have already met the requirement this way"
                : "the requirement is already met another way";
            } else {
              pick.title = option.taken ? "currently chosen" : `choose ${option.label}`;
              pick.addEventListener("click", () =>
                store.set({ tracks: { ...store.get().tracks, [branch.key]: option.id } }),
              );
            }
            row.append(pick);
            row.append(el("span", "label", option.label));

            if (done) {
              row.append(tag("already met", "free"));
            } else if (option.addedTerms === null) {
              row.append(tag("won't schedule", "bad"));
            } else if (option.taken) {
              row.append(tag("current", "free"));
            } else {
              const cost = delta(option.addedTerms, option.addedCredits);
              const badge = tag(cost.text, cost.kind);
              badge.title = cost.why;
              row.append(badge);
            }
            box.append(row);
          }

          if (!finished.length && store.get().tracks[branch.key]) {
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
          const met = metBy(choice);
          const box = el("div", `choice${met.length ? " met" : ""}`);
          const head = el("h3");
          head.append(document.createTextNode(tidy(choice.text)));
          head.append(el("span", "cr", `${choice.credits} cr`));
          head.append(tag(choice.program, "prog"));
          if (met.length) {
            const badge = tag("met", "free");
            badge.title = `${met.map((c) => c.code).join(" and ")} already covers this`;
            head.append(badge);
          }
          box.append(head);

          if (met.length) {
            box.append(
              el(
                "p",
                "muted",
                `${met.map((c) => c.code).join(" and ")} covers this — ` +
                  `${met.every((c) => c.running) ? "you are taking it now" : met.some((c) => c.done || c.running) ? "already on your transcript" : "your degree requires it anyway"}. ` +
                  "Pick more if you want them; they will be priced like anything else.",
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

          for (const candidate of choice.candidates) box.append(candidateRow(candidate));
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
