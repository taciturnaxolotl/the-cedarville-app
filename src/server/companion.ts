/**
 * The local half: the only process that ever holds a student's record.
 *
 * The catalog server can be deployed, because a section listing is the same
 * for everybody. An evaluation is not, and the promise this repo makes is that
 * it never leaves the machine it was fetched on. That promise used to be kept
 * by accident — the planner only ran on localhost, so the dev dump landed in
 * the repo — and an accident stops being kept the moment the page is hosted.
 *
 * So the handoff is explicit. The extension, which already has the capture and
 * a fixed identity, posts it to 127.0.0.1 and nowhere else. The MCP server
 * reads it from a user data directory rather than from whatever directory it
 * happened to be started in. Nothing here listens on a public interface,
 * nothing here talks to the internet, and if no companion is running the
 * extension's post fails and the planner carries on in the browser.
 */

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { COMPANION_PORT, EXTENSION_ORIGIN } from "../where";

/**
 * Where a capture lives.
 *
 * `CEDARVILLE_CAPTURE` first, so a student can put it on an encrypted volume
 * or point two tools at one file. Then the XDG data directory, which is a
 * real convention on Linux and a harmless one everywhere else. The repo's own
 * `.data` is last and is only a fallback for working on this code.
 */
export function capturePath(): string {
  const named = process.env.CEDARVILLE_CAPTURE;
  if (named) return named;
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "cedarville", "evaluations.json");
}

/**
 * The capture, wherever it is. Null when none has been handed over yet.
 *
 * The repo's own `.data` is consulted only when no path was named, so naming
 * one means exactly that one — which is how a test says "not the real file"
 * and is answered.
 */
export async function readCapture<T = unknown>(): Promise<T | null> {
  const paths = process.env.CEDARVILLE_CAPTURE
    ? [capturePath()]
    : [capturePath(), ".data/evaluations.json"];
  for (const path of paths) {
    const file = Bun.file(path);
    if (await file.exists()) return (await file.json()) as T;
  }
  return null;
}

export async function writeCapture(body: string): Promise<string> {
  const path = capturePath();
  await mkdir(join(path, ".."), { recursive: true });
  await Bun.write(path, body);
  return path;
}

const CORS = {
  "access-control-allow-origin": EXTENSION_ORIGIN,
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
} as const;

/**
 * Accepts a capture from the extension, and only from the extension.
 *
 * A browser sets `Origin` itself and a page cannot spoof it, so this rejects
 * every other tab on the machine. It does not defend against another program
 * on the same computer, and nothing bound to loopback can: a machine you do
 * not trust is already lost.
 *
 * Returns null when the port is taken, which is the normal way two MCP
 * clients start at once. The first one owns the socket; both read the file.
 */
export function serveCompanion(
  onCapture?: (path: string) => void,
  /** Overridden only by tests, which may not hold the real one. */
  port: number = COMPANION_PORT,
): { stop(): void; port: number } | null {
  try {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      async fetch(request) {
        const { pathname } = new URL(request.url);
        const origin = request.headers.get("origin");

        if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
        if (pathname !== "/capture" || request.method !== "POST") {
          return new Response("not found", { status: 404 });
        }
        if (origin !== EXTENSION_ORIGIN) {
          return new Response("only the extension may post a capture", { status: 403 });
        }

        const body = await request.text();
        try {
          JSON.parse(body);
        } catch {
          return new Response("not json", { status: 400, headers: CORS });
        }
        const path = await writeCapture(body);
        onCapture?.(path);
        return new Response("ok", { headers: CORS });
      },
    });
    return { stop: () => server.stop(true), port: server.port ?? port };
  } catch {
    // Already listening, which means a companion is already running.
    return null;
  }
}
