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

/** The ids `held` uses, so a crawl can be written as "keeps most of them". */
const heldIds = (count: number) => Array.from({ length: count }, (_, i) => `held-${i}`);

/** A crawl that keeps the first `keep` of a held term, plus `extra` new ones. */
const refresh = (keep: number, extra = 0) => [
  ...heldIds(keep).map((id) => section(id)),
  ...Array.from({ length: extra }, (_, i) => section(`new-${i}`)),
];

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
    expect(ingest(db, body({ sections: refresh(2, 1) }))).toMatchObject({
      ok: true,
      replaced: true,
      changed: { kept: 2, added: 1, gone: 0 },
    });
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

describe("agreement with the term already held", () => {
  test("refuses a crawl that would gut a term", () => {
    // Without this guard, three well-formed sections and complete: true
    // empty the catalog for everybody.
    const db = store();
    held(db, 100);

    const verdict = ingest(db, body({ sections: refresh(2) }));

    expect(verdict).toMatchObject({ ok: false });
    if (!verdict.ok) expect(verdict.why).toContain("may lose up to 20% of a term");
    expect(db.read("2026FA").sections).toHaveLength(100);
    db.close();
  });

  /*
   * The hole the count-based guard left: a hundred fabricated sections are a
   * hundred sections, so a crawl could swap a real term for an invented one
   * of the same size and pass. Comparing ids means a replacement has to be
   * the term it replaces.
   */
  test("refuses a same-sized term that is a different term", () => {
    const db = store();
    held(db, 100);

    const invented = Array.from({ length: 100 }, (_, i) => section(`mine-${i}`));
    const verdict = ingest(db, body({ sections: invented }));

    expect(verdict).toMatchObject({ ok: false });
    if (!verdict.ok) expect(verdict.why).toContain("keeps 0 of the 100 sections");
    expect(db.read("2026FA").sections).toHaveLength(100);
    db.close();
  });

  test("allows the ordinary churn of late registration", () => {
    const db = store();
    held(db, 100);

    // 90 of the 100 it already had, plus five that opened: sections do get
    // cancelled and added, and refusing that would refuse every honest
    // refresh.
    const verdict = ingest(db, body({ sections: refresh(90, 5) }));
    expect(verdict).toMatchObject({ ok: true, changed: { kept: 90, added: 5, gone: 10 } });
    expect(db.read("2026FA").sections).toHaveLength(95);
    db.close();
  });

  test("a term growing is never suspicious", () => {
    const db = store();
    held(db, 10);
    expect(ingest(db, body({ sections: refresh(10, 190) })).ok).toBe(true);
    db.close();
  });

  test("and the first crawl of a term has nothing to agree with", () => {
    const db = store();
    expect(ingest(db, body({ sections: refresh(0, 300) })).ok).toBe(true);
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

  test("refuses sections posted as the whole course list", () => {
    // Sections under ALL mean the caller ran the per-term crawl and filed it
    // as the catalog, which would record one term's offerings as everything
    // that exists.
    const db = store();
    const verdict = ingest(db, body({ term: "ALL", sections: [section("s1", { TermId: "ALL" })] }));

    expect(verdict).toMatchObject({ ok: false });
    if (!verdict.ok) expect(verdict.why).toContain("every course and no sections");
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

describe("the whole course list", () => {
  /*
   * Separate from a term because a prerequisite is routinely a course nobody
   * is teaching this year. The server used to crawl this itself and SSO ended
   * that, so it arrives here instead — and until it did, a planned course
   * outside the one cached term had no title, no credits and no requisites.
   */
  const courses = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      Id: `c${i}`,
      SubjectCode: "HON",
      Number: `10${i}`,
      Title: `Honors ${i}`,
    }));

  const catalog = (over: Record<string, unknown> = {}) => ({
    term: "ALL",
    complete: true,
    sections: [],
    courses: courses(50),
    ...over,
  });

  test("accepts every course with no sections at all", () => {
    const db = store();
    const verdict = ingest(db, catalog());

    expect(verdict).toMatchObject({ ok: true, sections: 0, courses: 50, replaced: false });
    expect(db.readCourses("ALL")).toHaveLength(50);
    // And it is readable as the catalog the planner asks for by name.
    expect(db.read("ALL").courses).toHaveLength(50);
    db.close();
  });

  test("keeps the whole record, because requisites are read out of it", () => {
    const db = store();
    ingest(
      db,
      catalog({
        courses: [
          {
            Id: "c1",
            SubjectCode: "HON",
            Number: "1010",
            Title: "Making Modern Mind: Ancient",
            MinimumCredits: 3,
            TermsOffered: "Fall Only",
            CourseRequisites: [{ DisplayText: "Take HON-1000", IsRequired: true }],
          },
        ],
      }),
    );

    const [kept] = db.readCourses("ALL");
    expect(kept?.Title).toBe("Making Modern Mind: Ancient");
    expect(kept?.TermsOffered).toBe("Fall Only");
    expect(kept?.CourseRequisites?.[0]?.DisplayText).toBe("Take HON-1000");
    db.close();
  });

  test("refuses a crawl that stopped early", () => {
    const db = store();
    const verdict = ingest(db, catalog({ complete: false }));

    expect(verdict).toMatchObject({ ok: false });
    if (!verdict.ok) expect(verdict.why).toContain("a partial catalog is not one");
    db.close();
  });

  test("refuses an empty one, which is a failure rather than a catalog", () => {
    const db = store();
    const verdict = ingest(db, catalog({ courses: [] }));

    expect(verdict).toMatchObject({ ok: false });
    if (!verdict.ok) expect(verdict.why).toContain("no courses is a failed crawl");
    db.close();
  });

  test("and will not quietly replace a list with a fraction of one", () => {
    const db = store();
    ingest(db, catalog({ courses: courses(1000) }));

    const verdict = ingest(db, catalog({ courses: courses(400) }));
    expect(verdict).toMatchObject({ ok: false });
    if (!verdict.ok) expect(verdict.why).toContain("refusing to shrink the course list");
    expect(db.readCourses("ALL")).toHaveLength(1000);

    // The ordinary churn of a catalog year is fine.
    expect(ingest(db, catalog({ courses: courses(950) }))).toMatchObject({
      ok: true,
      replaced: true,
    });
    db.close();
  });
});

describe("a course that exists", () => {
  /*
   * The sections of a crawl are the part nothing can check: ten o'clock is as
   * plausible as eleven. The courses they claim to be sections *of* can be
   * checked, against the list of every course the school offers — so a crawl
   * may lie about when a real course meets, and may not invent the course.
   */
  const courseList = (ids: string[]) => ({
    term: "ALL",
    complete: true,
    sections: [],
    courses: ids.map((id, i) => ({
      Id: id,
      SubjectCode: "ACCT",
      Number: `21${i}0`,
      Title: `Accounting ${i}`,
    })),
  });

  test("refuses a section of a course in no catalog it holds", () => {
    const db = store();
    ingest(db, courseList(["c-s1", "c-s2"]));

    const verdict = ingest(
      db,
      body({
        sections: [
          section("s1"),
          section("hack", { CourseId: "c-invented", CourseName: "CS-9999" }),
        ],
      }),
    );

    expect(verdict).toMatchObject({ ok: false });
    if (!verdict.ok) expect(verdict.why).toContain("CS-9999");
    if (!verdict.ok) expect(verdict.why).toContain("no catalog this server holds");
    db.close();
  });

  test("and takes the sections of courses it does hold", () => {
    const db = store();
    ingest(db, courseList(["c-s1", "c-s2"]));
    expect(ingest(db, body()).ok).toBe(true);
    db.close();
  });

  /*
   * Checked by code rather than by id, and this is why. About 1% of codes
   * carry two records — a course being retired beside its replacement — and
   * the course list keeps one id per code while a section may reference
   * either. Written against real data: one honest section of the spring's
   * 1,728 was refused because EDEC-2300 is taught under course 5185 and
   * listed under 2868.
   */
  test("takes a section whose course id is the other of a retiring pair", () => {
    const db = store();
    ingest(db, {
      term: "ALL",
      complete: true,
      sections: [],
      courses: [{ Id: "2868", SubjectCode: "EDEC", Number: "2300", Title: "Early Childhood" }],
    });

    const verdict = ingest(
      db,
      body({
        sections: [section("160047", { CourseId: "5185", CourseName: "EDEC-2300" })],
        courses: [{ Id: "5185", SubjectCode: "EDEC", Number: "2300" }],
      }),
    );
    expect(verdict.ok).toBe(true);
    db.close();
  });

  /*
   * Until somebody has filled the course list there is nothing to check
   * against, and refusing every section would mean no server could ever be
   * filled. That is the residue: the first crawls of a fresh server are
   * trusted, and everything after them is held to what they established.
   */
  test("but checks nothing while it knows no courses at all", () => {
    const db = store();
    expect(ingest(db, body({ sections: [section("s1", { CourseId: "c-anything" })] })).ok).toBe(
      true,
    );
    db.close();
  });
});

describe("numbers a registrar could mean", () => {
  const bad = (over: Record<string, unknown>) =>
    ingest(store(), body({ sections: [section("s1", over)] }));

  test("refuses credits outside any plausible course", () => {
    expect(bad({ MinimumCredits: -3 })).toMatchObject({ ok: false });
    expect(bad({ MinimumCredits: 400 })).toMatchObject({ ok: false });
  });

  test("refuses seat counts nobody could enrol", () => {
    expect(bad({ Capacity: -1 })).toMatchObject({ ok: false });
    expect(bad({ Enrolled: 5_000_000 })).toMatchObject({ ok: false });
    expect(bad({ Available: 5_000_000 })).toMatchObject({ ok: false });
  });

  // An override really does over-enrol a section, and the registrar reports
  // the result as a negative number of seats left.
  test("but takes the negative seat count of an over-enrolled section", () => {
    expect(bad({ Capacity: 30, Enrolled: 32, Available: -2 })).toMatchObject({ ok: true });
  });

  test("and takes the ones a real section carries", () => {
    const db = store();
    expect(
      ingest(db, body({ sections: [section("s1", { MinimumCredits: 8, Capacity: 300 })] })).ok,
    ).toBe(true);
    db.close();
  });
});
