/**
 * The app's half of the extension bridge.
 *
 * The extension id is pinned by the `key` field in the manifest, so it stays
 * the same on every machine and across reloads. Without that pin an unpacked
 * extension gets a fresh random id each install and this could not address it.
 */

import { emptyCatalog, type TermCatalog } from "../catalog";
import { programsIn } from "../client";
import type { Applied, Capture, ColleaguePlan, Reply, ReplyMap, Request } from "../content";
import type { SearchCriteria, SearchPage } from "../crawl";
import { ALL_COURSES } from "../crawl";
import type { Change } from "../sync";
import type { ProgramSummary } from "../types";
import { EXTENSION_ID } from "../where";

export { EXTENSION_ID };

/** `chrome.runtime` appears on the page only when a connectable extension is installed. */
interface Runtime {
  sendMessage: (id: string, msg: Request, cb: (r: Reply<unknown>) => void) => void;
  lastError?: { message?: string };
}

const runtimeOf = () => (globalThis as { chrome?: { runtime?: Runtime } }).chrome?.runtime;

export class BridgeError extends Error {}

export const installed = () => Boolean(runtimeOf()?.sendMessage);

/**
 * Async so that "no extension here" is a rejection rather than a throw.
 *
 * It used to throw synchronously, which looks identical until you write the
 * obvious thing: `send(...).catch(...)` never sees it, because the throw
 * happens before there is a promise to attach to. One call site had grown a
 * comment explaining the workaround and another had quietly lost the rest of
 * its handler to it — the export button copied nothing to the clipboard on
 * any machine without the extension.
 */
async function send<K extends Request["type"]>(msg: Request & { type: K }): Promise<ReplyMap[K]> {
  const runtime = runtimeOf();
  if (!runtime?.sendMessage) {
    throw new BridgeError(
      "the bridge extension is not installed here, or this page is not one it is allowed to talk to",
    );
  }

  return new Promise((resolve, reject) => {
    runtime.sendMessage(EXTENSION_ID, msg, (reply) => {
      // Set when the extension is absent or refused the connection.
      const disconnect = runtime.lastError?.message;
      if (disconnect) return reject(new BridgeError(disconnect));
      if (!reply) {
        return reject(new BridgeError("the extension did not answer; try reloading this page"));
      }
      if (!reply.ok) return reject(new BridgeError(reply.error));
      resolve(reply.data as ReplyMap[K]);
    });
  });
}

export const ping = () => send({ type: "ping" });

/**
 * The build of the extension the planner was built alongside.
 *
 * Baked in rather than fetched, because the two are released together: the
 * page knows which bridge it expects, and `bridgeVersion` says which one
 * answered. When they differ, the student needs the newer bundle.
 */
export const BRIDGE_VERSION = process.env.BRIDGE_VERSION ?? "";

/** What the installed extension calls itself. Needs no Self-Service tab. */
export const bridgeVersion = () => send({ type: "version" });
export const terms = () => send({ type: "terms" });
/**
 * Every program the school offers.
 *
 * Normalised again on this side, even though the extension already does it:
 * the content script answering is whatever was loaded into that Self-Service
 * tab, which can be an older build than the page asking. A tab left open since
 * this morning is the ordinary case, not the exotic one, and the symptom was
 * "list.filter is not a function" on a page that looked fine.
 */
export const programs = async (): Promise<ProgramSummary[]> =>
  programsIn(await send({ type: "programs" }));
export const capture = (whatIf: string[] = []): Promise<Capture> =>
  send({ type: "capture", whatIf });

/**
 * Hands the student's choices to their own machine, through the one channel
 * that is allowed to reach it. Rejects when no companion is listening, which
 * is the ordinary case and worth saying out loud rather than swallowing.
 */
export const sendPicks = (picks: unknown): Promise<true> => send({ type: "picks", picks });

/** Colleague's own degree plan. A read, and the basis for any sync. */
export const colleaguePlan = (): Promise<ColleaguePlan> => send({ type: "colleaguePlan" });

/**
 * Writes the changes to Colleague. The only call in this file that changes
 * anything a registrar can see, so it is never made without asking first.
 */
export const applyPlan = (changes: Change[]): Promise<Applied> =>
  send({ type: "applyPlan", changes });

/**
 * A `Searcher` that reads the catalog through the student's own session.
 *
 * This is the whole of what the pivot to user crawls needed on this side.
 * The crawl loop in `src/crawl.ts` asks for one method, and this is that
 * method with an extension hop in the middle, so every crawl the server used
 * to run anonymously now runs here instead and the loop does not know the
 * difference.
 */
export const searcher = {
  search: (criteria: SearchCriteria): Promise<SearchPage> => send({ type: "search", criteria }),
};

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
export async function fetchAllCourses(): Promise<TermCatalog> {
  const empty = emptyCatalog(ALL_COURSES);
  try {
    const res = await fetch(`/catalog/${ALL_COURSES}`);
    // Carried whole rather than reduced to its courses, because when it was
    // last crawled decides whether to crawl it again.
    return res.ok ? ((await res.json()) as TermCatalog) : empty;
  } catch {
    return empty;
  }
}

export interface CatalogStatus {
  terms: { term: string; sections: number; courses: number; fetchedAt: string }[];
  refreshing: string[];
}

export const catalogStatus = async (): Promise<CatalogStatus> =>
  (await fetch("/catalog")).json() as Promise<CatalogStatus>;

/**
 * Offers a crawl this browser performed to the shared cache.
 *
 * The one write in this file that other students read, so it is the one the
 * server is entitled to refuse: a crawl that stopped early, or that would
 * shrink a term, is turned down and the reason logged there. Returns whether
 * it was accepted, and never throws, because the sections are already in hand
 * either way and a student who crawled a term should not be shown an error
 * about somebody else's cache.
 */
export async function offerCatalog(catalog: TermCatalog & { complete: boolean }): Promise<boolean> {
  try {
    const res = await fetch(`/catalog/${encodeURIComponent(catalog.term)}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(catalog),
    });
    if (!res.ok) {
      const { error } = (await res.json()) as { error?: string };
      console.warn(`the server declined the crawl: ${error ?? res.status}`);
    }
    return res.ok;
  } catch {
    return false;
  }
}

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
