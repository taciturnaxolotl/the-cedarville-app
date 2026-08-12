/**
 * Serves the planner and the shared section cache.
 *
 * The split that matters: the catalog is school-wide public data and lives in
 * SQLite here, so one student's crawl spares everyone else's; a student's
 * evaluation is their record and never leaves their browser. There is no
 * account system because there is nothing here to attach to a person.
 *
 * POST /dev/capture is the exception, and it is localhost-only and
 * gitignored: it drops the last capture on disk so an agent working on this
 * repo can read a real Colleague response instead of guessing at the schema.
 */

import { mkdir } from "node:fs/promises";
import type { TermCatalog } from "./src/catalog";
import { CatalogStore } from "./src/server/store";

const PORT = 5173;
const ROOT = "public";
const dev = process.env.NODE_ENV !== "production";

await mkdir(".data", { recursive: true });
const store = new CatalogStore();

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

async function api(request: Request, pathname: string): Promise<Response | null> {
  const term = /^\/catalog\/([^/]+)$/.exec(pathname)?.[1];

  if (term && request.method === "GET") {
    const wanted = new URL(request.url).searchParams.get("courses");
    return json(store.read(decodeURIComponent(term), wanted ? wanted.split(",") : undefined));
  }

  if (term && request.method === "PUT") {
    const body = (await request.json()) as TermCatalog;
    if (body.term !== decodeURIComponent(term)) return json({ error: "term mismatch" }, 400);
    const written = store.write(body);
    console.log(`cached ${written} courses for ${body.term}`);
    return json({ written });
  }

  if (pathname === "/catalog" && request.method === "GET") return json(store.stats());

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

for (const row of store.stats()) {
  console.log(`  cached ${row.term}: ${row.courses} courses, ${row.offered} offered`);
}
console.log(`planner on http://localhost:${PORT}`);
