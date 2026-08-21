/**
 * The app's half of the extension bridge.
 *
 * The extension id is pinned by the `key` field in the manifest, so it stays
 * the same on every machine and across reloads. Without that pin an unpacked
 * extension gets a fresh random id each install and this could not address it.
 */

import type { TermCatalog } from "../catalog";
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
export const programs = (): Promise<ProgramSummary[]> => send({ type: "programs" });
export const capture = (whatIf: string[] = []): Promise<Capture> =>
  send({ type: "capture", whatIf });

/**
 * Hands the student's choices to their own machine, through the one channel
 * that is allowed to reach it. Rejects when no companion is listening, which
 * is the ordinary case and worth saying out loud rather than swallowing.
 */
export const sendPicks = (picks: unknown): Promise<true> => send({ type: "picks", picks });

/**
 * Hands a capture to the local dev server, which writes it to .data/ so the
 * agent working on this code can read a real response instead of guessing at
 * the schema. Localhost only, gitignored, and a no-op anywhere else.
 */
export async function dumpForDev(name: string, snapshot: unknown): Promise<void> {
  // Optional by design, and never worth throwing over: a fire-and-forget
  // helper that raises synchronously takes its caller down with it.
  if (globalThis.location?.hostname !== "localhost") return;
  try {
    await fetch(`/dev/capture?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(snapshot),
    });
  } catch {
    // The dev server is optional; never let it break a capture.
  }
}

// ---- the shared catalog cache -----------------------------------------

/**
 * The term's sections, fetched by the server from the public course search.
 * No session is spent here and none is needed: this is the same timetable
 * every student sees.
 */
export async function fetchCatalog(term: string, courseIds?: string[]): Promise<TermCatalog> {
  const query = courseIds?.length ? `?courses=${encodeURIComponent(courseIds.join(","))}` : "";
  const res = await fetch(`/catalog/${encodeURIComponent(term)}${query}`);
  if (!res.ok) throw new Error(`catalog unavailable (${res.status})`);
  return (await res.json()) as TermCatalog;
}

/** Every course the school lists, offered or not. The graph needs all of them. */
export async function fetchAllCourses(): Promise<TermCatalog["courses"]> {
  try {
    const res = await fetch("/catalog/ALL");
    return res.ok ? ((await res.json()) as TermCatalog).courses : [];
  } catch {
    return [];
  }
}

export interface CatalogStatus {
  terms: { term: string; sections: number; courses: number; fetchedAt: string }[];
  refreshing: string[];
}

export const catalogStatus = async (): Promise<CatalogStatus> =>
  (await fetch("/catalog")).json() as Promise<CatalogStatus>;

/** Asks the server to re-crawl. Returns immediately; the crawl runs on. */
export const refreshCatalog = (term: string) =>
  fetch(`/catalog/${encodeURIComponent(term)}/refresh`, { method: "POST" });

/** Current availability for the courses on screen. Never cached. */
export async function liveSeats(
  term: string,
  courseIds: string[],
): Promise<Record<string, { available: number; capacity: number; status: string }>> {
  if (courseIds.length === 0) return {};
  const query = `?courses=${encodeURIComponent(courseIds.join(","))}`;
  const res = await fetch(`/catalog/${encodeURIComponent(term)}/seats${query}`);
  if (!res.ok) throw new Error(`seat counts unavailable (${res.status})`);
  return res.json() as Promise<
    Record<string, { available: number; capacity: number; status: string }>
  >;
}

/**
 * Expands requirement groups whose eligible courses Colleague keeps inside a
 * rule. Sends catalog coordinates only — never a transcript — and the server
 * caches the answer, which is the same for every student.
 */
export async function resolveRules(
  ids: { requirement: string; subrequirement: string; group: string }[],
): Promise<Record<string, string[]>> {
  if (ids.length === 0) return {};
  try {
    const res = await fetch("/rules/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ids.slice(0, 60)),
    });
    return res.ok ? ((await res.json()) as Record<string, string[]>) : {};
  } catch {
    // An unexpanded requirement is still shown; it just stays unplanned.
    return {};
  }
}
