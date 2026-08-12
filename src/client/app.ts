/*
 * The shell. Owns the controls and swaps one of the views into #outlet;
 * each view exports mount(root, ctx) -> { destroy }.
 *
 * Shell state lives in a store for the same reason the schedule view's does:
 * a status line, a busy flag, and a mounted view kept in sync by hand drift
 * apart the moment a fourth thing needs to know about them. Here, setting
 * state is the only way to change what is on screen.
 *
 * Everything below runs on the student's own machine. The catalog comes from
 * this app's server, which fetched it anonymously; the evaluation comes from
 * the extension and goes nowhere else.
 */

import type { TermCatalog } from "../catalog";
import type { Capture } from "../content";
import { enumeratedCourseIds, normalize, openGroups, type ProgramTree } from "../requirements";
import {
  capture,
  catalogStatus,
  dumpForDev,
  fetchAllCourses,
  fetchCatalog,
  installed,
  programs,
  refreshCatalog,
  terms,
} from "./bridge";
import { $ } from "./dom";
import { createStore } from "./store";
import * as build from "./views/build";
import * as map from "./views/map";
import * as overlap from "./views/overlap";
import * as plan from "./views/plan";
import * as schedule from "./views/schedule";
import * as tree from "./views/tree";

const STORE = "cedarville:last-capture";
const SECTIONS = "cedarville:last-sections";
const VIEWS = { build, map, requirements: tree, overlap, schedule, plan } as const;
type ViewName = keyof typeof VIEWS;

interface Shell {
  trees: ProgramTree[];
  /** Codes the registrar has the student in, as opposed to what-if additions. */
  enrolled: string[];
  sections?: TermCatalog;
  allCourses?: TermCatalog["courses"];
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
  allCourses: [],
  view: "build",
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
    `${s.view}:${s.trees.map((t) => t.code).join(",")}:${s.sections?.fetchedAt ?? ""}:${s.allCourses?.length ?? 0}`,
  () => {
    const { view, trees, enrolled, sections, allCourses } = store.get();
    mounted?.destroy();
    mounted = VIEWS[view].mount($("#outlet"), { trees, enrolled, sections, allCourses, adopt });
    for (const button of Array.from($("#tabs").querySelectorAll("button"))) {
      button.classList.toggle("on", button.dataset.view === view);
    }
  },
);

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
  localStorage.setItem(STORE, JSON.stringify(snapshot));
  store.set({
    trees: Object.values(snapshot.evaluations).map(normalize),
    enrolled: (snapshot.enrolled ?? []).map((p) => p.code),
    who: `student ${snapshot.studentId} · captured ${new Date(snapshot.capturedAt).toLocaleString()}`,
  });
}

/** Every course that could still close a requirement. */
function candidateCourseIds(): string[] {
  const ids = new Set<string>();
  for (const t of store.get().trees) {
    for (const { group } of openGroups(t)) {
      for (const id of enumeratedCourseIds(group) ?? []) ids.add(id);
    }
  }
  return [...ids];
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
    void dumpForDev("evaluations", snapshot);
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

$("#load-sections").addEventListener("click", async () => {
  const term = $<HTMLSelectElement>("#term").value;
  if (!term) return say("pick a term first", "err");

  store.set({ busy: true });
  try {
    const status = await catalogStatus();
    const cached = status.terms.find((t) => t.term === term);

    if (!cached || cached.sections === 0) {
      say(`asking the server to fetch ${term}…`);
      await refreshCatalog(term);
      await awaitCrawl(term);
    } else if (status.refreshing.includes(term)) {
      await awaitCrawl(term);
    }

    const courseIds = candidateCourseIds();
    const sections = await fetchCatalog(term, courseIds.length ? courseIds : undefined);
    localStorage.setItem(SECTIONS, JSON.stringify(sections));
    void dumpForDev("catalog", sections);

    store.set({ sections, view: "schedule" });
    say(
      `${sections.sections.length} sections for ${term}, ` +
        `fetched ${new Date(sections.fetchedAt).toLocaleTimeString()}`,
      "ok",
    );
  } catch (err) {
    say(message(err), "err");
  } finally {
    store.set({ busy: false, progress: null });
  }
});

// ---- start -------------------------------------------------------------

function restoreCached() {
  const sections = localStorage.getItem(SECTIONS);
  if (sections) {
    try {
      store.set({ sections: JSON.parse(sections) as TermCatalog });
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

/** The full course list backs the prerequisite graph; fetch it once. */
void fetchAllCourses().then((allCourses) => {
  if (allCourses?.length) store.set({ allCourses });
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
    if (status.terms.length === 0) select.add(new Option("no catalog yet", ""));
    select.disabled = false;
    $<HTMLButtonElement>("#load-sections").disabled = false;
    say("");
  } catch {
    say("the planner server is not reachable", "err");
    return;
  }

  if (!installed()) {
    // Never step on an error with a lesser message.
    if (store.get().tone !== "err") {
      say("browse the catalog freely; install the bridge extension to match it to your degree");
    }
    return;
  }

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

    say(hadCache ? "showing your last capture" : `${active.length} programs available`);
  } catch (err) {
    say(message(err), "err");
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Surfaces a blank page as a message instead of a silent nothing.
window.addEventListener("error", (e) => say(`crashed: ${e.message}`, "err"));

init();
