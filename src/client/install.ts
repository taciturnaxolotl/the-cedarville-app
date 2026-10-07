/*
 * The install page's one moving part.
 *
 * Everything else on that page is prose that is true whatever is installed.
 * This says which of the four steps the student is actually on: nothing
 * installed, something older than this planner, or done.
 */

import { BRIDGE_VERSION, bridgeVersion, installed } from "./bridge";
import { $ } from "./dom";

const say = (text: string, tone = "muted") => {
  const line = $("#version");
  line.textContent = text;
  line.className = tone;
};

async function report() {
  if (!BRIDGE_VERSION) return;
  if (!installed()) {
    say(`version ${BRIDGE_VERSION}`);
    return;
  }

  try {
    const theirs = await bridgeVersion();
    if (theirs === BRIDGE_VERSION) {
      say(`you already have ${theirs} installed, which is this one`, "ok");
      return;
    }
    say(
      `you have ${theirs} installed and this is ${BRIDGE_VERSION}; ` +
        "download it, then press the reload arrow on the old one at chrome://extensions",
      "err",
    );
  } catch {
    // Installed but not answering, which an older build does when it has
    // never heard of the question. That is itself the answer.
    say(
      `you have a bridge installed, older than this one (${BRIDGE_VERSION}); ` +
        "download it and reload the extension at chrome://extensions",
      "err",
    );
  }
}

void report();
