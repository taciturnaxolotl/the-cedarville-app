/**
 * Serves the planner and the shared section catalog.
 *
 * The split that matters: the catalog is public course data, fetched here
 * anonymously and cached in SQLite, so nobody's session is spent on it and
 * the registrar sees one crawl instead of one per student. A student's
 * evaluation is their record and never leaves their browser. There is no
 * account system because there is nothing here to attach to a person.
 *
 * POST /dev/capture is the exception, localhost-only and gitignored: it drops
 * a capture on disk so an agent working on this repo can read a real
 * Colleague response instead of guessing at the schema.
 */

import { mkdir } from "node:fs/promises";
import { isStale } from "./src/catalog";
import { availableTerms, refreshTerm } from "./src/server/crawler";
import { CatalogStore } from "./src/server/store";

const PORT = 5173;
const ROOT = "public";
const REFRESH_EVERY_MS = 6 * 60 * 60 * 1000;
const dev = process.env.NODE_ENV !== "production";

await mkdir(".data", { recursive: true });
const store = new CatalogStore();

/** Terms already being fetched, so a reload cannot start a second crawl. */
const running = new Map<string, Promise<number>>();

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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

async function api(request: Request, pathname: string): Promise<Response | null> {
  if (pathname === "/catalog" && request.method === "GET") {
    return json({ terms: store.stats(), refreshing: [...running.keys()] });
  }

  const refreshTermCode = /^\/catalog\/([^/]+)\/refresh$/.exec(pathname)?.[1];
  if (refreshTermCode && request.method === "POST") {
    const term = decodeURIComponent(refreshTermCode);
    void refresh(term);
    return json({ refreshing: term }, 202);
  }

  const term = /^\/catalog\/([^/]+)$/.exec(pathname)?.[1];
  if (term && request.method === "GET") {
    const wanted = new URL(request.url).searchParams.get("courses");
    return json(store.read(decodeURIComponent(term), wanted ? wanted.split(",") : undefined));
  }

  if (dev && pathname === "/dev/capture" && request.method === "POST") {
    // Named, because evaluations and the catalog are different artifacts and
    // one file would mean the second dump silently ate the first.
    const raw = new URL(request.url).searchParams.get("name") ?? "capture";
    const name = raw.replace(/[^a-z0-9-]/gi, "") || "capture";
    const body = await request.text();
    await Bun.write(`.data/${name}.json`, body);
    console.log(`wrote .data/${name}.json (${(body.length / 1024).toFixed(0)}kb)`);
    return new Response(null, { status: 204 });
  }

  return null;
}

Bun.serve({
  port: PORT,
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

console.log(`planner on http://localhost:${PORT}`);
for (const row of store.stats()) {
  console.log(`  ${row.term}: ${row.sections} sections, ${row.courses} courses, ${row.fetchedAt}`);
}

/** Refresh anything stale on boot, then keep it warm. */
async function keepWarm() {
  try {
    for (const { code } of await availableTerms()) {
      if (isStale(store.read(code))) await refresh(code);
    }
  } catch (err) {
    console.warn(`term list unavailable — ${err instanceof Error ? err.message : err}`);
  }
}

if (process.env.CRAWL !== "off") {
  void keepWarm();
  setInterval(keepWarm, REFRESH_EVERY_MS);
}
