/*
 * The shell. Owns the controls and swaps one of the views into #outlet;
 * each view exports mount(root, ctx) -> { destroy }.
 *
 * Shell state lives in a store for the same reason the semester view's does:
 * a status line, a busy flag, and a mounted view kept in sync by hand drift
 * apart the moment a fourth thing needs to know about them. Here, setting
 * state is the only way to change what is on screen.
 *
 * Everything below runs on the student's own machine. The catalog is crawled
 * through the extension, on this student's own session, and offered to the
 * app's server so the next student does not have to crawl it again; the
 * evaluation comes from the extension and goes nowhere else.
 */

import { slimCatalog, type TermCatalog, termNow } from "../catalog";
import type { Capture } from "../content";
import { ALL_COURSES, crawlAllCourses, crawlTerm } from "../crawl";
import { normalize, type ProgramTree } from "../requirements";
import {
  BRIDGE_VERSION,
  bridgeVersion,
  capture,
  catalogStatus,
  fetchAllCourses,
  fetchCatalog,
  installed,
  offerCatalog,
  programs,
  searcher,
  terms,
} from "./bridge";
import { $ } from "./dom";
import { COURSE_LIST_HOURS, olderThan, planFor, TERM_HOURS } from "./freshness";
import { createStore } from "./store";
import * as build from "./views/build";
import * as plan from "./views/plan";
import * as record from "./views/record";
import * as semester from "./views/semester";

const STORE = "cedarville:last-capture";
const SECTIONS = "cedarville:last-sections";
/** Which term the sections above are for, kept even when they will not fit. */
const TERM = "cedarville:last-term";
const VIEWS = { build, plan, semester, record } as const;

/** Where the tabs that were folded into others went. */
const MOVED: Record<string, keyof typeof VIEWS> = {
  map: "plan",
  overlap: "build",
  requirements: "record",
  // The section builder became one term at a time, and said so in its name.
  schedule: "semester",
};
type ViewName = keyof typeof VIEWS;

const isView = (name: string): name is ViewName => name in VIEWS;

/**
 * Which tab the address bar is asking for.
 *
 * A planner is a thing you leave open, reload, and send to somebody. All three
 * want the tab in the URL rather than in a variable that resets to "build".
 */
const viewInUrl = (): ViewName | null => {
  const asked = decodeURIComponent(location.hash.slice(1));
  // A link written before six tabs became four still lands somewhere true.
  return isView(asked) ? asked : (MOVED[asked] ?? null);
};

interface Shell {
  trees: ProgramTree[];
  /** Codes the registrar has the student in, as opposed to what-if additions. */
  enrolled: string[];
  /** Credentials named but never evaluated, so the build view can say so. */
  unmatched: string[];
  sections?: TermCatalog;
  allCourses?: TermCatalog["courses"];
  /**
   * Terms there is any point asking for: cached here, or named by the
   * registrar. The semester view offers these rather than every term its
   * projection reaches, because Colleague publishes a term or two ahead and a
   * crawl of the autumn after next comes back empty.
   */
  terms: string[];
  view: ViewName;
  status: string;
  tone: "" | "err" | "ok";
  busy: boolean;
  progress: string | null;
  who: string;
}

const store = createStore<Shell>({
  trees: [],
  enrolled: [],
  unmatched: [],
  allCourses: [],
  terms: [],
  view: viewInUrl() ?? "build",
  status: "",
  tone: "",
  busy: false,
  progress: null,
  who: "",
});

const say = (status: string, tone: Shell["tone"] = "") => store.set({ status, tone });

// ---- rendering the shell ----------------------------------------------

let mounted: { destroy(): void } | null = null;

/** Remount when the view changes or the data under it does. */
store.watch(
  (s) =>
    `${s.view}:${s.trees.map((t) => t.code).join(",")}:${s.unmatched.join(",")}:${s.sections?.fetchedAt ?? ""}:${s.allCourses?.length ?? 0}:${s.terms.join(",")}`,
  () => {
    const { view, trees, enrolled, unmatched, sections, allCourses, terms: known } = store.get();
    mounted?.destroy();
    mounted = VIEWS[view].mount($("#outlet"), {
      trees,
      enrolled,
      unmatched,
      sections,
      allCourses,
      terms: known,
      adopt,
      loadTerm,
    });
    for (const button of Array.from($("#tabs").querySelectorAll("button"))) {
      button.classList.toggle("on", button.dataset.view === view);
    }
  },
);

// Replaced rather than pushed: a reload should land where you were, and the
// back button belongs to the pages you came from, not to the tabs you clicked.
store.watch(
  (s) => s.view,
  (view) => {
    if (location.hash.slice(1) !== view) history.replaceState(null, "", `#${view}`);
  },
);

// Someone pasted a link, or pressed back out of a tab they had linked to.
window.addEventListener("hashchange", () => {
  const asked = viewInUrl();
  if (asked) store.set({ view: asked });
});

store.watch(
  (s) => `${s.status}:${s.tone}`,
  () => {
    const { status, tone } = store.get();
    $("#status").textContent = status;
    $("#status").className = tone;
  },
);

store.watch(
  (s) => s.busy,
  (busy) => {
    for (const id of ["#capture", "#load-sections"]) $<HTMLButtonElement>(id).disabled = busy;
  },
);

store.watch(
  (s) => s.progress,
  (progress) => {
    $("#progress-bar").hidden = progress === null;
    if (progress !== null) $("#progress-text").textContent = progress;
  },
);

store.watch(
  (s) => s.who,
  (who) => {
    $("#who").textContent = who;
    $("#tabs").hidden = who === "";
  },
);

// ---- actions -----------------------------------------------------------

/**
 * Takes on a capture, wherever it came from.
 *
 * The build view can trigger one of its own by adding a major, so persisting
 * here rather than at each call site is what keeps a reload showing the same
 * combination the student was last looking at.
 */
function adopt(snapshot: Capture) {
  try {
    localStorage.setItem(STORE, JSON.stringify(snapshot));
  } catch {
    // An evaluation is worth having on screen even when there is no room to
    // keep it; the alternative is a capture that throws after it worked.
    say("no room to remember this capture; it will need capturing again after a reload");
  }
  store.set({
    trees: Object.values(snapshot.evaluations).map(normalize),
    enrolled: (snapshot.enrolled ?? []).map((p) => p.code),
    unmatched: snapshot.unmatched ?? [],
    who: `student ${snapshot.studentId} · captured ${new Date(snapshot.capturedAt).toLocaleString()}`,
  });
}

$("#tabs").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest("button");
  if (button?.dataset.view) store.set({ view: button.dataset.view as ViewName });
});

$("#capture").addEventListener("click", async () => {
  store.set({ busy: true });
  say("evaluating… a few seconds per program");
  try {
    const whatIf = $<HTMLSelectElement>("#whatif").value;
    const snapshot = await capture(whatIf ? [whatIf] : []);
    adopt(snapshot);
    store.set({ view: "build" });
    say(`captured ${Object.keys(snapshot.evaluations).length} programs`, "ok");
  } catch (err) {
    say(message(err), "err");
  } finally {
    store.set({ busy: false });
  }
});

/** Waits out a server-side crawl, reporting how far along it is. */
async function awaitCrawl(term: string) {
  for (let tick = 0; tick < 600; tick++) {
    const status = await catalogStatus();
    const row = status.terms.find((t) => t.term === term);
    store.set({
      progress: row
        ? `${row.sections} sections cached${status.refreshing.includes(term) ? ", still fetching" : ""}`
        : "fetching the catalog…",
    });
    if (!status.refreshing.includes(term)) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/**
 * Crawls a term here, on this student's session, and offers it to the server.
 *
 * The server used to do this anonymously. Cedarville closed the guest
 * endpoint, so the only session that can read a timetable is the one in this
 * browser, and the crawl runs through the extension instead.
 *
 * The offer afterwards is what keeps the old promise: whoever opens a term
 * first pays about sixty pages for it, and everybody after them reads the
 * cache. A refusal costs nothing here — the sections are already in hand, and
 * the server declining to share them is its business, not this student's.
 */
async function crawlHere(term: string): Promise<TermCatalog> {
  const crawled = await crawlTerm(searcher, term, {
    onProgress: ({ page, pages, sections, phase }) =>
      store.set({
        progress:
          `${phase === "courses" ? "course details" : "sections"} ` +
          `page ${page}/${pages}, ${sections} so far`,
      }),
  });

  store.set({ progress: `offering ${crawled.sections.length} sections to the shared cache…` });
  const shared = await offerCatalog(crawled);
  say(
    shared
      ? `crawled ${crawled.sections.length} sections for ${term} and shared them`
      : `crawled ${crawled.sections.length} sections for ${term}; the server kept its own copy`,
    "ok",
  );
  return crawled;
}

/**
 * Fills the list of every course the school offers, which is a different
 * crawl from a term's timetable.
 *
 * A term says what is *offered*; this says what *exists*, and the difference
 * is a third of the prerequisite graph: a requisite is routinely a course
 * nobody is teaching this year. Without it a planned course outside the one
 * cached term has no title, no credits and no requisites — which is exactly
 * what a student saw the first time this was hosted, because the server used
 * to crawl this itself and Cedarville's move to SSO ended that.
 *
 * So it happens once, here, on whoever opens a term first, and everybody
 * after them reads the cache.
 */
async function crawlCourseList(): Promise<void> {
  store.set({ progress: "course list: starting…" });
  const { courses, complete } = await crawlAllCourses(searcher, {
    onProgress: ({ page, pages, sections }) =>
      store.set({ progress: `course list: page ${page}/${pages}, ${sections} courses` }),
  });
  if (!complete || courses.length === 0) {
    // Offering a partial catalog would file "what exists" as a fraction of
    // itself, and the server would rightly refuse it anyway.
    say(`the course list crawl stopped at ${courses.length} courses; the plan will be thinner`);
    return;
  }

  store.set({ progress: `offering ${courses.length} courses to the shared cache…` });
  const shared = await offerCatalog({
    term: ALL_COURSES,
    fetchedAt: new Date().toISOString(),
    sections: [],
    courses,
    complete: true,
  });
  store.set({ allCourses: courses });
  say(
    shared
      ? `${courses.length} courses in the shared course list; the plan can read requisites now`
      : `${courses.length} courses read; the server kept its own list`,
    "ok",
  );
}

// Pressing it is a decision: a student who asks for the catalog wants today's,
// not yesterday's that happened to be in hand.
$("#load-sections").addEventListener("click", () => {
  const term = $<HTMLSelectElement>("#term").value;
  if (!term) return say("pick a term first", "err");
  void loadTerm(term, { force: true });
});

/**
 * Brings a term's timetable in, from wherever it can be had.
 *
 * The shell owns this rather than the semester view, even though that view is
 * the one asking: there is one term control, one status line and one copy of
 * the catalog in the store, and a view that fetched its own would be a second
 * answer to "which term am I looking at".
 */
async function loadTerm(term: string, { force = false }: { force?: boolean } = {}) {
  // The control at the top and the one in the view are the same decision.
  const select = $<HTMLSelectElement>("#term");
  if (select.value !== term) {
    if (!Array.from(select.options).some((o) => o.value === term)) {
      select.add(new Option(term, term));
    }
    select.value = term;
  }

  store.set({ busy: true });
  try {
    const status = await catalogStatus();
    const cached = status.terms.find((t) => t.term === term);

    if (status.refreshing.includes(term)) await awaitCrawl(term);

    const held = {
      sections: cached?.sections ?? 0,
      ...(cached ? { fetchedAt: cached.fetchedAt } : {}),
    };
    const empty = held.sections === 0;
    const stale = empty || olderThan(TERM_HOURS, held.fetchedAt);

    let sections: TermCatalog;
    const plan = planFor(held, { force, installed: installed() });
    if (plan === "crawl") {
      say(
        empty
          ? `no catalog for ${term} yet; crawling it here…`
          : `re-crawling ${term} on your session…`,
      );
      sections = await crawlHere(term);
    } else if (plan === "refuse") {
      // Nothing to serve and nothing to crawl with.
      throw new Error(
        `no catalog for ${term} yet, and the bridge extension is not installed. ` +
          "Install it and sign in to Self-Service, then try again.",
      );
    } else {
      /*
       * The whole term, not the courses a requirement happens to enumerate.
       *
       * This used to narrow the fetch to open requirement groups, which is a
       * smaller set than the plan schedules: a prerequisite pulled in by the
       * closure belongs to no group, so its sections never arrived and the
       * semester read "not taught this term" about a course the timetable was
       * teaching. Narrowing bought 306 sections of 1806 — and the whole term
       * is 720KB on the wire, gzipped by the server, half a second once per
       * term. That is not a saving worth a wrong answer.
       */
      sections = await fetchCatalog(term);
      const age = new Date(sections.fetchedAt).toLocaleString();
      say(
        stale
          ? `${sections.sections.length} sections for ${term}, from ${age}. ` +
              "Install the bridge to refresh it."
          : `${sections.sections.length} sections for ${term}, fetched ${age}`,
        "ok",
      );
    }

    /*
     * The course list, on the same two rules and its own clock.
     *
     * Checked whether or not the term had to be crawled, because the two are
     * filled independently: a server can hold a complete timetable and no
     * course list at all, which is the state that draws a planned course with
     * no title and no requisites.
     */
    if (installed()) {
      const held = await fetchAllCourses();
      if (force || !held.courses?.length || olderThan(COURSE_LIST_HOURS, held.fetchedAt)) {
        await crawlCourseList();
      } else {
        store.set({ allCourses: held.courses });
      }
    }

    // The store first, and the cache afterwards. A sixty-page crawl that
    // succeeded was being thrown away by the line that tried to remember it:
    // a term of raw sections is ten megabytes, a browser allows five for
    // everything a site stores, and the throw happened before the handover.
    //
    // And no view change. Fetching data is not a change of subject: a student
    // reading their plan who presses "load catalog" wants the plan to get
    // better, not to be moved to a different tab.
    store.set({ sections });
    remember(sections);
  } catch (err) {
    say(message(err), "err");
  } finally {
    store.set({ busy: false, progress: null });
  }
}

// ---- remembering across reloads ---------------------------------------

/**
 * Keeps a term's timetable for the next reload, and never more than that.
 *
 * The catalog is the one thing here that is not personal, which means it is
 * also the one thing that can always be had again: it lives on the server,
 * fetched in a hundred milliseconds. So this is a convenience and is written
 * as one — slimmed to the fields the app parses, and abandoned without
 * complaint when it still will not fit, because the alternative is a crawl
 * reported as an error.
 */
function remember(catalog: TermCatalog) {
  try {
    localStorage.setItem(TERM, catalog.term);
  } catch {
    /* Out of room for eight bytes is out of room for anything. */
  }
  try {
    localStorage.setItem(SECTIONS, JSON.stringify(slimCatalog(catalog)));
  } catch {
    // Freeing it is the point: a blob already in there is what filled the
    // quota, and the term above is enough to fetch this one again.
    localStorage.removeItem(SECTIONS);
  }
}

function restoreCached() {
  const sections = localStorage.getItem(SECTIONS);
  if (sections) {
    try {
      const catalog = JSON.parse(sections) as TermCatalog;
      store.set({ sections: catalog });
      // Shrinks what an older version of this page left behind, which is
      // what was filling the quota on every load since.
      remember(catalog);
    } catch {
      localStorage.removeItem(SECTIONS);
    }
  }

  const snapshot = localStorage.getItem(STORE);
  if (!snapshot) return false;
  try {
    adopt(JSON.parse(snapshot) as Capture);
    return true;
  } catch {
    localStorage.removeItem(STORE);
    return false;
  }
}

/** The full course list backs the prerequisite graph; read what is shared. */
void fetchAllCourses().then((held) => {
  if (held.courses?.length) store.set({ allCourses: held.courses });
});

async function init() {
  // Repaint the last capture immediately, so a reload costs nothing.
  const hadCache = restoreCached();

  // The catalog needs no extension: the server fetched it anonymously.
  try {
    const status = await catalogStatus();
    const select = $<HTMLSelectElement>("#term");
    select.replaceChildren();
    for (const row of status.terms) {
      select.add(new Option(`${row.term} · ${row.sections} sections`, row.term));
    }
    store.set({ terms: status.terms.map((row) => row.term) });
    // Nothing cached, and without the extension there is no term list to ask
    // for either. Offering the term the calendar is in gives the fetch button
    // something to act on, which is the whole of a stranger's first run.
    if (status.terms.length === 0) {
      const now = termNow(new Date());
      select.add(new Option(`${now} · nothing cached yet`, now));
    }
    select.disabled = false;
    $<HTMLButtonElement>("#load-sections").disabled = false;
    say("");

    /*
     * The term that was last open, brought up to date.
     *
     * Two reasons to act, and `loadTerm` tells them apart on its own: there
     * is no local copy at all, because the catalog was too big for this
     * browser to keep and the server is the one holding it; or the copy we
     * have has gone a day stale, which during registration means sections
     * have opened, filled and been cancelled since.
     *
     * Not forced, so a fresh shared copy costs a fetch rather than a crawl:
     * the first student each day pays the pages and the rest read what they
     * shared. And not awaited, because a page that will not paint until it
     * has re-read a timetable is a page that looks broken.
     */
    const last = localStorage.getItem(TERM);
    const held = store.get().sections;
    const known = last && status.terms.some((t) => t.term === last);
    if (known && (!held || olderThan(TERM_HOURS, held.fetchedAt))) {
      void loadTerm(last);
    }
  } catch {
    say("the planner server is not reachable", "err");
    return;
  }

  if (!installed()) {
    $("#get-bridge").hidden = false;
    // Never step on an error with a lesser message.
    if (store.get().tone !== "err") {
      say("browse the catalog freely; install the bridge to match it against your degree");
    }
    return;
  }

  /*
   * Whether the extension answering is the one this page was built against.
   *
   * The commonest failure in this application is not a bug in either half,
   * it is the two halves being different ages: an extension updates, a
   * Self-Service tab keeps the content script it loaded this morning, and the
   * symptom is a reply in a shape the page stopped expecting. That is worth
   * one request at startup to say plainly.
   */
  void bridgeVersion().then(
    (theirs) => {
      if (!BRIDGE_VERSION || theirs === BRIDGE_VERSION) return;
      $("#get-bridge").hidden = false;
      say(
        `your bridge is ${theirs} and this planner expects ${BRIDGE_VERSION}; ` +
          "update it before capturing anything",
        "err",
      );
    },
    () => {
      // Old enough never to have heard the question, which answers it.
      $("#get-bridge").hidden = false;
      say("your bridge is older than this planner; update it before capturing anything", "err");
    },
  );

  try {
    const [list, available] = await Promise.all([programs(), terms()]);
    const whatIf = $<HTMLSelectElement>("#whatif");
    const active = list.filter((p) => p.IsActive).sort((x, y) => x.Title.localeCompare(y.Title));
    for (const p of active) whatIf.add(new Option(`${p.Title} (${p.Code})`, p.Code));
    whatIf.disabled = false;
    $<HTMLButtonElement>("#capture").disabled = false;

    // Colleague lists terms oldest first; the one you are planning is last.
    const select = $<HTMLSelectElement>("#term");
    if (!select.value && available.length) select.value = available[available.length - 1]!.code;
    // The registrar's own list, which is wider than whatever has been cached.
    store.set({
      terms: [...new Set([...store.get().terms, ...available.map((t) => t.code)])],
    });

    say(hadCache ? "showing your last capture" : `${active.length} programs available`);
  } catch (err) {
    say(message(err), "err");
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Surfaces a blank page as a message instead of a silent nothing.
window.addEventListener("error", (e) => say(`crashed: ${e.message}`, "err"));

init();
