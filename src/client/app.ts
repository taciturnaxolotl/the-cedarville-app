/*
 * The shell. Owns the capture controls and swaps one of two views into
 * #outlet; each view exports mount(root, trees) -> { destroy }.
 *
 * Everything below this line runs on the student's own machine against data
 * their own browser fetched. There is no API call in this file and no server
 * to send anything to, which is what keeps an academic record out of scope.
 */

import type { Capture } from "../content";
import { normalize, type ProgramTree } from "../requirements";
import { capture, dumpForDev, installed, programs } from "./bridge";
import { $ } from "./dom";
import * as overlap from "./views/overlap";
import * as tree from "./views/tree";

const STORE = "cedarville:last-capture";
const VIEWS = { requirements: tree, overlap } as const;
type ViewName = keyof typeof VIEWS;

let mounted: { destroy(): void } | null = null;
let trees: ProgramTree[] = [];

const status = $("#status");
function say(text: string, bad = false) {
  status.textContent = text;
  status.className = bad ? "err" : "";
}

function showView(name: ViewName) {
  mounted?.destroy();
  mounted = VIEWS[name].mount($("#outlet"), trees);
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
    void dumpForDev(snapshot);
    show(snapshot);
    say(`captured ${Object.keys(snapshot.evaluations).length} programs`);
  } catch (err) {
    say(err instanceof Error ? err.message : String(err), true);
  } finally {
    button.disabled = false;
  }
});

async function init() {
  // Re-render the last capture immediately, so a reload costs nothing while
  // the logic is still changing every few minutes.
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
    if (!cached) say(`${active.length} programs available`);
  } catch (err) {
    say(err instanceof Error ? err.message : String(err), true);
  }
}

// Surfaces a blank page as a message instead of a silent nothing.
window.addEventListener("error", (e) => say(`crashed: ${e.message}`, true));

init();
