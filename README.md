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
    src/planner.ts       which term each requirement lands in
    src/catalog.ts        the one shape that is public rather than personal
    src/server/colleague.ts  guest client: the catalog needs no session
    src/server/crawler.ts    one term per crawl, ~60 pages
    src/server/store.ts      SQLite cache of the section catalog
    src/client/          the planner: no framework, one CSS file, mount/destroy views
    src/client/planning.ts   one projection, shared by every tab that reads one

Four tabs, one per question a student actually asks. `build` is what is left
to decide and what each choice costs. `plan` is when it all happens, drawn as
a graph or listed by term — one computation, two renderings. `schedule` is
what to register for. `record` is what the registrar holds.

There were six. `map` and `plan` turned out to be the same projection rendered
two ways, and `overlap` could only compare two enrolments, which a second
major recorded against the first one's program is not.

The split is by change rate. Auth bridging is stable and security-sensitive;
the planner changes every time we learn something new about Colleague. The two
halves share only `types.ts`.

Two kinds of data, and only one of them is yours. Section times, seats and
instructors are identical for every student, so they are cached in SQLite on
the server and one student's crawl spares everyone else's. An evaluation is a
student record and never leaves the machine it was fetched on. There is no
account system because there is nothing here to attach to a person.

### deploying without deploying anyone's transcript

That promise used to be kept by accident: the planner only ran on localhost,
so a capture had nowhere else to go. Hosting the page would have broken it
quietly, which is the worst way for a promise like that to break.

So the halves are split by what they may hold, not by where they run.

    catalog server   public, deployable   sections, courses, rules
    companion        127.0.0.1 only       one capture, on your machine
    extension        the only bridge      fetches, then hands over

`APP_ORIGIN=https://plan.example.edu bun run build` writes the manifest with
that origin allowed to talk to the extension, alongside localhost so a
development build keeps working. The extension posts each capture to a
companion on `127.0.0.1:7749` — started by the MCP server under `--personal`,
and by nothing else. It accepts `POST /capture` and only from
`chrome-extension://<the pinned id>`; a page cannot set its own `Origin`, so no
other tab can reach it. There is no way to read a capture back out over the
port: it takes, it never gives.

Nothing is lost when no companion runs. The post fails, the planner carries on
in the browser, and the MCP server says which file it was looking for.

The same channel carries what the student decided. "Copy my plan" sends the
pins, tracks and credit load through the extension to `POST /picks`, so the
planning tools answer about the degree you chose rather than the cheapest one
that fits — and say which of the two they did.

    CEDARVILLE_CAPTURE   where a capture is kept (default: XDG data dir)
    CEDARVILLE_PORT      the companion's port
    CEDARVILLE_COMPANION 0 to decline the listener entirely

### what it refuses to guess

Colleague states some requirements as opaque server-side rules (`DABIOL25`,
"one laboratory course from the biological sciences") and some as department
filters that no evaluation endpoint resolves. Those are reported as
`unresolved` rather than matched loosely, because a planner padded with maybes
is worse than a shorter honest one. Schools also cap credits shared between
two majors, and that policy lives in the academic catalog, not the API: pass
`sharedCreditCap` to `merge` to have it checked.

### the second major nobody evaluates

A student in two majors has one enrolment. `BS.CYOPR` lists both cyber
operations and computer science under `Majors`, ships requirement blocks for
cyber operations alone, and says nothing about the omission — so a planner
reading the response at face value quietly plans half a degree. The headings
give it away: every block is named "<credential> Major Requirements", so a
credential with no block of its own is one Colleague never answered. Those are
evaluated separately by program code and reported as enrolled, because the
registrar has the student in them.

The same asymmetry runs through the transcript. Each evaluation reports only
the credit its own requirements consumed, so anything reading history reads
every tree, or it offers to buy a course the second major already paid for.

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

### what an advisor changed by hand

A degree audit is mostly Colleague talking to itself. The exception is a
modification: a human wrote "8/20/26: EGGN-1110 permitted to replace
EGGN-1910." and hung it on one requirement group. Colleague applies the credit
and then goes on listing the replaced course, so a planner reading the course
list alone schedules a semester of work the registrar already excused.

Those messages are parsed, and only where they were granted. A substitution is
made against a requirement rather than against a student, so a second major
can still be asking for the course the first one dropped — which is a real
question for an advisor, and is reported as one rather than assumed either
way. The replacement must also be on the transcript: a permission granted is
not a course taken.

A message that does not parse is shown verbatim. An advisor's note is the one
line of an audit a person wrote on purpose, and failing to read it is no
reason to hide it.

### the gates that are only prose

Of 906 requisites in the catalog, 82 say something no parser should pretend to
understand: "acceptance into the PA program", "permission of instructor",
"undergraduate course or equivalent competency in microeconomics". Those stay
`unknown`, which is the honest answer.

One kind is worth reading, though, because it decides *when* rather than
whether. 58 courses gate on class standing, and 261 name a prerequisite in
their description that no requisite record carries — `EGGN-4010` Senior
Seminar has no requisites at all, and the whole of its condition is the
sentence "Prerequisite: senior status in engineering". Read literally, it is
open to a freshman, and the plan put it in one. Standing is now parsed out of
that prose and checked against the credits a student will hold when the term
starts, against the catalog's own table: sophomore at 31 hours, junior at 61,
senior at 91. That table is printed in the catalog and reachable by no API, so
it lives in `STANDING_CREDITS` where one edit follows a policy change.

The rest of those descriptions were left alone on purpose: only ten of the 261
name a course code, and the other 251 are admissions and permissions that no
amount of parsing turns into a date.

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

Seven tools are always available, over public catalog data:
`list_terms`, `search_courses`, `course_details`, `list_sections`,
`check_conflicts`, `live_seats`, `refresh_catalog`.

Those last two are the ones that touch the network. `live_seats` asks the
registrar for current seat counts on a handful of named courses and prints
them beside what the last crawl saw, which is what you want during
registration; `refresh_catalog` re-crawls a whole term and takes about a
minute.

Five more read a captured evaluation, and are **only registered when the
server is started with `--personal`** (or `CEDARVILLE_MCP_PERSONAL=1`):
`my_requirements`, `my_eligibility`, `compare_programs`, `plan_terms`,
`critical_path`.

The opt-in is structural, not a runtime check. Without the flag those tools do
not appear in `tools/list` and calling one returns "tool not found" — there is
nothing to refuse, because nothing is registered. Nothing writes to Colleague;
no tool can register for a class or drop one, and the only writes are into the
local catalog cache.

The server reads `.data/catalog.sqlite` directly, so the planner server does
not need to be running, but a crawl must have happened at least once.

### one course list, any major

Colleague encodes choice with two counts: a requirement may need only
`MinSubrequirements` of its subrequirements, and a subrequirement only
`MinGroups` of its groups. That is how tracks, concentrations and "satisfy the
global-awareness rule any one of six ways" are all expressed.

Choose-from groups are then solved *together* rather than one at a time,
because Colleague lets a single course count toward several requirements at
once: three of one student's completed courses are applied to two groups each,
`MATH-1705` satisfying both the general-education quantitative slot and the
major's cognates. Picking per group in isolation buys a second course for a
requirement already met.

That is weighted greedy set cover — take whichever course closes the most
remaining credit per credit spent. Exact set cover is NP-hard, the greedy
bound is comfortably good enough for a few dozen requirements, and unlike an
exact solver its choices stay explainable.

`coursesNeeded` reads those counts and returns the cheapest satisfying path,
which is what makes the planner work for any major rather than the one it was
written against. Before it, every alternative looked mandatory — a plan could
demand Greek *and* Spanish, and the only way to get sensible output was a
hardcoded list of the CS major's track names.

Groups it cannot enumerate — a Colleague rule, or a filter over attributes the
evaluation does not carry — come back separately as `unenumerable`, each
carrying the ids needed to expand it. Hand the expansions back through
`NeedOptions.resolved` and they join the same cover as everything else, which
is how a course bought for one requirement ends up paying for a rule-based one
too. Two passes: name the groups, resolve them, solve once.

### what exists vs what is offered

Two crawls, and they answer different questions. The per-term crawl says what
runs when; a term-less `CatalogListing` crawl says what the school teaches at
all, stored under the `ALL` sentinel.

They cannot be one crawl, because a prerequisite is routinely a course nobody
is teaching this year. `EGEE-2010` roots a four-course engineering chain and
appears in neither cached term. Built from term-scoped data alone the graph
held 1010 nodes and was missing 99 of the 277 courses named as prerequisites
— 36% — silently reporting depth 1 where the truth was 5.

With the full catalog: 2027 nodes, 27 missing, and the chains measure right.

The 27 that remain are not gaps in the crawl. Each entering class is locked to
a catalog year, and courses are retired and renumbered between them, so
requisite text outlives the catalog it was written under. `MATH-1720` was
Calculus II, is named by five courses, and no longer exists — today it is
`MATH-1715`. A few entries also carry transposed subject codes (`CLUM` for
`CLMU`, `EDMU` for `MUED`) or name subjects that are gone.

Where Colleague *does* track the drift, it is worth using. `EquatedCourseIds`
declares which courses count as each other — `ENGR-1910` is now `EGCP-1010`,
`COM-1410` is now `THTR-1410` — and it is published on section records, not on
the catalog view. Harvesting it yields 323 linked codes, so a transcript
carrying an older catalog's codes still matches modern requirements.

It resolves only 3 of the 27 phantoms, and the reason is worth stating.
Cedarville reworked its calculus sequence: Calculus I and II went from 5
credits to 4 and were renumbered, and Calculus III was split in two.

    retired                    current
    MATH-1710  Calc I    5cr   MATH-1705  Calculus I     4cr
    MATH-1720  Calc II   5cr   MATH-1715  Calculus II    4cr
    MATH-2710  Calc III  5cr   MATH-2705  Calculus IIIA  3cr
                               MATH-2715  Calculus IIIB  3cr

Different credit hours mean different courses, and Colleague equates none of
them. Inferring equivalence from adjacent numbers would tell a student a
requirement is met when it is not, so `buildEquivalences` only ever reads what
the registrar declared.

The transition is half-finished in the data. Six requisites were updated to
accept either ("Take MATH-2705 or MATH-2710"); nine still name only the
retired course, including `MATH-2210 Logic & Methods of Proof`, which is a
mathematics core requirement gated on a course nobody can enrol in. Those
report `unknown` with an explanation rather than blocking forever — and while
a *reachable* prerequisite is still outstanding, "blocked on MATH-2705" stays
the answer, because it is the one a student can act on.

The same drift shows up a second way: about 1% of course codes carry two
records, a course being retired beside its replacement, both live during the
transition. Colleague tells them apart by id and picks per the student's
catalog year. Requisite text only ever names a code, so a graph keyed by code
has to choose one — `dedupeByCode` prefers the record actually being taught
rather than whichever the crawl saw last.

That matters because a prerequisite naming a course nobody can take marks its
dependents permanently unreachable — 17 courses were blocked forever on
phantoms. `eligibility` takes an optional `exists` check and reports those as
`unknown` with an explanation, rather than as a wall. It does not guess that
`MATH-1720` means `MATH-1715`: the numbers are close, the meaning is not
certain, and quietly substituting one for the other is how a planner tells a
student something false.

### expanding a rule

An evaluation never says which courses satisfy `DABIOL25`, but the course
search does: `PostSearchCriteria` accepts a requirement / subrequirement /
group triple and Colleague evaluates its own rule. That is what the "Search
for courses" button in the degree audit calls.

```
POST /rules/resolve   [{requirement, subrequirement, group}, …]
```

No session is needed — the triple names a place in the catalog, not a student
— so the server resolves it anonymously and caches the answer in SQLite,
shared by everyone. `DABIOL25` is five biology labs; the history elective is
forty-seven courses.

One kind is deliberately not expanded. A filter naming no subject and no
department ("32 hours of upper-division work") matches most of the catalog and
is satisfied incidentally by the courses a degree already requires. Expanding
one and filling it cheapest-first produces thirty-two 1-credit independent
studies: arithmetically valid, obvious nonsense. Those are flagged `bucket`
and reported rather than scheduled.

### planning

`src/planner.ts` answers the question a credit total cannot: *when*. Credits
set a floor, but a four-deep prerequisite chain cannot be compressed by taking
a heavier load, and a spring-only course cannot move to autumn.

```sh
bun scripts/plan-doc.ts     # writes .data/plan.md
```

The same engine backs the `plan_terms` and `critical_path` MCP tools. Four
things it deliberately does not model, each of which can move a date: class
standing (so senior capstones may be placed years early), coherence within a
language sequence, the unpublished spring catalog, and shared-credit caps
between programs. The generated doc lists them at the bottom rather than
implying a precision it does not have.

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

Two things cost an hour to learn, so they are worth writing down. Cookies are
kept by *prefix*, because ASP.NET splits an oversized cookie into a base plus
numbered chunks and an exact-match filter keeps the chunks while dropping the
base. And a GET must **not** send `X-Requested-With`: it makes Colleague treat
the request as AJAX, demand an antiforgery token, and answer 400 with a message
indistinguishable from a dead session. POSTs do need a token, scraped from an
authenticated page so it pairs with the cookie already held.

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
