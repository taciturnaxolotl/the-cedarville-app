/*
 * When a crawl is worth the pages.
 *
 * The shell decides this, and the decision is easy to get subtly wrong in a
 * way nobody notices: too eager and every page load spends forty pages of
 * somebody's session, too lazy and a student plans a term against last
 * week's timetable. The rule is two sentences — a press always refreshes,
 * and otherwise a day-old copy does — so it is worth pinning as arithmetic
 * rather than as behaviour nobody re-reads.
 */

import { describe, expect, test } from "bun:test";
import { COURSE_LIST_HOURS, olderThan, planFor, since, TERM_HOURS } from "./freshness";

const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();

/** The shell's decision, asked the way the shell asks it. */
const decide = (
  { force, sections, fetchedAt }: { force: boolean; sections: number; fetchedAt?: string },
  installed = true,
) => planFor({ sections, ...(fetchedAt ? { fetchedAt } : {}) }, { force, installed });

describe("a term", () => {
  test("a press always re-crawls, however fresh the copy", () => {
    expect(decide({ force: true, sections: 1806, fetchedAt: ago(0) })).toBe("crawl");
    expect(decide({ force: true, sections: 1806, fetchedAt: ago(1) })).toBe("crawl");
  });

  test("a fresh copy is fetched rather than crawled", () => {
    expect(decide({ force: false, sections: 1806, fetchedAt: ago(1) })).toBe("fetch");
    expect(decide({ force: false, sections: 1806, fetchedAt: ago(23.9) })).toBe("fetch");
  });

  test("a day old is worth the pages again", () => {
    expect(decide({ force: false, sections: 1806, fetchedAt: ago(24.1) })).toBe("crawl");
    expect(decide({ force: false, sections: 1806, fetchedAt: ago(72) })).toBe("crawl");
  });

  test("a term nobody has crawled is crawled whatever its age says", () => {
    expect(decide({ force: false, sections: 0, fetchedAt: ago(0) })).toBe("crawl");
    expect(decide({ force: false, sections: 1806, fetchedAt: undefined })).toBe("crawl");
  });

  /*
   * Crawling takes a session, so without the extension a stale copy is the
   * best there is — served, with the reason said out loud, rather than
   * refused for being old.
   */
  test("without the bridge, a stale copy beats nothing", () => {
    expect(decide({ force: true, sections: 1806, fetchedAt: ago(100) }, false)).toBe("fetch");
    expect(decide({ force: false, sections: 0, fetchedAt: undefined }, false)).toBe("refuse");
  });
});

describe("the course list", () => {
  /*
   * A week rather than a day, because this is catalog-year data: what exists,
   * with its requisites and seasons. Re-reading twenty-one pages of it daily
   * would be waste, and it is the thing a plan reads requisites out of.
   */
  test("is kept for a week, not a day", () => {
    expect(olderThan(COURSE_LIST_HOURS, ago(25))).toBe(false);
    expect(olderThan(COURSE_LIST_HOURS, ago(24 * 6))).toBe(false);
    expect(olderThan(COURSE_LIST_HOURS, ago(24 * 8))).toBe(true);
  });

  test("and a term is not", () => {
    expect(olderThan(TERM_HOURS, ago(25))).toBe(true);
  });

  test("never crawled reads as stale, not as fresh", () => {
    expect(olderThan(COURSE_LIST_HOURS, undefined)).toBe(true);
    // The epoch, which is what an undated copy used to report.
    expect(olderThan(COURSE_LIST_HOURS, new Date(0).toISOString())).toBe(true);
  });
});

describe("how long ago", () => {
  const at = (hours: number) => new Date(Date.UTC(2027, 0, 20, 12) - hours * HOUR).toISOString();
  const now = Date.UTC(2027, 0, 20, 12);
  const said = (hours: number) => since(at(hours), now);

  test("picks the unit a person would have picked", () => {
    expect(said(0)).toBe("just now");
    expect(said(0.5)).toBe("30 minutes ago");
    expect(said(2)).toBe("2 hours ago");
    expect(said(26)).toBe("yesterday");
    expect(said(24 * 4)).toBe("4 days ago");
  });

  test("a clock a little ahead of the server reads as now, not as the future", () => {
    // Skew is ordinary; a planner claiming tomorrow's timetable is not.
    expect(since(new Date(now + 20_000).toISOString(), now)).toBe("just now");
  });

  test("never crawled says so rather than dating from the epoch", () => {
    expect(since(undefined, now)).toBe("never");
    expect(since("not a date", now)).toBe("never");
  });

  /*
   * The epoch is what an undated copy used to report, and it is worth
   * reading as absurd rather than as missing: "57 years ago" sends somebody
   * to look, where "never" would be quietly believed.
   */
  test("and the epoch reads as the nonsense it is", () => {
    expect(since(new Date(0).toISOString(), now)).toContain("years ago");
  });
});
