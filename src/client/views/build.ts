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
import { completedCourses, inProgressCourses, type ProgramTree } from "../../requirements";
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
  available: ProgramSummary[];
  /** Rule pools once the server has asked Colleague what qualifies. */
  resolved: Map<string, string[]>;
  busy: string;
}

const PINS = "cedarville:pins";

/** "+2 terms" reads better than a bare number, and null is not a number. */
function priceOf(candidate: Candidate): { text: string; kind: string } {
  if (candidate.forced) return { text: "already required", kind: "free" };
  if (candidate.addedTerms === null) return { text: "does not fit", kind: "bad" };
  if (candidate.addedTerms === 0) {
    return candidate.addedCredits === 0
      ? { text: "free", kind: "free" }
      : { text: `+${candidate.addedCredits} cr`, kind: "cheap" };
  }
  const terms = `+${candidate.addedTerms} term${candidate.addedTerms === 1 ? "" : "s"}`;
  return { text: `${terms}, +${candidate.addedCredits} cr`, kind: "bad" };
}

export function mount(root: HTMLElement, ctx: Ctx) {
  const subs = new Subscriptions();
  const { trees, sections: catalog } = ctx;

  const store = createStore<State>({
    wanted: [],
    pinned: JSON.parse(localStorage.getItem(PINS) ?? "[]"),
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
      graph,
      offeredIn,
      slots: termsFrom({ year: 2027, season: "spring" }, 12, { capacity: 15 }),
    });

  expandRules(trees);

  // ---- the program picker ----------------------------------------------

  subs.add(
    store.watch(
      (s) => `${s.available.length}:${s.wanted.join(",")}:${s.busy}`,
      () => {
        const { available, wanted, busy } = store.get();
        picker.replaceChildren();
        picker.append(el("h2", undefined, "majors and minors"));

        const enrolled = new Set(trees.map((t) => t.code));
        const chips = el("div", "chips");
        for (const t of trees) chips.append(tag(`${t.code} — enrolled`, "on"));
        picker.append(chips);

        if (!available.length) {
          picker.append(
            el("p", "muted", "connect the extension to add programs you are not enrolled in."),
          );
        } else {
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
            store.set({
              wanted: Array.from(select.selectedOptions).map((o) => o.value),
            }),
          );
          picker.append(select);

          const go = el("button", "primary", busy || "evaluate this combination");
          go.type = "button";
          go.disabled = Boolean(busy) || wanted.length === 0;
          go.addEventListener("click", async () => {
            store.set({ busy: "evaluating…" });
            try {
              const snapshot = await capture(store.get().wanted);
              ctx.adopt?.(snapshot);
            } catch {
              store.set({ busy: "" });
            }
          });
          picker.append(go);
        }
      },
    ),
  );

  // ---- the choices -----------------------------------------------------

  const label = (code: string) => titles.get(code) ?? "";

  function candidateRow(candidate: Candidate) {
    const { pinned } = store.get();
    const isPinned = pinned.includes(candidate.code);
    const row = el("div", `candidate${isPinned ? " picked" : ""}`);

    const pick = el("button", "pick");
    pick.type = "button";
    pick.textContent = isPinned ? "✓" : "+";
    pick.title = isPinned ? "unpick" : "pick this course";
    pick.addEventListener("click", () =>
      store.set({
        pinned: isPinned ? pinned.filter((c) => c !== candidate.code) : [...pinned, candidate.code],
      }),
    );
    row.append(pick);

    row.append(el("b", undefined, candidate.code));
    row.append(el("span", "title", label(candidate.code)));

    const cost = priceOf(candidate);
    row.append(tag(cost.text, cost.kind));

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
      (s) => `${s.pinned.join(",")}:${s.resolved.size}:${trees.map((t) => t.code).join(",")}`,
      () => {
        localStorage.setItem(PINS, JSON.stringify(store.get().pinned));
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
        if (!ranking.choices.length) {
          body.append(el("p", "muted", "nothing left to choose — every requirement is decided."));
        }

        for (const choice of ranking.choices) {
          const box = el("div", "choice");
          const head = el("h3");
          head.append(document.createTextNode(choice.text));
          head.append(el("span", "cr", `${choice.credits} cr`));
          head.append(tag(choice.program, "prog"));
          box.append(head);

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
