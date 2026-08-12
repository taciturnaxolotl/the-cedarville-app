/**
 * The bridge, and the whole reason the extension exists.
 *
 * The app page cannot reach Self-Service itself: it is a different origin and
 * has none of the session. So it asks here, and this forwards the request to
 * a content script running inside a real Self-Service tab.
 *
 * Only origins listed under `externally_connectable` in the manifest can send
 * anything, and nothing is ever pushed the other way.
 */

import { ORIGIN } from "./client";
import type { Reply, Request } from "./content";

const SELF_SERVICE_TAB = `${ORIGIN}/Student/*`;
const APP_URL = "http://localhost:5173/";

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

chrome.runtime.onMessageExternal.addListener((msg: Request, _sender, reply) => {
  (async (): Promise<Reply<unknown>> => {
    try {
      return await chrome.tabs.sendMessage(await selfServiceTab(), msg);
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
