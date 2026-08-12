# the-cedarville-app

the everything app :D

## course planning

Colleague Self-Service gates every endpoint behind a student session, so the
data has to be fetched from inside a browser that already has one. That is the
extension's entire job. Everything else is a static page.

```sh
bun install
bun run dev        # builds both, serves the planner on :5173
```

Then load `dist/` unpacked at `chrome://extensions`, sign in to Self-Service in
another tab, and click capture.

### shape

    src/client.ts        Self-Service endpoints + the antiforgery handshake
    src/content.ts       runs on selfservice.cedarville.edu; fetches, nothing else
    src/background.ts    the bridge; only whitelisted origins may call it
    src/types.ts         raw Colleague shapes, shared by both halves
    src/requirements.ts  Ellucian's 40-field Group as a tagged union
    src/merge.ts         which course satisfies a requirement in both majors
    src/schedule.ts      meeting times, seat counts, and date-aware conflicts
    src/prereqs.ts       what a course needs, and what needs it
    src/catalog.ts        the one shape that is public rather than personal
    src/server/colleague.ts  guest client: the catalog needs no session
    src/server/crawler.ts    one term per crawl, ~60 pages
    src/server/store.ts      SQLite cache of the section catalog
    src/client/          the planner: no framework, one CSS file, mount/destroy views

The split is by change rate. Auth bridging is stable and security-sensitive;
the planner changes every time we learn something new about Colleague. The two
halves share only `types.ts`.

Two kinds of data, and only one of them is yours. Section times, seats and
instructors are identical for every student, so they are cached in SQLite on
the server and one student's crawl spares everyone else's. An evaluation is a
student record and never leaves their browser. There is no account system
because there is nothing here to attach to a person.

### what it refuses to guess

Colleague states some requirements as opaque server-side rules (`DABIOL25`,
"one laboratory course from the biological sciences") and some as department
filters that no evaluation endpoint resolves. Those are reported as
`unresolved` rather than matched loosely, because a planner padded with maybes
is worse than a shorter honest one. Schools also cap credits shared between
two majors, and that policy lives in the academic catalog, not the API: pass
`sharedCreditCap` to `merge` to have it checked.

### what blocks what

Colleague states requisites as a rule id it never expands, but it also ships
the registrar's own wording: "Take CS-1220", plus a line saying whether that
must come before, alongside, or is merely recommended. That text is the only
machine-readable prerequisite data there is, so `src/prereqs.ts` parses it.

Of 373 courses with requisites in Fall 2026, 325 parse cleanly. The other 48
say things like "junior status", "permission of instructor", or "acceptance
into the PA program". Those gate a course just as hard, so they report as
`unknown` rather than `open` — telling a student they are eligible when they
are not is the one failure worth engineering against.

The graph gives three things worth planning around: whether you can take a
course now, which courses it would unlock, and how deep its chain runs. A
course gating eleven others belongs earlier in a degree than one gating none,
and the schedule view sorts on exactly that.

### two traps in the timetable

Meeting times arrive as UTC pinned to an arbitrary reference date: an 11:00 AM
class is `2026-08-11T15:00:00+00:00`. Reading the hour out of that string puts
every class four hours late. Prefer `StartTimeDisplay`, which is what the
registrar shows and carries no timezone; convert the instant only when it is
the only source.

### conflicts are date-aware

A 16-week term routinely contains 8-week sessions, so two sections can share a
weekday and an hour and never coexist. Every meeting carries its own date
range and every comparison uses it; a day-and-time check alone invents clashes
and makes half the catalog look unschedulable.

### the catalog needs no login

Self-Service gates `/Student/Student/Courses/*` but serves `/Student/Courses/*`
to anyone: it is what the signed-out search page uses. One search in
`SectionListing` view returns sections directly, so a whole term is about sixty
pages rather than one request per course.

The server therefore crawls the catalog itself, anonymously, on boot and then
whenever a term's cache passes six hours old, and caches it in SQLite. It
checks every thirty minutes rather than every six hours: ticking at exactly
the staleness threshold means the catalog is always a few seconds too young
when the timer fires, so every other cycle gets skipped and the real cadence
quietly doubles. Fall 2026 is 1784 sections across 943
courses and takes about thirty seconds. No student session is spent on data
that is identical for all of them, and the registrar sees one crawl instead of
one per user.

The extension is then only needed for the one thing that is genuinely
personal: your own program evaluation.

### mcp

An MCP server exposes the catalog, and optionally your own requirements, as
tools. Add it to Claude Code with:

```sh
claude mcp add cedarville -- bun /abs/path/to/the-cedarville-app/src/mcp/server.ts
```

Five tools are always available, over public catalog data:
`list_terms`, `search_courses`, `course_details`, `list_sections`,
`check_conflicts`.

Three more read a captured evaluation, and are **only registered when the
server is started with `--personal`** (or `CEDARVILLE_MCP_PERSONAL=1`):
`my_requirements`, `my_eligibility`, `compare_programs`.

The opt-in is structural, not a runtime check. Without the flag those tools do
not appear in `tools/list` and calling one returns "tool not found" — there is
nothing to refuse, because nothing is registered. Every tool is read-only;
none of them can register for a class or write anything back to Colleague.

The server reads `.data/catalog.sqlite` directly, so the planner server does
not need to be running, but a crawl must have happened at least once.

### dumping a session (local only)

Some of Colleague is genuinely personal and needs your own login: the program
list, and any what-if evaluation. For poking at those from a shell rather than
clicking through the extension:

```sh
# Chrome devtools -> Network -> any XHR on selfservice.cedarville.edu
# -> right click -> Copy -> Copy as cURL
pbpaste | bun scripts/session.ts save
bun scripts/session.ts check

bun scripts/as-me.ts programs minor
bun scripts/as-me.ts evaluate BS.CMPEG
```

`document.cookie` will not do: `.ASPXAUTH` is HttpOnly, so the cookie that
matters is invisible to page scripts.

This is a development convenience and deliberately not part of the app. That
cookie is the whole student account, including the ability to register and
drop classes, so it is filtered down to the four cookies Self-Service actually
authenticates with, written to `.data/session.json` at mode 0600, and never
sent anywhere. The server holds only the public catalog and the extension
holds no credentials at all; neither of them ever reads this file.

Tests run with `test/setup.ts` preloaded, which pins `CATALOG_DB` to
`:memory:`. Without it a stray import of `serve.ts` would open the real
catalog database from a test.

The canonical repo for this is hosted on tangled over at [`https://tangled.org/dunkirk.sh/the-cedarville-app`](https://tangled.org/dunkirk.sh/the-cedarville-app)

<p align="center">
    <img src="https://raw.githubusercontent.com/taciturnaxolotl/carriage/main/.github/images/line-break.svg" />
</p>

<p align="center">
    <i><code>&copy; 2026-present <a href="https://dunkirk.sh">Kieran Klukas</a></code></i>
</p>

<p align="center">
    <a href="https://tangled.org/dunkirk.sh/the-cedarville-app/blob/main/LICENSE.md"><img src="https://img.shields.io/static/v1.svg?style=for-the-badge&label=License&message=MIT&logoColor=d9e0ee&colorA=363a4f&colorB=b7bdf8"/></a>
</p>
