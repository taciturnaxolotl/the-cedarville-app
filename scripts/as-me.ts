#!/usr/bin/env bun
/*
 * Authenticated Self-Service queries, using the session saved by
 * scripts/session.ts. Local development only — this is the half of Colleague
 * that is genuinely personal, so it never runs on a server and nothing it
 * returns is cached anywhere shared.
 *
 *   bun scripts/as-me.ts programs            every program the school offers
 *   bun scripts/as-me.ts programs cyber      filtered
 *   bun scripts/as-me.ts evaluate BS.CMPEG   a what-if evaluation
 */

import { load } from "./session";

const ORIGIN = "https://selfservice.cedarville.edu";

async function api<T>(path: string, body?: unknown): Promise<T> {
  const session = await load();
  if (!session) throw new Error('no session; run "pbpaste | bun scripts/session.ts save"');

  const res = await fetch(ORIGIN + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie: session.cookie,
      accept: "application/json",
      "x-requested-with": "XMLHttpRequest",
      ...(body === undefined ? {} : { "content-type": "application/json, charset=UTF-8" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });

  const text = await res.text();
  if (!text.trimStart().startsWith("{") && !text.trimStart().startsWith("[")) {
    throw new Error(`${path}: not signed in (${res.status})`);
  }
  return JSON.parse(text) as T;
}

const [command, argument] = process.argv.slice(2);

if (command === "programs") {
  const list = await api<
    {
      Code: string;
      Title: string;
      Degree: string;
      IsActive: boolean;
      Majors: string[];
      Minors: string[];
    }[]
  >("/Student/Planning/Programs/GetActivePrograms");

  const needle = (argument ?? "").toLowerCase();
  const rows = list
    .filter((p) => p.IsActive)
    .filter((p) => !needle || `${p.Code} ${p.Title}`.toLowerCase().includes(needle))
    .sort((a, b) => a.Code.localeCompare(b.Code));

  console.log(`${rows.length} of ${list.length} programs`);
  for (const p of rows) {
    const kind = p.Minors?.length ? "minor" : p.Majors?.length ? "major" : "";
    console.log(`  ${p.Code.padEnd(18)} ${(p.Degree || kind).padEnd(10)} ${p.Title}`);
  }
} else if (command === "evaluate") {
  if (!argument) throw new Error("usage: evaluate <PROGRAM.CODE>");
  const plan = await api<{ DegreePlan: { PersonId: string } }>(
    "/Student/Planning/DegreePlans/Current?studentId=",
  );
  const evaluation = await api("/Student/Planning/Programs/ProgramEvaluation", {
    program: argument,
    isWhatIfEvaluation: true,
    studentId: plan.DegreePlan.PersonId,
  });
  await Bun.write(`.data/whatif-${argument}.json`, JSON.stringify(evaluation, null, 2));
  console.log(`wrote .data/whatif-${argument}.json`);
} else {
  console.log(
    "usage:\n  bun scripts/as-me.ts programs [filter]\n  bun scripts/as-me.ts evaluate <CODE>",
  );
}
