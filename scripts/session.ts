#!/usr/bin/env bun
/*
 * Saves a Self-Service session so authenticated queries can run from this
 * machine without clicking through the extension every time.
 *
 * This is a development convenience and deliberately not part of the app.
 * The server holds only the public catalog; the extension holds no
 * credentials at all. A session cookie is the student's whole account —
 * grades, aid, and the ability to register and drop classes — so it lives in
 * .data/ (gitignored, owner-readable) and is never sent anywhere.
 *
 *   Chrome devtools -> Network -> any XHR on selfservice.cedarville.edu
 *   -> right click -> Copy -> Copy as cURL, then:
 *
 *     pbpaste | bun scripts/session.ts save
 *     bun scripts/session.ts check
 */

import { chmod, mkdir } from "node:fs/promises";

const FILE = ".data/session.json";
const ORIGIN = "https://selfservice.cedarville.edu";

interface Session {
  cookie: string;
  savedAt: string;
}

/** Pulls the Cookie header out of a copied cURL command, or a bare header. */
export function extractCookie(input: string): string | null {
  const fromCurl =
    /-H\s+['"]cookie:\s*([^'"]+)['"]/i.exec(input) ??
    /-b\s+['"]([^'"]+)['"]/.exec(input) ??
    /^\s*cookie:\s*(.+)$/im.exec(input);
  const raw = (fromCurl?.[1] ?? (input.includes("=") && !input.includes("\n") ? input : "")).trim();
  if (!raw) return null;

  // Keep only what Self-Service authenticates with, so an entire browser's
  // cookie jar does not end up on disk.
  //
  // Matched by prefix, not exactly. ASP.NET splits a cookie too large for one
  // header into a base cookie plus numbered parts, and an exact match keeps
  // "studentselfservice_live_0" while dropping the "studentselfservice_live"
  // it belongs to. That yields a set which looks complete, saves without
  // complaint, and authenticates as nobody.
  const wanted = [
    ".aspxauth",
    "serverid",
    "studentselfservice_live",
    ".colleagueselfserviceantiforgery",
  ];
  const kept = raw
    .split(/;\s*/)
    .filter((pair) => {
      const name = (pair.split("=", 1)[0] ?? "").toLowerCase();
      return wanted.some((prefix) => name.startsWith(prefix));
    })
    .join("; ");
  return kept || null;
}

export async function load(): Promise<Session | null> {
  const file = Bun.file(FILE);
  return (await file.exists()) ? ((await file.json()) as Session) : null;
}

/** Does the session still work? The degree plan needs real authentication. */
export async function check(session: Session): Promise<string | null> {
  const res = await fetch(`${ORIGIN}/Student/Planning/DegreePlans/Current?studentId=`, {
    headers: {
      cookie: session.cookie,
      accept: "application/json",
      "x-requested-with": "XMLHttpRequest",
    },
    redirect: "manual",
  });
  if (res.status !== 200) return null;
  const body = await res.text();
  if (!body.trimStart().startsWith("{")) return null;
  return (JSON.parse(body)?.DegreePlan?.PersonId as string) ?? null;
}

if (import.meta.main) {
  const [command] = process.argv.slice(2);

  if (command === "save") {
    const cookie = extractCookie(await Bun.stdin.text());
    if (!cookie) {
      console.error("no Self-Service cookies found. Copy an XHR as cURL and pipe it in.");
      process.exit(1);
    }
    await mkdir(".data", { recursive: true });
    await Bun.write(FILE, JSON.stringify({ cookie, savedAt: new Date().toISOString() }, null, 2));
    await chmod(FILE, 0o600);

    const names = cookie.split(/;\s*/).map((p) => p.split("=", 1)[0]);
    console.log(`saved ${names.length} cookies to ${FILE} (0600): ${names.join(", ")}`);
    const who = await check({ cookie, savedAt: "" });
    console.log(
      who ? `works — signed in as ${who}` : "saved, but the session did not authenticate",
    );
    process.exit(who ? 0 : 1);
  }

  if (command === "check") {
    const session = await load();
    if (!session) {
      console.error(`no ${FILE}; run "pbpaste | bun scripts/session.ts save" first`);
      process.exit(1);
    }
    const who = await check(session);
    const age = ((Date.now() - Date.parse(session.savedAt)) / 60000).toFixed(0);
    console.log(who ? `valid — student ${who}, saved ${age} min ago` : "expired; grab a fresh one");
    process.exit(who ? 0 : 1);
  }

  console.log("usage:\n  pbpaste | bun scripts/session.ts save\n  bun scripts/session.ts check");
}
