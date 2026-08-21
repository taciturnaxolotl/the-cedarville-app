/**
 * The bridge, and the whole reason the extension exists.
 *
 * The app page cannot reach Self-Service itself: it is a different origin and
 * has none of the session. So it asks here, and this forwards the request to
 * a content script running inside a real Self-Service tab.
 *
 * Only origins listed under `externally_connectable` in the manifest can send
 * anything, and nothing is ever pushed the other way.
 *
 * One thing does travel further than the page. A capture is also offered to a
 * companion on 127.0.0.1, if the student is running one, so their own tools
 * can read their own record without the planner's server ever seeing it. That
 * is the only address it is offered to, and the offer fails quietly when
 * nothing is listening.
 */

import { ORIGIN } from "./client";
import type { Capture, Reply, Request } from "./content";
import { APP_ORIGIN, COMPANION } from "./where";

const SELF_SERVICE_TAB = `${ORIGIN}/Student/*`;
const APP_URL = `${APP_ORIGIN}/`;

/** Clicking the icon opens the planner rather than a cramped popup. */
chrome.action.onClicked.addListener(async () => {
  const [existing] = await chrome.tabs.query({ url: `${APP_URL}*` });
  if (existing?.id) await chrome.tabs.update(existing.id, { active: true });
  else await chrome.tabs.create({ url: APP_URL });
});

/**
 * A Self-Service tab the content script is already living in. We deliberately
 * do not create one: signing in is the student's business, and a background
 * script silently opening their SIS is exactly the behaviour that makes
 * extensions untrustworthy.
 */
async function selfServiceTab(): Promise<number> {
  const tabs = await chrome.tabs.query({ url: SELF_SERVICE_TAB });
  const id = tabs.find((t) => t.id !== undefined)?.id;
  if (id === undefined) {
    throw new Error("open and sign in to selfservice.cedarville.edu in another tab");
  }
  return id;
}

/**
 * Hands a capture to the student's own machine, and nowhere else.
 *
 * Fire and forget on purpose: not running a companion is the ordinary case,
 * and a planner that failed a capture because a local port was closed would
 * be broken for almost everybody.
 */
async function offerToCompanion(path: "capture" | "picks", body: unknown): Promise<boolean> {
  try {
    const res = await fetch(`${COMPANION}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    /* No companion is running, which is fine and usual. */
    return false;
  }
}

chrome.runtime.onMessageExternal.addListener((msg: Request, _sender, reply) => {
  (async (): Promise<Reply<unknown>> => {
    try {
      // Picks never leave for Self-Service; they are only passing through on
      // the way to the student's own machine.
      if (msg.type === "picks") {
        const sent = await offerToCompanion("picks", msg.picks);
        return sent ? { ok: true, data: true } : { ok: false, error: "no companion is running" };
      }

      const answer: Reply<unknown> = await chrome.tabs.sendMessage(await selfServiceTab(), msg);
      if (msg.type === "capture" && answer.ok)
        void offerToCompanion("capture", answer.data as Capture);
      return answer;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // A missing receiver means the tab exists but predates the extension.
      return error.includes("Receiving end does not exist")
        ? { ok: false, error: "reload your Self-Service tab, then try again" }
        : { ok: false, error };
    }
  })().then(reply);

  return true; // keep the channel open for the async reply
});
