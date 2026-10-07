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

Then turn on **Developer mode** at `chrome://extensions`, load `dist/`
unpacked, sign in to Self-Service in another tab, and open the planner. The
extension has no icon, so it is the grey puzzle piece in the toolbar.

The first student to open a term crawls it, which takes a minute or so and
fills the shared cache for everybody after them. Nothing is cached until
somebody does; there is no catalog in this repo to start from.

Optionally, `bun run companion` keeps a copy of your capture on your own
machine for the scripts under `scripts/` to read. Nothing starts it for you.

The extension is built against one origin, because the manifest has to name it
literally — `APP_ORIGIN=https://plan.example.edu bun run build` for a hosted
copy, localhost otherwise. Anyone running this builds their own; there is
nothing to install from a store.

Reading is the whole of it until you press **send to Colleague** on the plan
tab, which is the one thing here that writes to the registrar's system. It
shows the entire diff first and writes nothing until you confirm it. See
[writing a plan back](#writing-a-plan-back).

### shape

    src/client.ts        Self-Service endpoints + the antiforgery handshake
    src/content.ts       runs on selfservice.cedarville.edu; fetches, nothing else
    src/background.ts    the bridge; only whitelisted origins may call it
    src/types.ts         raw Colleague shapes, shared by both halves
    src/crawl.ts         the paging loop, over whoever has a session
    src/requirements.ts  Ellucian's 40-field Group as a tagged union
    src/merge.ts         which course satisfies a requirement in both majors
    src/schedule.ts      meeting times, seat counts, and date-aware conflicts
    src/timetable.ts     which section of each, so that nothing collides
    src/prereqs.ts       what a course needs, and what needs it
    src/planner.ts       which term each requirement lands in
    src/catalog.ts        the one shape that is public rather than personal
    src/server/colleague.ts  guest client, for wherever a guest endpoint is left
    src/server/crawler.ts    the crawl loop bound to a guest session and the store
    src/server/ingest.ts     what it takes to trust somebody else's crawl
    src/server/store.ts      SQLite cache of the section catalog
    src/client/          the planner: no framework, one CSS file, mount/destroy views
    src/client/planning.ts   one projection, shared by every tab that reads one

Four tabs, one per question a student actually asks. `build` is what is left
to decide and what each choice costs. `plan` is when it all happens, drawn as
a graph or listed by term — one computation, two renderings. `semester` takes
one term off that plan and lays it on the clock, already arranged: one section
per course, nothing overlapping, and pins where the student has chosen.
`record` is what the registrar holds.

There were six. `map` and `plan` turned out to be the same projection rendered
two ways, and `overlap` could only compare two enrolments, which a second
major recorded against the first one's program is not.

The split is by change rate. Auth bridging is stable and security-sensitive;
the planner changes every time we learn something new about Colleague. The two
halves share `types.ts` and `crawl.ts`.

Two kinds of data, and only one of them is yours. Section times, seats and
instructors are identical for every student, so they are cached in SQLite on
the server and one student's crawl spares everyone else's. An evaluation is a
student record and never leaves the machine it was fetched on. There is no
account system because there is nothing here to attach to a person.

The catalog half of that used to be the server's own work. Cedarville put the
public course search behind SSO, so the crawl now runs in whichever student's
browser gets there first and is offered back to the cache. See [crawled by
whoever is signed in](#crawled-by-whoever-is-signed-in).

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
companion on `127.0.0.1:7749`, which runs only when you start it with
`bun run companion` and by nothing else. It accepts `POST /capture` and only
from `chrome-extension://<the pinned id>`; a page cannot set its own `Origin`,
so no other tab can reach it. There is no way to read a capture back out over
the port: it takes, it never gives.

Nothing is lost when no companion runs. The post fails, the planner carries on
in the browser, and the scripts under `scripts/` say which file they were
looking for.

The same channel carries what the student decided. "Copy my plan" sends the
pins, tracks and credit load through the extension to `POST /picks`, so the
scripts answer about the degree you chose rather than the cheapest one that
fits, and say which of the two they did.

This is the only way a transcript reaches a disk, and that is deliberate.
There was briefly a second: a development route on the catalog server that
wrote whatever it was posted into `.data/`, guarded by `NODE_ENV` and by the
hostname the request arrived on. A hostname is a header the client sends, so
the guard asked the attacker whether they were an attacker — and hosting the
planner anywhere meant shipping it. The route is gone. The server writes its
SQLite catalog and nothing else, which is the whole of what it is for.

    CEDARVILLE_CAPTURE   where a capture is kept (default: XDG data dir)
    CEDARVILLE_PORT      the companion's port
    CEDARVILLE_COMPANION 0 to decline the listener entirely
    CATALOG_DB           the catalog cache (default: .data/catalog.sqlite)
    CRAWL                "off" to skip the server's own boot crawl

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
and the plan places it accordingly.

### which section to be in

The planner answers "what am I taking in the spring", which leaves a second
problem with the same shape and a much smaller search space. Each of those
courses runs in two or six or eleven sections, at most one of which you can be
in, and no two of them may put you in two rooms at once. Students do this on
paper, badly, once a semester.

`src/timetable.ts` solves it as the constraint problem it is: depth-first over
the courses with the fewest places to go first, pruning on conflict, which
searches a five-course term exhaustively in a few thousand steps. A greedy
pass that takes the nicest-looking section for the first course routinely
paints the last one into a corner, and the student cannot see why.

Which conflict-free week is better is a judgement, so it is stated rather than
buried, and compared term by term rather than weighted:

    seats   a section you cannot get into is worth less than one you can
    days    a day with nothing on it is worth more than a tidy hour
    gaps    an hour between classes is an hour spent waiting
    shape   and then whatever the student asked for

Pins come first and are never weighed at all. A student who has decided to be
in the eight o'clock section has decided; the arranger works around it and
reports what it cost — including a course it can no longer place, which is the
answer a student needs rather than a silent omission.

Seat counts are refreshed live where the extension can reach Self-Service, and
the term is arranged again when they land: "prefer a section you can get into"
is only true if the arranger knows which those are.

The interface follows from that. The week is the object, drawn the moment the
tab opens, and the course list beside it is one line each — a list of every
section's days, room, instructor and seat count is a timetable written out as
prose, and the timetable is right there. A course opens to its sections as a
radio group, hovering one draws it on the week so you can see where it would
fall, and the first option in every group hands the choice back to the
arranger. So "whose decision was this" is something you can see and change
rather than infer.

A draft in between asked for a drag onto the week. It read well written down
and badly in the hand: a section's time is fixed, so the only honest places to
drop it were the few it could already go.

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

Thirty-one courses do not even get a sentence. `HON-4910` Honors Senior
Colloquium I has no description, no requisite and no rule; the only thing in
Colleague saying it is a senior course is the word `Sr` in its title. Read
literally it is open to a freshman, and the plan put the honours colloquium in
a sophomore summer. A senior-sounding title now implies senior standing, and
parsed prose still wins wherever there is any.

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

### the catalog used to need no login

It did, once. Self-Service gated `/Student/Student/Courses/*` and served
`/Student/Courses/*` to anyone, because that is what the signed-out search
page used. The server crawled the catalog itself, anonymously, and one pass
served every student.

Cedarville moved the whole catalog behind SSO. The guest search page now
bounces to the login form, so that crawl is gone and no amount of retrying
brings it back. `GuestColleague` says so in as many words rather than blaming
a missing antiforgery token the page was never going to render.

What is left with a session is a student's browser. So the crawl moved there.

### crawled by whoever is signed in

The loop did not have to be rewritten, because it never knew who it was
talking to. Every crawl asks one question of one object:

    interface Searcher {
      search(criteria: SearchCriteria): Promise<SearchPage>
    }

`GuestColleague` satisfies it, for as long as there is a guest endpoint
anywhere. So does `SelfService`, which is the authenticated twin: the same
body and the same paging, one `/Student` more in the path. The planner wraps
that in a `Searcher` whose `search` hops through the extension, and
`src/crawl.ts` runs over either one without knowing the difference.

One page per message, not one term, so the paging, the delay between requests
and the stop button all stay on the page where the student can see them. A
term is about sixty pages in `SectionListing` view, plus half as many again in
`CatalogListing` for the requisite text.

### ingesting somebody else's crawl

Crawling per student would undo the thing the server-side crawl was for: sixty
pages per student per term, against the registrar, every time. So a crawl is
offered back.

    POST /catalog/:term/ingest

Whoever opens a term first pays for it, and everybody after them reads the
cache. The property the old design got by construction is bought back with
three guards, because a crawl the server performed was true and a crawl posted
to the server is a claim that every other student will read.

    shape         every section checked field by field, and one bad section
                  refuses the batch. A skipped section is indistinguishable
                  from a cancelled one.

    completeness  the client says whether it reached the last page, and only a
                  complete crawl may replace a term. `store.replace` deletes
                  what the crawl did not see, so a student closing the tab
                  halfway would cancel half a term.

    no shrinking  a crawl may lose up to a fifth of a term and no more.
                  Without this one, three well-formed sections and
                  `complete: true` empty the catalog for everybody.

Sections must also carry the term they were posted under, or a Fall crawl
could be written into the Spring cache, where the shrink guard counts rows
rather than reading them.

There is deliberately no identity here. There is no account system and nothing
to attach one to, so every guard is about the claim rather than the claimant. A
student with a real session can still post a plausible lie about the timetable;
what they cannot do is quietly delete it. That is the honest limit of a shared
cache with no accounts, and it is worth stating rather than implying otherwise.

`POST /catalog/:term/refresh` still exists and still crawls server-side, for
wherever a guest endpoint is open. It now refuses a term the catalog has never
heard of: terms are a closed set the registrar publishes, and accepting any
string meant one caller could start unlimited outbound crawls by inventing
spellings.

The extension is needed for two things now: your own program evaluation, which
was always personal, and the catalog, which did not used to be.

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

No session used to be needed here: the triple names a place in the catalog,
not a student, so the server resolved it anonymously and cached the answer in
SQLite, shared by everyone. The caching and the sharing still hold. The
anonymous part does not, now that the search is behind SSO, so the server
answers from cache and a miss has to wait for somebody signed in to fill it.
`DABIOL25` is five biology labs; the history elective is forty-seven courses.

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

It reads whichever capture the companion wrote, so a capture that landed in
the XDG data directory is found as readily as one in `.data/`.

Two things a prerequisite cannot say, and the planner reads both out of the
catalog rather than from a table anyone maintains. **Class standing** gates 58
courses and appears in no requisite record — it is a sentence of description
("senior status in engineering"), or nothing but the word `Sr` in a title.
**Sequences** run back to back: `CY-4820` says "Continuation of CY-4810" in its
description, `HON-4920` is paired to `HON-4910` by nothing but the numeral in
its title, and Making of the Modern Mind says it only by being one autumn
course and one spring course of the same name. A prerequisite means "later",
which is how a capstone ends up split across two academic years.

What it still does not model, each of which can move a date: the unpublished
spring catalog, and shared-credit caps between programs. The generated doc
lists them at the bottom rather than implying a precision it does not have.

### writing a plan back

Everything above reads. One thing writes, and it writes to the registrar's
system where an advisor will see it, so it is worth stating exactly.

Self-Service's own Plan & Schedule page drives five endpoints, and its script
bundle names their arguments; nothing here was guessed at.

    AddCourse     { courseId, termId, credits, degreePlan }
    UpdateCourse  { courseId, oldTerm, newTerm, degreePlan }
    RemoveCourse  { removeCourseId, removeCourseTermId, removeCourseSectionId, degreePlan }
    AddTerm       { addTermId, degreePlan }
    RemoveTerm    { removeTermId, degreePlan }

Each carries the whole plan and returns the updated copy — Ellucian's
concurrency check, since the DTO holds a `Version` and a stale one is refused.
So the writes run in sequence, each fed what the last one handed back.
`RegisterSections` sits on the same controller and is deliberately wired to
nothing: planning a course and registering for it are different promises, and
only one of them is the planner's to make.

**send to Colleague** shows the whole diff first and writes nothing until it
is confirmed. The plan on the screen is the plan, and Colleague's copy is
brought into line with it. Two things are never touched, and between them they
are the whole safety of it:

- a course carrying a **section**, which is a registration decision rather
  than a plan
- anything in a **term already under way**, or behind it — a course in
  progress sits on the degree plan too, and a projection that starts next
  spring never mentions it

Everything else is arrangement. If there is a course you want that the
projection does not know about, add it to the plan first; otherwise the next
sync withdraws it.

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
