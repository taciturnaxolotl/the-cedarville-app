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
    src/catalog.ts       the one shape that is public rather than personal
    src/server/store.ts  SQLite cache of the section catalog
    src/client/crawl.ts  the fetch loop: cache-aware, paced, cancellable
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

### conflicts are date-aware

A 16-week term routinely contains 8-week sessions, so two sections can share a
weekday and an hour and never coexist. Every meeting carries its own date
range and every comparison uses it; a day-and-time check alone invents clashes
and makes half the catalog look unschedulable.

Loading sections fetches only courses that could still close an open
requirement, skips anything the shared cache already answers, paces itself, and
can be cancelled. It is someone's registrar, not a load test.

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
