import { describe, expect, test } from "bun:test";
import { ingest } from "./ingest";
import { CatalogStore } from "./store";

/** ":memory:" keeps each test's database to itself. */
const store = () => new CatalogStore(":memory:");

const section = (id: string, over: Record<string, unknown> = {}) => ({
  Id: id,
  CourseId: `c-${id}`,
  CourseName: "ACCT-2110",
  TermId: "2026FA",
  MinimumCredits: 3,
  Capacity: 30,
  Enrolled: 10,
  Available: 20,
  Meetings: [],
  ...over,
});

const body = (over: Record<string, unknown> = {}) => ({
  term: "2026FA",
  complete: true,
  sections: [section("s1"), section("s2")],
  courses: [{ Id: "c-s1", SubjectCode: "ACCT", Number: "2110" }],
  ...over,
});

/** Fills a term so the shrink guard has something to protect. */
function held(db: CatalogStore, count: number) {
  db.replace({
    term: "2026FA",
    fetchedAt: "2026-08-12T00:00:00.000Z",
    sections: Array.from({ length: count }, (_, i) => section(`held-${i}`)) as never,
  });
}

describe("a crawl the server can use", () => {
  test("accepts a complete crawl of a term nobody has filled", () => {
    const db = store();
    const verdict = ingest(db, body());

    expect(verdict).toMatchObject({ ok: true, sections: 2, courses: 1, replaced: false });
    expect(db.read("2026FA").sections).toHaveLength(2);
    db.close();
  });

  test("says when it replaced data rather than filling a gap", () => {
    const db = store();
    held(db, 2);
    expect(ingest(db, body())).toMatchObject({ ok: true, replaced: true });
    db.close();
  });

  test("carries the whole section through, not just the validated fields", () => {
    // The schema names nine fields; a section holds dozens, and the schedule
    // is built from the meeting times that are not named here.
    const db = store();
    ingest(
      db,
      body({
        sections: [section("s1", { FormattedMeetingTimes: [{ Days: "MWF" }], Synonym: "12345" })],
      }),
    );

    const [stored] = db.read("2026FA").sections;
    expect(stored).toMatchObject({ Synonym: "12345", FormattedMeetingTimes: [{ Days: "MWF" }] });
    db.close();
  });
});

describe("shape", () => {
  test("refuses a batch for one bad section rather than skipping it", () => {
    // A skipped section is indistinguishable from a cancelled one, and
    // `replace` deletes what the crawl did not report.
    const db = store();
    const verdict = ingest(db, body({ sections: [section("s1"), { Id: "s2" }] }));

    expect(verdict.ok).toBe(false);
    expect(db.read("2026FA").sections).toHaveLength(0);
    db.close();
  });

  test("names the field that was wrong", () => {
    const db = store();
    const verdict = ingest(db, body({ sections: [section("s1", { Capacity: "lots" })] }));

    expect(verdict).toMatchObject({ ok: false });
    if (!verdict.ok) expect(verdict.why).toContain("Capacity");
    db.close();
  });

  test("a section with no id is refused, because the id is the key", () => {
    const db = store();
    expect(ingest(db, body({ sections: [section("")] })).ok).toBe(false);
    db.close();
  });

  test("unknown fields are allowed through, so an upstream addition is not an outage", () => {
    const db = store();
    const verdict = ingest(
      db,
      body({ sections: [section("s1", { SomethingEllucianAddedLastTuesday: true })] }),
    );
    expect(verdict.ok).toBe(true);
    db.close();
  });

  test("refuses something that is not a crawl at all", () => {
    const db = store();
    for (const junk of [null, 42, "2026FA", [], {}]) {
      expect(ingest(db, junk).ok).toBe(false);
    }
    db.close();
  });
});

describe("completeness", () => {
  test("refuses a crawl that stopped early", () => {
    const db = store();
    const verdict = ingest(db, body({ complete: false }));

    expect(verdict).toMatchObject({ ok: false });
    if (!verdict.ok) expect(verdict.why).toContain("partial");
    db.close();
  });

  test("an incomplete crawl leaves a filled term exactly as it was", () => {
    // The failure this guard exists for: a student closes the tab halfway,
    // and the term loses the sections the crawl never reached.
    const db = store();
    held(db, 40);
    ingest(db, body({ complete: false }));
    expect(db.read("2026FA").sections).toHaveLength(40);
    db.close();
  });

  test("refuses an empty crawl, which is a failure rather than an empty term", () => {
    const db = store();
    expect(ingest(db, body({ sections: [] })).ok).toBe(false);
    db.close();
  });
});

describe("no shrinking", () => {
  test("refuses a crawl that would gut a term", () => {
    // Without this guard, three well-formed sections and complete: true
    // empty the catalog for everybody.
    const db = store();
    held(db, 100);

    const verdict = ingest(db, body({ sections: [section("s1"), section("s2")] }));

    expect(verdict).toMatchObject({ ok: false });
    if (!verdict.ok) expect(verdict.why).toContain("shrink");
    expect(db.read("2026FA").sections).toHaveLength(100);
    db.close();
  });

  test("allows the ordinary churn of late registration", () => {
    const db = store();
    held(db, 100);

    // 90 of 100: sections do get cancelled, and refusing that would refuse
    // every honest refresh.
    const sections = Array.from({ length: 90 }, (_, i) => section(`s${i}`));
    expect(ingest(db, body({ sections })).ok).toBe(true);
    expect(db.read("2026FA").sections).toHaveLength(90);
    db.close();
  });

  test("a term growing is never suspicious", () => {
    const db = store();
    held(db, 10);
    const sections = Array.from({ length: 200 }, (_, i) => section(`s${i}`));
    expect(ingest(db, body({ sections })).ok).toBe(true);
    db.close();
  });
});

describe("a crawl must be about the term it claims", () => {
  test("refuses sections belonging to another term", () => {
    // Mixing terms would write Fall sections into the Spring cache, and the
    // shrink guard counts rows rather than reading them.
    const db = store();
    const verdict = ingest(
      db,
      body({ sections: [section("s1"), section("s2", { TermId: "2027SP" })] }),
    );

    expect(verdict).toMatchObject({ ok: false });
    if (!verdict.ok) expect(verdict.why).toContain("2027SP");
    db.close();
  });

  test("refuses the sentinel the whole catalog lives under", () => {
    const db = store();
    const verdict = ingest(db, body({ term: "ALL", sections: [section("s1", { TermId: "ALL" })] }));

    expect(verdict).toMatchObject({ ok: false });
    if (!verdict.ok) expect(verdict.why).toContain("not a term");
    db.close();
  });

  test("refuses a term code long enough to be something else", () => {
    const db = store();
    expect(ingest(db, body({ term: "x".repeat(64) })).ok).toBe(false);
    db.close();
  });
});

describe("a term the registrar could have issued", () => {
  /*
   * The route is open by design — there is no account system and nothing to
   * attach one to — so every guard is about the claim rather than the
   * claimant. This is the one that keeps a hosted cache from growing a table
   * per invented name.
   */
  test("refuses a term that is not a term code", () => {
    for (const term of ["LOL", "2026", "FA2026", "2026fa", "2026FALL", "../etc"]) {
      const verdict = ingest(store(), body({ term, sections: [section("s1", { TermId: term })] }));
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.why).toContain("not a term code");
    }
  });

  test("refuses a term nobody could be enrolled in", () => {
    const far = `${new Date().getFullYear() + 40}SP`;
    const verdict = ingest(
      store(),
      body({ term: far, sections: [section("s1", { TermId: far })] }),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.why).toContain("outside the years this catalog keeps");
  });

  test("and takes the three seasons Colleague actually names", () => {
    const year = new Date().getFullYear() + 1;
    for (const season of ["SP", "SU", "FA"]) {
      const term = `${year}${season}`;
      const verdict = ingest(store(), body({ term, sections: [section("s1", { TermId: term })] }));
      expect(verdict.ok).toBe(true);
    }
  });
});
