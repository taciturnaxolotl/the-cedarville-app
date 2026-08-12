/**
 * Serves public/ and nothing else in anger. There is no database and no
 * account system on purpose: the page holds a student's academic record, so
 * the only copy lives in their own browser.
 *
 * The one exception is POST /dev/capture, which writes the last capture to
 * .data/ on this machine. That exists so an agent editing this repo can read
 * a real Colleague response instead of inferring the schema — every bug found
 * so far came from real data disagreeing with a guess. It is localhost-only,
 * gitignored, and absent from any deployed build.
 */

import { mkdir } from "node:fs/promises";

const PORT = 5173;
const ROOT = "public";
const DEV_DUMP = ".data/capture.json";
const dev = process.env.NODE_ENV !== "production";

async function handle(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (dev && request.method === "POST" && pathname === "/dev/capture") {
    const body = await request.text();
    await mkdir(".data", { recursive: true });
    await Bun.write(DEV_DUMP, body);
    console.log(`wrote ${DEV_DUMP} (${(body.length / 1024).toFixed(0)}kb)`);
    return new Response(null, { status: 204 });
  }

  const path = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  // URL parsing folds away "..", but percent-encoded ones survive it.
  if (path.includes("..")) return new Response("no", { status: 400 });

  const file = Bun.file(ROOT + path);
  return (await file.exists())
    ? new Response(file, { headers: { "cache-control": "no-store" } })
    : new Response("not found", { status: 404 });
}

Bun.serve({ port: PORT, fetch: handle });

console.log(`planner on http://localhost:${PORT}${dev ? `  ·  captures land in ${DEV_DUMP}` : ""}`);
