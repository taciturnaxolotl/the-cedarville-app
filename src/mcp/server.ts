#!/usr/bin/env bun
/*
 * An MCP server over the course catalog and, if you ask for it, your own
 * degree requirements.
 *
 * The opt-in is structural rather than a runtime check. Catalog tools are
 * always registered because that data is public and identical for every
 * student. The tools that read a transcript are only registered when the
 * server is started with --personal, so a client that has not opted in never
 * sees them in tools/list: there is nothing to call, not merely something
 * that refuses.
 *
 * Everything is read-only. There is no tool here that registers for a class,
 * drops one, or writes anything back to Colleague.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { merge } from "../merge";
import {
  buildGraph,
  type CourseNode,
  depth,
  downstream,
  eligibility,
  parseRequisite,
} from "../prereqs";
import {
  completedCourses,
  gaps,
  inProgressCourses,
  normalize,
  openGroups,
  type ProgramTree,
} from "../requirements";
import { conflicts, DAY_NAMES, formatTime, offeringsFromListing } from "../schedule";
import { CatalogStore } from "../server/store";

const store = new CatalogStore();
const text = (body: string) => ({ content: [{ type: "text" as const, text: body }] });
const fail = (body: string) => ({
  content: [{ type: "text" as const, text: body }],
  isError: true,
});

function graphFor(term: string) {
  const catalog = store.read(term);
  const nodes: CourseNode[] = (catalog.courses ?? []).map((c) => ({
    code: `${c.SubjectCode}-${c.Number}`,
    title: c.Title,
    requisites: (c.CourseRequisites ?? []).map(parseRequisite),
  }));
  return { catalog, graph: buildGraph(nodes) };
}

// ---- catalog tools, always available -----------------------------------

function registerCatalog(server: McpServer) {
  server.registerTool(
    "list_terms",
    {
      description:
        "Terms whose catalog is cached locally, with how many sections and courses each holds.",
      inputSchema: z.object({}),
    },
    async () => {
      const rows = store.stats();
      if (rows.length === 0)
        return fail("No terms cached yet. Run the planner server once to crawl.");
      return text(
        rows
          .map(
            (r) =>
              `${r.term}  ${r.sections} sections, ${r.courses} courses, fetched ${r.fetchedAt}`,
          )
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "search_courses",
    {
      description:
        "Search the course catalog for a term. Returns course codes, titles, credits and how many sections each has.",
      inputSchema: z.object({
        term: z
          .string()
          .describe('Term code, e.g. "2026FA". Use list_terms to see what is cached.'),
        query: z
          .string()
          .optional()
          .describe('Match against code and title, e.g. "algorithms" or "CS-3".'),
        subject: z.string().optional().describe('Subject code, e.g. "CS" or "EGCP".'),
        limit: z.number().int().min(1).max(200).default(40),
      }),
    },
    async ({ term, query, subject, limit }) => {
      const { catalog } = graphFor(term);
      if (catalog.sections.length === 0) return fail(`No catalog cached for ${term}.`);

      const sectionsByCourse = new Map<string, number>();
      for (const s of catalog.sections) {
        sectionsByCourse.set(s.CourseId, (sectionsByCourse.get(s.CourseId) ?? 0) + 1);
      }

      const needle = query?.toLowerCase();
      const rows = (catalog.courses ?? [])
        .map((c) => ({ c, code: `${c.SubjectCode}-${c.Number}` }))
        .filter(({ c, code }) => {
          if (subject && c.SubjectCode.toUpperCase() !== subject.toUpperCase()) return false;
          if (!needle) return true;
          return `${code} ${c.Title}`.toLowerCase().includes(needle);
        })
        .slice(0, limit);

      if (rows.length === 0) return text("No matching courses.");
      return text(
        rows
          .map(
            ({ c, code }) =>
              `${code.padEnd(11)} ${String(c.MinimumCredits ?? "?").padStart(4)}cr  ` +
              `${String(sectionsByCourse.get(c.Id) ?? 0).padStart(2)} sections  ${c.Title}`,
          )
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "course_details",
    {
      description:
        "Everything known about one course: credits, description, prerequisites in the registrar's own words, and how many later courses depend on it.",
      inputSchema: z.object({
        term: z.string(),
        code: z.string().describe('Course code, e.g. "CS-3410".'),
      }),
    },
    async ({ term, code }) => {
      const wanted = code.toUpperCase();
      const { catalog, graph } = graphFor(term);
      const record = (catalog.courses ?? []).find(
        (c) => `${c.SubjectCode}-${c.Number}`.toUpperCase() === wanted,
      );
      if (!record) return fail(`${wanted} is not in the ${term} catalog.`);

      const node = graph.courses.get(wanted);
      const unlocks = downstream(graph, wanted);
      const lines = [
        `${wanted}  ${record.Title}  (${record.MinimumCredits ?? "?"} cr)`,
        record.Description?.trim() ? `\n${record.Description.trim()}\n` : "",
        "prerequisites:",
        ...(node?.requisites.length
          ? node.requisites.map(
              (r) =>
                `  ${r.required ? "required" : "recommended"} [${r.timing}] ${r.text}` +
                (r.understood ? "" : "   (prose; not machine-checkable)"),
            )
          : ["  none"]),
        "",
        `depth in its own chain: ${depth(graph, wanted)}`,
        `unlocks ${unlocks.size} later course${unlocks.size === 1 ? "" : "s"}` +
          (unlocks.size ? `: ${[...unlocks].sort().join(" ")}` : ""),
      ];
      return text(lines.filter((l) => l !== "").join("\n"));
    },
  );

  server.registerTool(
    "list_sections",
    {
      description:
        "Meeting times, rooms, instructors and seat counts for a course's sections. Seats are from the last crawl, not live.",
      inputSchema: z.object({ term: z.string(), code: z.string() }),
    },
    async ({ term, code }) => {
      const wanted = code.toUpperCase();
      const catalog = store.read(term);
      const offerings = offeringsFromListing(
        catalog.sections.filter((s) => s.CourseName?.toUpperCase() === wanted),
      );
      if (offerings.length === 0) return fail(`No sections of ${wanted} in ${term}.`);

      return text(
        offerings
          .map((o) => {
            const when = o.meetings.length
              ? o.meetings
                  .map(
                    (m) =>
                      `${m.days.map((d) => DAY_NAMES[d]).join("")} ` +
                      `${formatTime(m.start)}-${formatTime(m.end)}` +
                      (m.room ? ` ${m.room}` : ""),
                  )
                  .join("; ")
              : "no set meeting time";
            return (
              `${o.courseName}-${o.number}  id=${o.id}  syn=${o.synonym}  ${when}  ` +
              `${o.seats.available}/${o.seats.capacity} open` +
              (o.instructors.length ? `  ${o.instructors.join(", ")}` : "") +
              (o.nonStandardDates ? "  [partial term]" : "")
            );
          })
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "check_conflicts",
    {
      description:
        "Do these sections collide? Compares weekday, time and date range, so two half-semester sections in different halves do not count as a clash.",
      inputSchema: z.object({
        term: z.string(),
        section_ids: z.array(z.string()).min(2).describe("Section ids from list_sections."),
      }),
    },
    async ({ term, section_ids }) => {
      const catalog = store.read(term);
      const wanted = new Set(section_ids);
      const offerings = offeringsFromListing(catalog.sections.filter((s) => wanted.has(s.Id)));

      const missing = section_ids.filter((id) => !offerings.some((o) => o.id === id));
      if (missing.length) return fail(`Unknown section ids: ${missing.join(", ")}`);

      const found = conflicts(offerings);
      const credits = offerings.reduce((n, o) => n + o.credits.min, 0);
      if (found.length === 0) {
        return text(`No conflicts. ${offerings.length} sections, ${credits} credits.`);
      }
      return text(
        [
          `${found.length} conflict${found.length === 1 ? "" : "s"} across ${offerings.length} sections (${credits} credits):`,
          ...found.map((c) => {
            const [x, y] = c.meetings;
            const day = x.days.find((d) => y.days.includes(d)) ?? 0;
            return `  ${c.a.courseName}-${c.a.number} vs ${c.b.courseName}-${c.b.number}: ${DAY_NAMES[day]} ${formatTime(Math.max(x.start, y.start))}-${formatTime(Math.min(x.end, y.end))}`;
          }),
        ].join("\n"),
      );
    },
  );
}

// ---- personal tools, only when opted in --------------------------------

async function loadTrees(): Promise<Record<string, ProgramTree>> {
  const file = Bun.file(".data/evaluations.json");
  if (!(await file.exists()))
    throw new Error("no .data/evaluations.json; capture from the planner first");
  const snapshot = (await file.json()) as { evaluations: Record<string, never> };
  return Object.fromEntries(
    Object.entries(snapshot.evaluations).map(([code, raw]) => [code, normalize(raw)]),
  );
}

function registerPersonal(server: McpServer) {
  server.registerTool(
    "my_requirements",
    {
      description:
        "Your own degree requirements that are still open, from a captured evaluation. Reads a local file; nothing is fetched.",
      inputSchema: z.object({
        program: z
          .string()
          .optional()
          .describe('Program code, e.g. "BS.CYOPR". Defaults to all captured.'),
        only_gaps: z
          .boolean()
          .default(false)
          .describe("Only requirements with nothing on your degree plan covering them."),
      }),
    },
    async ({ program, only_gaps }) => {
      const trees = await loadTrees();
      const chosen = program ? [trees[program]].filter(Boolean) : Object.values(trees);
      if (chosen.length === 0) return fail(`No captured evaluation for ${program}.`);

      const out: string[] = [];
      for (const tree of chosen as ProgramTree[]) {
        const rows = only_gaps ? gaps(tree) : openGroups(tree);
        out.push(
          `${tree.code}  ${tree.title}  ${tree.credits.completed}/${tree.credits.minimum} credits, ${rows.length} open`,
        );
        for (const { requirement, group } of rows) {
          const need = [
            group.min.credits && `${group.min.credits}cr`,
            group.min.courses && `${group.min.courses} courses`,
          ]
            .filter(Boolean)
            .join(" ");
          const c = group.constraint;
          const pool =
            c.kind === "take-all" || c.kind === "choose-from"
              ? c.courses.map((x) => x.CourseName).join(" ")
              : c.kind === "rule-based"
                ? "(decided by a Colleague rule; course list not published)"
                : "";
          out.push(`  [${group.status.completion}] ${need} ${group.text || requirement.text}`);
          if (pool) out.push(`      ${pool}`);
        }
      }
      return text(out.join("\n"));
    },
  );

  server.registerTool(
    "my_eligibility",
    {
      description:
        "Which courses you can take now, and what is blocking the rest, using your completed courses against the prerequisite graph.",
      inputSchema: z.object({
        term: z.string(),
        subject: z.string().optional().describe('Narrow to one subject, e.g. "CS".'),
        state: z.enum(["open", "blocked", "unknown", "all"]).default("all"),
      }),
    },
    async ({ term, subject, state }) => {
      const trees = await loadTrees();
      const done = new Set<string>();
      const now = new Set<string>();
      for (const tree of Object.values(trees)) {
        for (const c of completedCourses(tree)) done.add(c);
        for (const c of inProgressCourses(tree)) now.add(c);
      }

      const { graph } = graphFor(term);
      const rows: string[] = [];
      for (const [code, node] of [...graph.courses].sort()) {
        if (subject && !code.toUpperCase().startsWith(`${subject.toUpperCase()}-`)) continue;
        const verdict = eligibility(node, done, now);
        if (state !== "all" && verdict.state !== state) continue;
        rows.push(
          `${code.padEnd(11)} ${verdict.state.padEnd(8)} ` +
            (verdict.state === "blocked"
              ? `needs ${verdict.blockedBy.join(", ")}`
              : verdict.state === "unknown"
                ? verdict.why.join(" ").slice(0, 80)
                : `unlocks ${downstream(graph, code).size}`),
        );
      }
      if (rows.length === 0) return text("Nothing matches.");
      return text(
        [`${done.size} completed, ${now.size} in progress`, ...rows.slice(0, 200)].join("\n"),
      );
    },
  );

  server.registerTool(
    "compare_programs",
    {
      description:
        "Where two captured programs overlap: which requirement in one draws on the same courses as a requirement in the other.",
      inputSchema: z.object({ a: z.string(), b: z.string() }),
    },
    async ({ a, b }) => {
      const trees = await loadTrees();
      const left = trees[a];
      const right = trees[b];
      if (!left || !right) {
        return fail(`Capture both programs first. Have: ${Object.keys(trees).join(", ")}`);
      }

      const result = merge(left, right);
      const out = [
        `${a} + ${b}: ${result.shared.length} shared requirement pairs, ${result.certainSharedCourses.length} distinct courses`,
      ];
      for (const pool of result.shared) {
        out.push(
          `[${pool.significance}] ${(pool.a.group.text || pool.a.requirement).slice(0, 60)}`,
          `           <-> ${(pool.b.group.text || pool.b.requirement).slice(0, 60)}`,
          `           ${pool.courses.map((c) => c.CourseName).join(" ")}`,
        );
      }
      if (result.unresolved.length) {
        out.push("", "cannot be compared automatically:");
        for (const u of result.unresolved) {
          out.push(`  [${u.reason}] ${u.at.program} ${u.at.group.text || u.at.group.code}`);
        }
      }
      return text(out.join("\n"));
    },
  );
}

// ---- start -------------------------------------------------------------

const personal = process.argv.includes("--personal") || process.env.CEDARVILLE_MCP_PERSONAL === "1";

serveStdio(() => {
  const server = new McpServer({ name: "cedarville", version: "0.1.0" });
  registerCatalog(server);
  if (personal) registerPersonal(server);
  return server;
});
