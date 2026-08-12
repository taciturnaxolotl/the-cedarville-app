/*
 * The shell. Owns the capture controls and swaps one of three views into
 * #outlet; each view exports mount(root, ctx) -> { destroy }.
 *
 * Everything below this line runs on the student's own machine against data
 * their own browser fetched. There is no API call in this file and no server
 * to send anything to, which is what keeps an academic record out of scope.
 */

import type { TermCatalog } from "../catalog";
import type { Capture } from "../content";
import { enumeratedCourseIds, normalize, openGroups, type ProgramTree } from "../requirements";
import {
  capture,
  dumpForDev,
  fetchCached,
  installed,
  programs,
  publishCached,
  terms,
} from "./bridge";
import { Cancelled, crawl, type Progress } from "./crawl";
import { $ } from "./dom";
import * as overlap from "./views/overlap";
import * as schedule from "./views/schedule";
import * as tree from "./views/tree";

const STORE = "cedarville:last-capture";
const SECTIONS = "cedarville:last-sections";
const VIEWS = { requirements: tree, overlap, schedule } as const;
type ViewName = keyof typeof VIEWS;

let mounted: { destroy(): void } | null = null;
let trees: ProgramTree[] = [];
let sectionData: TermCatalog | undefined;

const status = $("#status");
function say(text: string, bad = false) {
  status.textContent = text;
  status.className = bad ? "err" : "";
}

function showView(name: ViewName) {
  mounted?.destroy();
  mounted = VIEWS[name].mount($("#outlet"), { trees, sections: sectionData });
  for (const button of Array.from($("#tabs").querySelectorAll("button"))) {
    button.classList.toggle("on", button.dataset.view === name);
  }
}

function show(snapshot: Capture) {
  trees = Object.values(snapshot.evaluations).map(normalize);
  $("#who").textContent =
    `student ${snapshot.studentId} · captured ${new Date(snapshot.capturedAt).toLocaleString()}`;
  $("#tabs").hidden = false;
  showView("requirements");
}

$("#tabs").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest("button");
  if (button?.dataset.view) showView(button.dataset.view as ViewName);
});

$("#capture").addEventListener("click", async () => {
  const button = $<HTMLButtonElement>("#capture");
  const select = $<HTMLSelectElement>("#whatif");
  button.disabled = true;
  say("evaluating… a few seconds per program");
  try {
    const snapshot = await capture(select.value ? [select.value] : []);
    localStorage.setItem(STORE, JSON.stringify(snapshot));
    void dumpForDev("evaluations", snapshot);
    show(snapshot);
    say(`captured ${Object.keys(snapshot.evaluations).length} programs`);
  } catch (err) {
    say(err instanceof Error ? err.message : String(err), true);
  } finally {
    button.disabled = false;
  }
});

/**
 * Every course that could still close a requirement. This is what keeps the
 * section fetch to a couple of hundred requests instead of the whole catalog.
 */
function candidateCourseIds(): string[] {
  const ids = new Set<string>();
  for (const t of trees) {
    for (const { group } of openGroups(t)) {
      for (const id of enumeratedCourseIds(group) ?? []) ids.add(id);
    }
  }
  return [...ids];
}

let crawling: AbortController | null = null;

function showProgress(p: Progress | null) {
  const box = $("#progress-bar");
  box.hidden = p === null;
  $("#cancel").hidden = p === null;
  if (!p) return;

  const bar = $<HTMLProgressElement>("#bar");
  bar.value = p.done;
  bar.max = Math.max(p.total, 1);
  $("#progress-text").textContent =
    `${p.done}/${p.total}${p.current ? `  ${p.current}` : ""}` +
    (p.cached ? `  ·  ${p.cached} already cached` : "");
}

$("#cancel").addEventListener("click", () => crawling?.abort());

$("#load-sections").addEventListener("click", async () => {
  const button = $<HTMLButtonElement>("#load-sections");
  const term = $<HTMLSelectElement>("#term").value;
  if (!term) return say("pick a term first", true);

  const courseIds = candidateCourseIds();
  if (courseIds.length === 0) return say("capture your requirements first", true);

  button.disabled = true;
  crawling = new AbortController();
  say("checking the shared cache…");

  try {
    // Anything another student already fetched costs this one nothing.
    const have = (await fetchCached(term, courseIds)) ?? undefined;
    const catalog = await crawl({
      courseIds,
      term,
      have,
      signal: crawling.signal,
      onProgress: showProgress,
    });

    sectionData = catalog;
    localStorage.setItem(SECTIONS, JSON.stringify(catalog));
    void publishCached(catalog);
    void dumpForDev("catalog", catalog);
    showView("schedule");

    const offered = Object.keys(catalog.sections).length;
    say(`${offered} courses offered in ${term}, ${catalog.notOffered.length} not taught`);
  } catch (err) {
    say(
      err instanceof Cancelled ? "cancelled" : String(err instanceof Error ? err.message : err),
      err instanceof Cancelled ? false : true,
    );
  } finally {
    showProgress(null);
    crawling = null;
    button.disabled = false;
  }
});

async function init() {
  // Re-render the last capture immediately, so a reload costs nothing while
  // the logic is still changing every few minutes.
  const cachedSections = localStorage.getItem(SECTIONS);
  if (cachedSections) {
    try {
      sectionData = JSON.parse(cachedSections) as TermCatalog;
    } catch {
      localStorage.removeItem(SECTIONS);
    }
  }

  const cached = localStorage.getItem(STORE);
  if (cached) {
    try {
      show(JSON.parse(cached) as Capture);
      say("showing your last capture");
    } catch {
      localStorage.removeItem(STORE);
    }
  }

  if (!installed()) {
    say("install the bridge extension, then reload this page", true);
    return;
  }

  try {
    const list = await programs();
    const select = $<HTMLSelectElement>("#whatif");
    const active = list.filter((p) => p.IsActive).sort((x, y) => x.Title.localeCompare(y.Title));
    for (const p of active) select.add(new Option(`${p.Title} (${p.Code})`, p.Code));
    select.disabled = false;
    $<HTMLButtonElement>("#capture").disabled = false;

    const termSelect = $<HTMLSelectElement>("#term");
    const available = await terms();
    for (const t of available) termSelect.add(new Option(t.description, t.code));
    // Colleague lists terms oldest first; the one you are planning is last.
    if (available.length) termSelect.value = available[available.length - 1]!.code;
    termSelect.disabled = false;
    $<HTMLButtonElement>("#load-sections").disabled = false;

    if (!cached) say(`${active.length} programs available`);
  } catch (err) {
    say(err instanceof Error ? err.message : String(err), true);
  }
}

// Surfaces a blank page as a message instead of a silent nothing.
window.addEventListener("error", (e) => say(`crashed: ${e.message}`, true));

init();
