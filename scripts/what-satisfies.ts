#!/usr/bin/env bun
/*
 * Asks Colleague what a course would actually satisfy.
 *
 * The gap this closes: an evaluation reports which requirement groups your
 * *completed* courses were applied to, but says nothing about a course you
 * have not taken. That is why the planner can schedule 82 credits against a
 * 73-credit gap — it cannot tell which second slot a course also fills.
 *
 * GetStudentProgramEvaluations takes a degree plan in the request body rather
 * than reading the saved one, so a hypothetical plan can be evaluated without
 * modifying anything. Groups come back with AppliedPlannedCourses populated:
 * Colleague's own answer to "where would this count?".
 *
 *   bun scripts/what-satisfies.ts CS-2210 MATH-2520
 *
 * Local only, read-only: nothing is saved back to your degree plan.
 */

import { load } from "./session";

const ORIGIN = "https://selfservice.cedarville.edu";
const TOKEN_RE = /name="__RequestVerificationToken"[^>]*value="([^"]+)"/;

const session = await load();
if (!session) throw new Error('no session; run "pbpaste | bun scripts/session.ts save"');

const page = await (
  await fetch(`${ORIGIN}/Student/Planning/DegreePlans`, {
    headers: { cookie: session.cookie, accept: "text/html" },
  })
).text();
const token = TOKEN_RE.exec(page)?.[1];
if (!token) throw new Error("could not scrape an antiforgery token; session may be expired");

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(ORIGIN + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie: session!.cookie,
      accept: "application/json",
      ...(body === undefined
        ? {}
        : {
            "content-type": "application/json, charset=UTF-8",
            "x-requested-with": "XMLHttpRequest",
            __RequestVerificationToken: token!,
          }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await res.text();
  if (!text.trimStart().startsWith("{") && !text.trimStart().startsWith("[")) {
    throw new Error(`${path}: ${res.status} ${text.slice(0, 120)}`);
  }
  return JSON.parse(text) as T;
}

interface Plan {
  DegreePlan: { PersonId: string; DegreePlanDto: Record<string, unknown> };
}
const current = await api<Plan>("/Student/Planning/DegreePlans/Current?studentId=");
const studentId = current.DegreePlan.PersonId;
const dto = current.DegreePlan.DegreePlanDto;
console.log(`student ${studentId}, plan version ${dto.Version}`);

const wanted = process.argv.slice(2);
if (wanted.length === 0)
  throw new Error("usage: bun scripts/what-satisfies.ts CS-2210 [MATH-2520 …]");

// Resolve codes to the ids the planner speaks in.
const { CatalogStore } = await import("../src/server/store");
const store = new CatalogStore();
const ids = new Map(
  store.readCourses("ALL").map((c) => [`${c.SubjectCode}-${c.Number}`, String(c.Id)]),
);

const term =
  ((dto.Terms as { TermId: string }[]) ?? [])[0]?.TermId ??
  store
    .stats()
    .map((s) => s.term)
    .find((t) => t !== "ALL") ??
  "2026FA";

// A plan is sent, not saved. The shape mirrors what Current returns.
const hypothetical = {
  ...dto,
  Terms: [
    ...((dto.Terms as unknown[]) ?? []),
    {
      TermId: term,
      PlannedCourses: wanted.map((code) => ({
        CourseId: ids.get(code) ?? code,
        TermCode: term,
        AddedBy: "student",
      })),
    },
  ],
};

const result = await api<{ Evaluations: { Program: Record<string, unknown> }[] }>(
  "/Student/Planning/Programs/GetStudentProgramEvaluations",
  { studentId, degreePlan: hypothetical },
);

await Bun.write(".data/what-satisfies.json", JSON.stringify(result, null, 2));
console.log(`wrote .data/what-satisfies.json — ${result.Evaluations?.length ?? 0} evaluations\n`);

for (const evaluation of result.Evaluations ?? []) {
  const program = evaluation.Program as {
    Code: string;
    PlannedCredits?: number;
    Requirements: {
      Description: string;
      Subrequirements: {
        Groups: { Code: string; DisplayText?: string; AppliedPlannedCourses?: unknown[] }[];
      }[];
    }[];
  };
  const hits: string[] = [];
  for (const r of program.Requirements ?? []) {
    for (const s of r.Subrequirements ?? []) {
      for (const g of s.Groups ?? []) {
        const planned = g.AppliedPlannedCourses ?? [];
        if (planned.length) {
          hits.push(`  ${r.Description.slice(0, 34)} / ${(g.DisplayText || g.Code).slice(0, 40)}`);
        }
      }
    }
  }
  console.log(`${program.Code}: planned credits ${program.PlannedCredits ?? 0}`);
  console.log(hits.length ? hits.join("\n") : "  no group reported a planned course");
  console.log();
}
