/**
 * Serves the planner and the shared section catalog.
 *
 * The split that matters: the catalog is public course data, fetched here
 * anonymously and cached in SQLite, so nobody's session is spent on it and
 * the registrar sees one crawl instead of one per student. A student's
 * evaluation is their record and never leaves their browser. There is no
 * account system because there is nothing here to attach to a person.
 *
 * So this server writes exactly one thing: the SQLite catalog cache. There
 * used to be a development route that dropped a capture on disk, guarded by
 * `NODE_ENV` and by the hostname the request arrived on — and a hostname is
 * a header the client sends, which makes it a guard that asks the attacker
 * whether they are an attacker. Hosting this anywhere meant shipping that.
 * A capture now goes where it always should have: the companion, on the
 * student's own machine, which the extension already hands every capture to.
 */

import { mkdir } from "node:fs/promises";
import { isStale } from "./src/catalog";
import { resolveGroup } from "./src/server/colleague";
import {
  ALL_COURSES,
  availableTerms,
  liveSeats,
  refreshAllCourses,
  refreshTerm,
} from "./src/server/crawler";
import { ingest } from "./src/server/ingest";
import { CatalogStore, type RuleKey, ruleKey } from "./src/server/store";

/**
 * Where to listen, and on which interface.
 *
 * Loopback by default, because the deployment this is written for puts a
 * reverse proxy in front: binding every interface there means the raw port
 * answers the internet alongside the proxy, with none of the proxy's
 * terminating, logging or rate limiting. `HOST=0.0.0.0` is the opt out, which
 * is what a container wants.
 */
const PORT = Number(process.env.PORT ?? 5173);
const HOST = process.env.HOST ?? "127.0.0.1";
const ROOT = "public";
/**
 * How often to *consider* refreshing, deliberately much shorter than how
 * stale a catalog is allowed to get. Ticking at exactly the staleness
 * threshold means the catalog is always a few seconds too young when the
 * timer fires, so every other cycle is skipped and the real cadence quietly
 * doubles.
 */
const TICK_MS = 30 * 60 * 1000;
const MAX_AGE_HOURS = 6;

await mkdir(".data", { recursive: true });
const store = new CatalogStore();

/** Terms already being fetched, so a reload cannot start a second crawl. */
const running = new Map<string, Promise<number>>();

/**
 * A term code the catalog has actually heard of.
 *
 * Guards the crawl trigger. Terms are a closed set the registrar publishes,
 * so an arbitrary string is never a term, and accepting one meant any caller
 * could start an unlimited number of outbound crawls by inventing spellings.
 */
const known = (term: string): boolean =>
  term === ALL_COURSES || store.stats().some((row) => row.term === term);

function refresh(term: string): Promise<number> {
  const existing = running.get(term);
  if (existing) return existing;

  const job = refreshTerm(term, store, {
    onProgress: ({ page, pages, sections }) => {
      if (page % 10 === 0 || page === pages) {
        console.log(`  ${term}: page ${page}/${pages}, ${sections} sections`);
      }
    },
  })
    .then((n) => {
      console.log(n ? `${term}: cached ${n} sections` : `${term}: crawl empty, keeping old data`);
      return n;
    })
    .catch((err) => {
      console.warn(`${term}: crawl failed — ${err instanceof Error ? err.message : err}`);
      return 0;
    })
    .finally(() => running.delete(term));

  running.set(term, job);
  return job;
}

/**
 * A term of raw Colleague JSON is about ten megabytes, and it is extremely
 * repetitive, so it gzips to a small fraction of that. Bun.serve does no
 * compression of its own, and shipping ten megabytes to a page that then has
 * to parse it is the single slowest thing this app could do.
 */
function json(body: unknown, status = 200, accept = ""): Response {
  const text = JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };

  if (accept.includes("gzip") && text.length > 4096) {
    const zipped = Bun.gzipSync(text);
    headers["content-encoding"] = "gzip";
    headers.vary = "accept-encoding";
    return new Response(zipped, { status, headers });
  }
  return new Response(text, { status, headers });
}

async function api(request: Request, pathname: string): Promise<Response | null> {
  const accept = request.headers.get("accept-encoding") ?? "";
  if (pathname === "/catalog" && request.method === "GET") {
    return json({
      terms: store.stats(),
      refreshing: [...running.keys()],
      rules: store.ruleCount(),
    });
  }

  /**
   * A term, crawled by a student and offered to everybody.
   *
   * The server cannot read the catalog any more: Cedarville put it behind
   * SSO, so the only session that can page it belongs to a browser. This is
   * where that crawl lands. Every guard on it lives in `ingest`, which is
   * worth reading before changing anything here.
   */
  const ingestTerm = /^\/catalog\/([^/]+)\/ingest$/.exec(pathname)?.[1];
  if (ingestTerm && request.method === "POST") {
    const term = decodeURIComponent(ingestTerm);
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return json({ error: "not json" }, 400);
    }
    // The term is named twice, in the path and in the body, so say which one
    // disagreed rather than silently trusting either.
    if ((raw as { term?: string })?.term !== term) {
      return json({ error: `body is for ${(raw as { term?: string })?.term}, not ${term}` }, 400);
    }

    const verdict = ingest(store, raw);
    if (!verdict.ok) {
      console.warn(`${term}: refused a crawl — ${verdict.why}`);
      return json({ error: verdict.why }, 422);
    }
    console.log(
      `${term}: ingested ${verdict.sections} sections and ${verdict.courses} courses` +
        (verdict.replaced ? " (replacing what was held)" : " (first crawl of this term)"),
    );
    return json(verdict);
  }

  /**
   * Re-crawl from the server, which only works while a guest endpoint does.
   * Kept because it is how the catalog gets filled anywhere Self-Service is
   * still open, and because it fails loudly rather than pretending.
   */
  const refreshTermCode = /^\/catalog\/([^/]+)\/refresh$/.exec(pathname)?.[1];
  if (refreshTermCode && request.method === "POST") {
    const term = decodeURIComponent(refreshTermCode);
    // Only a term the catalog already knows, or one a crawl has listed. An
    // arbitrary string used to start its own crawl, and the dedupe map keys
    // on the string, so N spellings of one term meant N crawls.
    if (!known(term)) return json({ error: `unknown term ${term}` }, 404);
    void refresh(term);
    return json({ refreshing: term }, 202);
  }

  const seatsTerm = /^\/catalog\/([^/]+)\/seats$/.exec(pathname)?.[1];
  if (seatsTerm && request.method === "GET") {
    const courses = new URL(request.url).searchParams.get("courses");
    if (!courses) return json({});
    try {
      // Deliberately uncached: a stale seat count is worse than a slow one.
      return json(await liveSeats(decodeURIComponent(seatsTerm), courses.split(",")), 200, accept);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  }

  const term = /^\/catalog\/([^/]+)$/.exec(pathname)?.[1];
  if (term && request.method === "GET") {
    const wanted = new URL(request.url).searchParams.get("courses");
    return json(
      store.read(decodeURIComponent(term), wanted ? wanted.split(",") : undefined),
      200,
      accept,
    );
  }

  /**
   * Resolve requirement groups whose eligible courses Colleague keeps inside a
   * rule. The client sends catalog coordinates, never a transcript; the answer
   * is identical for every student, so it is cached and shared.
   */
  if (pathname === "/rules/resolve" && request.method === "POST") {
    const keys = (await request.json()) as RuleKey[];
    if (!Array.isArray(keys) || keys.length > 60) return json({ error: "send 1-60 groups" }, 400);

    const known = store.readRules(keys);
    const missing = keys.filter((k) => !known.has(ruleKey(k)));

    for (const key of missing) {
      try {
        const courses = await resolveGroup(key);
        store.writeRule(key, courses);
        known.set(ruleKey(key), courses);
      } catch (err) {
        console.warn(`rule ${ruleKey(key)}: ${err instanceof Error ? err.message : err}`);
      }
      if (missing.length > 1) await new Promise((r) => setTimeout(r, 150));
    }
    if (missing.length)
      console.log(`resolved ${missing.length} rule groups (${store.ruleCount()} cached)`);
    return json(Object.fromEntries(known), 200, accept);
  }

  return null;
}

Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(request) {
    const { pathname } = new URL(request.url);

    const handled = await api(request, pathname);
    if (handled) return handled;

    const path = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
    // URL parsing folds away "..", but percent-encoded ones survive it.
    if (path.includes("..")) return new Response("no", { status: 400 });

    const file = Bun.file(ROOT + path);
    return (await file.exists())
      ? new Response(file, { headers: { "cache-control": "no-store" } })
      : new Response("not found", { status: 404 });
  },
});

console.log(`planner on http://${HOST}:${PORT}`);
for (const row of store.stats()) {
  console.log(`  ${row.term}: ${row.sections} sections, ${row.courses} courses, ${row.fetchedAt}`);
}

/** Refresh anything stale on boot, then keep it warm. */
async function keepWarm() {
  try {
    // What *exists*, separate from what is offered: a prerequisite is often a
    // course nobody teaches this year, and without it the graph loses a third
    // of its depth.
    if (isStale(store.read(ALL_COURSES), MAX_AGE_HOURS * 28)) {
      const n = await refreshAllCourses(store, {
        onProgress: ({ page, pages, sections }) => {
          if (page % 10 === 0 || page === pages) {
            console.log(`  catalog: page ${page}/${pages}, ${sections} courses`);
          }
        },
      });
      if (n) console.log(`catalog: ${n} courses (every course, not just this term's)`);
    }

    for (const { code } of await availableTerms()) {
      if (isStale(store.read(code), MAX_AGE_HOURS)) await refresh(code);
    }
  } catch (err) {
    console.warn(`term list unavailable — ${err instanceof Error ? err.message : err}`);
  }
}

if (process.env.CRAWL !== "off") {
  void keepWarm();
  setInterval(keepWarm, TICK_MS);
}
