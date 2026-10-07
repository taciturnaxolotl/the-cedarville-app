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

// Any page on the origin, not just /Student/*: after SSO a student can land on
// the root or on /Student with no trailing slash, and the content script is
// living in all of them. Matching only /Student/* reported "not signed in" to
// someone who plainly was.
const SELF_SERVICE_TAB = `${ORIGIN}/*`;
const APP_URL = `${APP_ORIGIN}/`;

/** Clicking the icon opens the planner rather than a cramped popup. */
chrome.action.onClicked.addListener(async () => {
  const [existing] = await chrome.tabs.query({ url: `${APP_URL}*` });
  if (existing?.id) await chrome.tabs.update(existing.id, { active: true });
  else await chrome.tabs.create({ url: APP_URL });
});

/**
 * Sends a request to a Self-Service tab whose content script is actually
 * listening, and returns its reply.
 *
 * There can be several tabs on the origin — a signed-in /Student page, the bare
 * root the SSO dance lands on, something left open since before the extension
 * updated — and only some are running this build's content script. Picking the
 * first tab blindly meant one stale tab could mask a perfectly good one, so we
 * try each in turn. Deeper /Student pages come first, being the likeliest to
 * hold a live script.
 *
 * Retrying is safe even for a write: "Receiving end does not exist" means the
 * tab received nothing, so moving on cannot apply a plan twice. We deliberately
 * do not open a tab ourselves: signing in is the student's business.
 */
async function sendToSelfService(msg: Request): Promise<Reply<unknown>> {
  const tabs = await chrome.tabs.query({ url: SELF_SERVICE_TAB });
  const ids = tabs
    .map((t) => ({ id: t.id, deep: (t.url ?? "").includes("/Student/") }))
    .filter((t): t is { id: number; deep: boolean } => t.id !== undefined)
    .sort((a, b) => Number(b.deep) - Number(a.deep))
    .map((t) => t.id);

  if (ids.length === 0) {
    throw new Error("open and sign in to selfservice.cedarville.edu in another tab");
  }

  for (const id of ids) {
    try {
      return await chrome.tabs.sendMessage(id, msg);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // No content script in this tab; nothing was delivered, so try the next.
      if (reason.includes("Receiving end does not exist")) continue;
      throw err;
    }
  }
  throw new Error("reload your Self-Service tab, then try again");
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
      // Neither of these troubles Self-Service. The version is this file's
      // own, and picks are only passing through on the way to the student's
      // own machine.
      if (msg.type === "version") {
        return { ok: true, data: chrome.runtime.getManifest().version };
      }
      if (msg.type === "picks") {
        const sent = await offerToCompanion("picks", msg.picks);
        return sent ? { ok: true, data: true } : { ok: false, error: "no companion is running" };
      }

      const answer: Reply<unknown> = await sendToSelfService(msg);
      if (msg.type === "capture" && answer.ok)
        void offerToCompanion("capture", answer.data as Capture);
      return answer;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { ok: false, error };
    }
  })().then(reply);

  return true; // keep the channel open for the async reply
});
