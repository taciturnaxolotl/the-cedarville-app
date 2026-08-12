/**
 * The app's half of the extension bridge.
 *
 * The extension id is pinned by the `key` field in the manifest, so it stays
 * the same on every machine and across reloads. Without that pin an unpacked
 * extension gets a fresh random id each install and this could not address it.
 */

import type { Capture, Reply, ReplyMap, Request } from "../content";
import type { ProgramSummary } from "../types";

export const EXTENSION_ID = "dijggphdklmdeegidljleaogedbahpjo";

/** `chrome.runtime` appears on the page only when a connectable extension is installed. */
interface Runtime {
  sendMessage: (id: string, msg: Request, cb: (r: Reply<unknown>) => void) => void;
  lastError?: { message?: string };
}

const runtimeOf = () => (globalThis as { chrome?: { runtime?: Runtime } }).chrome?.runtime;

export class BridgeError extends Error {}

export const installed = () => Boolean(runtimeOf()?.sendMessage);

function send<K extends Request["type"]>(msg: Request & { type: K }): Promise<ReplyMap[K]> {
  const runtime = runtimeOf();
  if (!runtime?.sendMessage) {
    throw new BridgeError("extension not installed, or this origin is not whitelisted");
  }

  return new Promise((resolve, reject) => {
    runtime.sendMessage(EXTENSION_ID, msg, (reply) => {
      // Set when the extension is absent or refused the connection.
      const disconnect = runtime.lastError?.message;
      if (disconnect) return reject(new BridgeError(disconnect));
      if (!reply) return reject(new BridgeError("no reply from the extension"));
      if (!reply.ok) return reject(new BridgeError(reply.error));
      resolve(reply.data as ReplyMap[K]);
    });
  });
}

export const ping = () => send({ type: "ping" });
export const terms = () => send({ type: "terms" });
export const sections = (courseIds: string[], term: string) =>
  send({ type: "sections", courseIds, term });
export const programs = (): Promise<ProgramSummary[]> => send({ type: "programs" });
export const capture = (whatIf: string[] = []): Promise<Capture> =>
  send({ type: "capture", whatIf });

/**
 * Hands a capture to the local dev server, which writes it to .data/ so the
 * agent working on this code can read a real response instead of guessing at
 * the schema. Localhost only, gitignored, and a no-op anywhere else.
 */
export async function dumpForDev(snapshot: unknown): Promise<void> {
  if (location.hostname !== "localhost") return;
  try {
    await fetch("/dev/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(snapshot),
    });
  } catch {
    // The dev server is optional; never let it break a capture.
  }
}
