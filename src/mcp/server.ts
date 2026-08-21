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
 * Nothing here writes to Colleague. There is no tool that registers for a
 * class or drops one; the only writes are into the local catalog cache, which
 * is a copy of public data we were going to fetch anyway.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { runsIn, seasonsOffered, yearsOffered } from "../catalog";
import { aliasesOf, buildEquivalences } from "../equivalence";
import { merge } from "../merge";
import { criticalPath, projectPlan, type TermSlot, termsFrom } from "../planner";
import { buildGraph, depth, downstream, eligibility, nodeOf } from "../prereqs";
import {
  completedCourses,
  coursesNeededAcross,
  gaps,
  inProgressCourses,
  normalize,
  openGroups,
  type ProgramTree,
} from "../requirements";
import { conflicts, DAY_NAMES, formatTime, offeringsFromListing } from "../schedule";
import { liveSeats, refreshTerm } from "../server/crawler";
import { CatalogStore } from "../server/store";

const store = new CatalogStore();
const text = (body: string) => ({ content: [{ type: "text" as const, text: body }] });
const fail = (body: string) => ({
  content: [{ type: "text" as const, text: body }],
  isError: true,
});

function graphFor(term: string) {
  const catalog = store.read(term);
  return { catalog, graph: buildGraph((catalog.courses ?? []).map(nodeOf)) };
}

/** Crawls in flight, so two calls a minute apart do not crawl twice. */
const running = new Map<string, Promise<number>>();

function refresh(term: string): Promise<number> {
  const held = running.get(term);
  if (held) return held;
  const job = refreshTerm(term, store).finally(() => running.delete(term));
  running.set(term, job);
  return job;
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

      // A course can be absent from a term's catalog and still matter: it is
      // named as a prerequisite by courses that *are* offered. Reporting only
      // "not found" would hide exactly the bottlenecks worth knowing about.
      if (!record) {
        const gated = downstream(graph, wanted);
        if (gated.size === 0) return fail(`${wanted} is not in the ${term} catalog.`);
        const direct = [...(graph.unlocks.get(wanted) ?? [])].sort();
        return text(
          [
            `${wanted} is not offered in ${term}, but ${gated.size} course${gated.size === 1 ? "" : "s"} depend on it.`,
            "",
            `directly gates: ${direct.join(" ")}`,
            `transitively:   ${[...gated].sort().join(" ")}`,
            "",
            "Check another term for when it is taught.",
          ].join("\n"),
        );
      }

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

  server.registerTool(
    "live_seats",
    {
      description:
        "Seat counts fetched from Colleague right now, for a few named courses, next to what the last crawl recorded. Every other tool here serves cached data; seats are the one field that moves by the minute during registration, so ask this before telling anyone a seat exists.",
      inputSchema: z.object({
        term: z.string(),
        codes: z
          .array(z.string())
          .min(1)
          .max(20)
          .describe('Course codes, e.g. ["CS-2210", "HON-1010"]. One request covers them all.'),
      }),
    },
    async ({ term, codes }) => {
      const wanted = new Set(codes.map((c) => c.toUpperCase()));
      const catalog = store.read(term);
      const mine = catalog.sections.filter((s) => wanted.has(String(s.CourseName).toUpperCase()));
      if (mine.length === 0) return fail(`No sections of ${[...wanted].join(", ")} in ${term}.`);

      const seats = await liveSeats(term, [...new Set(mine.map((s) => s.CourseId))]);
      if (Object.keys(seats).length === 0) {
        return fail(`Colleague returned nothing for ${term}; the cached counts still stand.`);
      }

      const rows = mine
        .map((s) => ({ s, live: seats[s.Id] }))
        .sort((a, b) =>
          `${a.s.CourseName}-${a.s.Number}`.localeCompare(`${b.s.CourseName}-${b.s.Number}`),
        )
        .map(({ s, live }) => {
          const name = `${s.CourseName}-${s.Number}`;
          // A section can vanish between crawls — cancelled, or merged into
          // another. Saying so is more useful than printing the stale count.
          if (!live)
            return `${name.padEnd(13)} no longer listed  (cached: ${s.Available}/${s.Capacity})`;
          const moved = live.available !== s.Available ? `  was ${s.Available}` : "";
          const wait = live.waitlisted ? `  ${live.waitlisted} waitlisted` : "";
          return `${name.padEnd(13)} ${live.available}/${live.capacity} open  ${live.status}${moved}${wait}`;
        });

      return text([...rows, "", `cached crawl: ${catalog.fetchedAt}`].join("\n"));
    },
  );

  server.registerTool(
    "refresh_catalog",
    {
      description:
        "Re-crawl a whole term into the local cache: sections, meeting times and course records. Takes about a minute and is paced out of courtesy to the registrar, so for a seat count on a handful of courses use live_seats instead.",
      inputSchema: z.object({
        term: z.string().describe('Term code, e.g. "2026FA".'),
      }),
    },
    async ({ term }) => {
      const before = store.stats().find((s) => s.term === term);
      const sections = await refresh(term);
      // refreshTerm keeps the old catalog when a crawl comes back empty, which
      // is the right call but would otherwise read here as a silent success.
      if (sections === 0) {
        return fail(`Crawl of ${term} came back empty. The previous catalog is untouched.`);
      }
      const after = store.stats().find((s) => s.term === term);
      const delta = before ? sections - before.sections : 0;
      return text(
        `${term}: ${sections} sections, ${after?.courses ?? 0} courses, fetched ${after?.fetchedAt}.` +
          (before ? `  (${delta >= 0 ? "+" : ""}${delta} since ${before.fetchedAt})` : ""),
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

/** Shared setup for the planning tools: graph, credits, seasons. */
function planningContext() {
  // Newest terms first; naming them literally is how a planner goes stale.
  const cached = store
    .stats()
    .map((s) => s.term)
    .sort()
    .reverse();
  const regular = cached.find((t) => !t.includes("SU"));
  const summerTerm = cached.find((t) => t.includes("SU"));

  const fall = regular ? store.read(regular) : { sections: [], courses: [] };
  const summer = summerTerm ? store.read(summerTerm) : { sections: [], courses: [] };
  // Every course we hold, not the two terms we happen to have crawled: a
  // requisite names courses nobody is teaching, and a graph built from one
  // term's listing loses about a third of its depth. Here that was 892 of
  // 2047 courses.
  const held = store.readCourses("ALL");
  const records = held.length ? held : [...(fall.courses ?? []), ...(summer.courses ?? [])];

  const credits = new Map(
    records.map((c) => [`${c.SubjectCode}-${c.Number}`, c.MinimumCredits ?? 0]),
  );
  const titles = new Map(records.map((c) => [`${c.SubjectCode}-${c.Number}`, c.Title]));
  const graph = buildGraph(records.map(nodeOf));

  // Colleague publishes course equivalence on section records, not on the
  // catalog view, so a transcript from an earlier catalog year still matches.
  const codeForId = new Map(records.map((c) => [String(c.Id), `${c.SubjectCode}-${c.Number}`]));
  const equivalences = buildEquivalences(
    [...fall.sections, ...summer.sections]
      .map((s) => ({
        code: s.CourseName,
        // Declared on the nested course record, not on the section itself.
        equatedIds: ((s as { Course?: { EquatedCourseIds?: string[] } }).Course?.EquatedCourseIds ??
          []) as string[],
      }))
      .filter((x) => x.code && x.equatedIds.length),
    (id) => codeForId.get(id),
  );

  // The registrar states when a course runs and in which years; inferring it
  // from one term's listing was wrong for 367 courses.
  const seasons = new Map(records.map((c) => [`${c.SubjectCode}-${c.Number}`, seasonsOffered(c)]));
  const cycles = new Map(records.map((c) => [`${c.SubjectCode}-${c.Number}`, yearsOffered(c)]));
  const offeredIn = (code: string, slot: TermSlot) => {
    const stated = seasons.get(code);
    if (stated?.length && !stated.includes(slot.season)) return false;
    return runsIn(cycles.get(code) ?? "all", slot.year, slot.season);
  };

  return {
    graph,
    titles,
    offeredIn,
    aliases: (c: string) => aliasesOf(equivalences, c),
    credits: (c: string) => credits.get(c) ?? 3,
  };
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
          .describe("Program code. Defaults to every captured evaluation."),
        only_gaps: z
          .boolean()
          .default(false)
          .describe("Only requirements with nothing on your degree plan covering them."),
      }),
    },
    async ({ program, only_gaps }) => {
      const trees = await loadTrees();
      const chosen = (program ? [trees[program]] : Object.values(trees)).filter(
        (t): t is ProgramTree => Boolean(t),
      );
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
      const trees = Object.values(await loadTrees());
      const done = completedCourses(trees);
      const now = inProgressCourses(trees);

      const { graph } = graphFor(term);
      const rows: string[] = [];
      for (const [code, node] of [...graph.courses].sort()) {
        if (subject && !code.toUpperCase().startsWith(`${subject.toUpperCase()}-`)) continue;
        const verdict = eligibility(node, done, now, { exists: (c) => graph.courses.has(c) });
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
    "plan_terms",
    {
      description:
        "Project which term each remaining requirement lands in, respecting prerequisites, seasons and a credit cap. Answers 'when do I graduate' rather than 'how many credits'.",
      inputSchema: z.object({
        program: z
          .string()
          .optional()
          .describe("Program code. Defaults to the first captured evaluation."),
        credits_per_term: z.number().int().min(6).max(21).default(15),
        summers: z
          .number()
          .int()
          .min(0)
          .max(4)
          .default(4)
          .describe("How many summers to plan, earliest first. Zero plans none."),
        keep_semesters_full: z
          .boolean()
          .default(true)
          .describe(
            "Hold work back from a summer rather than leave the semester behind it part time.",
          ),
        start: z
          .string()
          .default("SP27")
          .describe('First term to plan, e.g. "SP27". The term in progress is excluded.'),
      }),
    },
    async ({ program, credits_per_term, summers, keep_semesters_full, start }) => {
      const trees = await loadTrees();
      // Every captured program by default, solved as one cover. Planning the
      // first alone buys a shared requirement twice and drops the rest of a
      // second major, which is the whole question a dual major is asking.
      const chosen = (program ? [trees[program]] : Object.values(trees)).filter(
        (t): t is ProgramTree => Boolean(t),
      );
      if (chosen.length === 0)
        return fail(
          `No captured evaluation${program ? ` for ${program}` : ""}. Have: ${Object.keys(trees).join(", ") || "none"}`,
        );

      const { graph, credits, offeredIn, titles, aliases } = planningContext();
      const have = new Set([...completedCourses(chosen), ...inProgressCourses(chosen)]);
      const pursuing = new Set(chosen.flatMap((t) => [...t.majors, ...t.minors]));
      const solved = coursesNeededAcross(chosen, { credits, have, pursuing });
      const season = start.startsWith("SP") ? "spring" : "fall";
      const year = 2000 + Number(start.slice(2));

      const plan = projectPlan({
        need: solved.courses,
        completed: have,
        // Standing is measured on the transcript, not on what the pools we can
        // price happen to add up to.
        earnedCredits: Math.max(...chosen.map((t) => t.credits.completed + t.credits.inProgress)),
        graph,
        credits,
        offeredIn,
        aliases,
        keepSemestersFull: keep_semesters_full,
        slots: termsFrom({ year, season: season as "spring" | "fall" }, 12, {
          capacity: credits_per_term,
          summers,
          minimum: 12,
        }),
      });

      // Two majors on one bachelor's share a single credit total, so the
      // requirement is the largest of them and never their sum.
      const largest = (pick: (t: ProgramTree) => number) => Math.max(...chosen.map(pick));
      const toGo =
        largest((t) => t.credits.minimum) -
        largest((t) => t.credits.completed) -
        largest((t) => t.credits.inProgress);
      const lines = [
        `${chosen.map((t) => t.code).join(" + ")}: ${toGo} credits remain; ` +
          `this plan schedules ${plan.totalCredits} across named requirements.`,
        `Finishes ${plan.finishes ?? "never within the horizon"} at ${credits_per_term}/term` +
          `${summers ? ` with ${summers} summer${summers === 1 ? "" : "s"}` : " without summers"}.`,
        "",
      ];
      for (const term of plan.terms) {
        lines.push(`${term.slot.name}  (${term.credits} cr)`);
        for (const c of term.courses) {
          lines.push(
            `   ${c.code.padEnd(11)} ${String(c.credits).padStart(2)}  ${titles.get(c.code) ?? ""}${c.caution ? "   [verify: unparsed condition]" : ""}`,
          );
        }
      }
      if (plan.unscheduled.length) {
        lines.push("", "not placed:");
        for (const u of plan.unscheduled) lines.push(`   ${u.code.padEnd(11)} ${u.why}`);
      }
      const { unenumerable } = solved;
      if (unenumerable.length) {
        lines.push("", "not plannable — Colleague does not publish the eligible courses:");
        for (const u of unenumerable) {
          lines.push(`   ${u.credits ? `${u.credits}cr` : "    "}  ${u.text.slice(0, 70)}`);
        }
      }
      lines.push(
        "",
        "Caveats: this is the cheapest degree rather than the one you have chosen —",
        "the pins and tracks set in the planner live in that browser, not here.",
      );
      return text(lines.join("\n"));
    },
  );

  server.registerTool(
    "critical_path",
    {
      description:
        "The longest chain of prerequisites still ahead. This is the floor on how many terms remain, and no credit load shortens it.",
      inputSchema: z.object({
        program: z.string().optional().describe("Defaults to the first captured evaluation."),
      }),
    },
    async ({ program }) => {
      const trees = await loadTrees();
      const chosen = (program ? [trees[program]] : Object.values(trees)).filter(
        (t): t is ProgramTree => Boolean(t),
      );
      if (chosen.length === 0)
        return fail(
          `No captured evaluation${program ? ` for ${program}` : ""}. Have: ${Object.keys(trees).join(", ") || "none"}`,
        );

      const { graph, credits, titles } = planningContext();
      const have = new Set([...completedCourses(chosen), ...inProgressCourses(chosen)]);
      const path = criticalPath(
        graph,
        coursesNeededAcross(chosen, { credits, have }).courses,
        have,
      );
      if (path.length === 0) return text("Nothing left with prerequisites.");

      return text(
        [
          `${path.length} terms minimum, whatever the credit load:`,
          "",
          ...path.map((c, i) => `  ${i + 1}. ${c.padEnd(11)} ${titles.get(c) ?? ""}`),
        ].join("\n"),
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
