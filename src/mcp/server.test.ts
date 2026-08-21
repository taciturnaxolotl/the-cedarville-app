/*
 * Drives the MCP server the way a client does: over stdio, in JSON-RPC.
 *
 * The assertion that matters most is the opt-in one. "Personal tools are not
 * registered" has to mean the client cannot see or call them, not that a
 * handler politely declines, so these check tools/list and tools/call rather
 * than any internal flag.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { ListingSection } from "../catalog";
import { CatalogStore } from "../server/store";

const SERVER = new URL("./server.ts", import.meta.url).pathname;
const ROOT = new URL("../..", import.meta.url).pathname;

/**
 * The test preload pins CATALOG_DB for this process, but a spawned child does
 * not inherit that, so without an explicit env these tests would read the real
 * catalog. A seeded temp file is passed instead: hermetic, and unlike
 * ":memory:" it is visible to another process.
 */
const DB = `${ROOT}.data/test-mcp-${process.pid}.sqlite`;

beforeAll(() => {
  const store = new CatalogStore(DB);
  store.replace({
    term: "2026FA",
    fetchedAt: "2026-08-12T00:00:00.000Z",
    sections: [
      {
        Id: "s1",
        CourseId: "c1",
        CourseName: "CS-2210",
        Number: "01",
        Title: "Data Structures",
        Synonym: "5108",
        TermId: "2026FA",
        MinimumCredits: 3,
        MaximumCredits: null,
        Capacity: 20,
        Enrolled: 19,
        Available: 1,
        Waitlisted: 0,
        AvailabilityStatus: "Open",
        IsNonStandardDates: false,
        StartDate: "2026-08-19T00:00:00-04:00",
        EndDate: "2026-12-11T00:00:00-05:00",
        FacultyDisplay: ["Mr. Nicholas J. Parry"],
        Meetings: [
          {
            Days: [1, 3, 5],
            StartTime: "2026-08-11T16:00:00+00:00",
            EndTime: "2026-08-11T16:50:00+00:00",
            StartDate: "2026-08-19T00:00:00-04:00",
            EndDate: "2026-12-11T00:00:00-05:00",
            Room: "ENS*241",
            Frequency: "W",
            IsOnline: false,
            InstructionalMethodCode: "LEC",
          },
        ],
        FormattedMeetingTimes: [],
      } as unknown as ListingSection,
    ],
    courses: [
      {
        Id: "c1",
        SubjectCode: "CS",
        Number: "2210",
        Title: "Data Structures",
        MinimumCredits: 3,
        CourseRequisites: [
          {
            DisplayText: "Take CS-1220",
            DisplayTextExtension: "- Must be completed prior to taking this course.",
            IsRequired: true,
          },
        ],
      },
    ],
  });
  store.close();
});

afterAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) await rm(`${DB}${suffix}`, { force: true });
});

interface Rpc {
  id?: number;
  result?: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean };
  error?: { code: number; message: string };
}

/** Runs one session: initialize, then the given calls, then read replies. */
async function session(args: string[], calls: object[]): Promise<Map<number, Rpc>> {
  const lines = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    ...calls,
  ];

  const child = Bun.spawn(["bun", SERVER, ...args], {
    stdin: new TextEncoder().encode(`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`),
    stdout: "pipe",
    stderr: "pipe",
    cwd: ROOT,
    // Explicit, because the preload's pin does not cross a spawn. The
    // companion is off for the same reason the database is pinned: a test may
    // not hold a real port, and it may not read or write a real transcript.
    env: {
      ...process.env,
      CATALOG_DB: DB,
      CEDARVILLE_COMPANION: "0",
      CEDARVILLE_CAPTURE: "/nonexistent/cedarville-tests/evaluations.json",
    },
  });

  const out = await new Response(child.stdout).text();
  child.kill();

  const byId = new Map<number, Rpc>();
  for (const line of out.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    const message = JSON.parse(line) as Rpc;
    if (message.id !== undefined) byId.set(message.id, message);
  }
  return byId;
}

const listTools = (args: string[] = []) =>
  session(args, [{ jsonrpc: "2.0", id: 2, method: "tools/list" }]).then(
    (m) => m.get(2)?.result?.tools?.map((t) => t.name) ?? [],
  );

const CATALOG = [
  "list_terms",
  "search_courses",
  "course_details",
  "list_sections",
  "check_conflicts",
  "live_seats",
  "refresh_catalog",
];
const PERSONAL = ["my_requirements", "my_eligibility", "compare_programs"];

describe("the opt-in boundary", () => {
  test("catalog tools are always available", async () => {
    const tools = await listTools();
    for (const name of CATALOG) expect(tools).toContain(name);
  }, 20_000);

  test("personal tools are absent by default, not merely refusing", async () => {
    const tools = await listTools();
    for (const name of PERSONAL) expect(tools).not.toContain(name);
  }, 20_000);

  test("--personal adds them", async () => {
    const tools = await listTools(["--personal"]);
    for (const name of [...CATALOG, ...PERSONAL]) expect(tools).toContain(name);
  }, 20_000);

  // Not registered has to mean not callable, or the opt-in is decorative.
  test("calling a personal tool without opting in fails as unknown", async () => {
    const replies = await session(
      [],
      [
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "my_eligibility", arguments: { term: "2026FA" } },
        },
      ],
    );
    const reply = replies.get(3);
    expect(reply?.error?.message ?? "").toContain("my_eligibility");
    expect(reply?.result?.content).toBeUndefined();
  }, 20_000);
});

describe("planning tools", () => {
  // These need a captured evaluation, which the seeded temp DB does not have,
  // so assert the failure is legible rather than a crash.
  test("plan_terms explains itself when there is no capture", async () => {
    const replies = await session(
      ["--personal"],
      [
        {
          jsonrpc: "2.0",
          id: 11,
          method: "tools/call",
          params: { name: "plan_terms", arguments: { program: "NOPE.XX" } },
        },
      ],
    );
    const body = replies.get(11)?.result?.content?.[0]?.text ?? "";
    expect(replies.get(11)?.result?.isError).toBe(true);
    expect(body.toLowerCase()).toMatch(/no captured evaluation|evaluations\.json/);
  }, 20_000);

  // Regression: both planning entry points named "2026FA" literally, so a
  // newer catalog would land and be ignored without anything looking wrong.
  test("planning reads the newest cached term, not a named one", async () => {
    const source = await Bun.file(new URL("./server.ts", import.meta.url).pathname).text();
    const planning = source.slice(source.indexOf("function planningContext"));
    // Whitespace-normalised, because the formatter is free to break the chain
    // across lines and this should assert on code, not on layout.
    const flat = planning.replace(/\s+/g, "");
    expect(flat).not.toMatch(/store\.read\("\d{4}(FA|SP|SU)"\)/);
    expect(flat).toContain("store.stats()");
  });

  test("critical_path is registered only with --personal", async () => {
    expect(await listTools()).not.toContain("critical_path");
    expect(await listTools(["--personal"])).toContain("plan_terms");
    expect(await listTools(["--personal"])).toContain("critical_path");
  }, 20_000);
});

describe("catalog tools", () => {
  test("an unknown term is an error, not an empty success", async () => {
    const replies = await session(
      [],
      [
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "search_courses", arguments: { term: "1999XX", query: "anything" } },
        },
      ],
    );
    const reply = replies.get(4)?.result;
    expect(reply?.isError).toBe(true);
    expect(reply?.content?.[0]?.text).toContain("1999XX");
  }, 20_000);

  test("reads the seeded catalog", async () => {
    const replies = await session(
      [],
      [
        {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "course_details", arguments: { term: "2026FA", code: "CS-2210" } },
        },
      ],
    );
    const body = replies.get(7)?.result?.content?.[0]?.text ?? "";
    expect(body).toContain("Data Structures");
    expect(body).toContain("Take CS-1220");
  }, 20_000);

  test("list_sections converts the UTC meeting time to campus time", async () => {
    const replies = await session(
      [],
      [
        {
          jsonrpc: "2.0",
          id: 8,
          method: "tools/call",
          params: { name: "list_sections", arguments: { term: "2026FA", code: "CS-2210" } },
        },
      ],
    );
    // 16:00Z is noon in Ohio in August.
    expect(replies.get(8)?.result?.content?.[0]?.text ?? "").toContain("MonWedFri 12:00pm-12:50pm");
  }, 20_000);

  // A prerequisite that is not taught this term is exactly the bottleneck a
  // student needs to see, so it must not read as "no such course".
  test("a course known only as a prerequisite reports what it gates", async () => {
    const replies = await session(
      [],
      [
        {
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: { name: "course_details", arguments: { term: "2026FA", code: "CS-1220" } },
        },
      ],
    );
    const reply = replies.get(10)?.result;
    expect(reply?.isError).toBeUndefined();
    expect(reply?.content?.[0]?.text ?? "").toContain("not offered in 2026FA");
    expect(reply?.content?.[0]?.text ?? "").toContain("CS-2210");
  }, 20_000);

  test("an unknown course says so rather than returning nothing", async () => {
    const replies = await session(
      [],
      [
        {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "course_details", arguments: { term: "2026FA", code: "ZZZZ-9999" } },
        },
      ],
    );
    expect(replies.get(5)?.result?.isError).toBe(true);
  }, 20_000);

  test("check_conflicts rejects ids it does not recognise", async () => {
    const replies = await session(
      [],
      [
        {
          jsonrpc: "2.0",
          id: 6,
          method: "tools/call",
          params: {
            name: "check_conflicts",
            arguments: { term: "2026FA", section_ids: ["nope", "also-nope"] },
          },
        },
      ],
    );
    const reply = replies.get(6)?.result;
    expect(reply?.isError).toBe(true);
    expect(reply?.content?.[0]?.text).toContain("nope");
  }, 20_000);

  // Both live tools reach the registrar, so the assertions here are about the
  // paths that must not: a course we hold no sections for is answerable from
  // the cache alone, and answering it over the network would be a bug.
  test("live_seats needs no network to reject a course it has never seen", async () => {
    const replies = await session(
      [],
      [
        {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: "live_seats", arguments: { term: "2026FA", codes: ["ZZZZ-9999"] } },
        },
      ],
    );
    const reply = replies.get(7)?.result;
    expect(reply?.isError).toBe(true);
    expect(reply?.content?.[0]?.text).toContain("ZZZZ-9999");
  }, 20_000);
});
