/*
 * The crawl loop, with the bridge stubbed. What matters here is not that it
 * fetches but that it skips what the shared cache already knows, reports
 * progress a human can read, and stops when told.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { ageInHours, emptyCatalog, known, mergeCatalogs, type TermCatalog } from "../catalog";
import type { SectionsResponse } from "../types";

const sectionIds = mock(async (courseIds: string[], _term: string) =>
  courseIds.map((id) => ({
    courseId: id,
    courseName: `SUBJ-${id}`,
    // "gone" stands in for a course not taught this term.
    sectionIds: id === "gone" ? [] : [`s-${id}`],
  })),
);

const sections = mock(
  async (courseId: string, _ids: string[]) =>
    ({
      SectionsRetrieved: { Course: { Id: courseId }, TermsAndSections: [] },
    }) as unknown as SectionsResponse,
);

mock.module("./bridge", () => ({ sectionIds, sections }));
const { Cancelled, crawl } = await import("./crawl");

afterEach(() => {
  sectionIds.mockClear();
  sections.mockClear();
});

const run = (courseIds: string[], have?: TermCatalog, extra = {}) =>
  crawl({ courseIds, term: "26/FA", have, delayMs: 0, ...extra });

describe("crawl", () => {
  test("fetches every course and records the ones not taught", async () => {
    const catalog = await run(["a", "b", "gone"]);
    expect(Object.keys(catalog.sections).sort()).toEqual(["a", "b"]);
    expect(catalog.notOffered).toEqual(["gone"]);
    expect(sections).toHaveBeenCalledTimes(2);
  });

  test("skips what the shared cache already answers", async () => {
    const have = mergeCatalogs(emptyCatalog("26/FA"), {
      ...emptyCatalog("26/FA"),
      sections: { a: {} as SectionsResponse },
      notOffered: ["gone"],
    });

    const catalog = await run(["a", "b", "gone"], have);
    // Only "b" was unknown.
    expect(sections).toHaveBeenCalledTimes(1);
    expect(Object.keys(catalog.sections).sort()).toEqual(["a", "b"]);
    expect(catalog.notOffered).toEqual(["gone"]);
  });

  test("reports progress that counts only the work left to do", async () => {
    const have: TermCatalog = { ...emptyCatalog("26/FA"), notOffered: ["gone"] };
    const seen: string[] = [];
    let last = { done: 0, total: 0, cached: 0 };

    await run(["a", "b", "gone"], have, {
      onProgress: (p: { done: number; total: number; current: string; cached: number }) => {
        if (p.current) seen.push(p.current);
        last = p;
      },
    });

    expect(last).toMatchObject({ done: 2, total: 2, cached: 1 });
    expect(seen).toContain("SUBJ-a");
  });

  test("stops when cancelled and does not keep fetching", async () => {
    const controller = new AbortController();
    const promise = run(["a", "b", "c"], undefined, {
      signal: controller.signal,
      onProgress: ({ done }: { done: number }) => {
        if (done === 1) controller.abort();
      },
    });

    await expect(promise).rejects.toBeInstanceOf(Cancelled);
    expect(sections.mock.calls.length).toBeLessThan(3);
  });

  test("an empty course list is a no-op, not an error", async () => {
    const catalog = await run([]);
    expect(catalog.sections).toEqual({});
    expect(sections).not.toHaveBeenCalled();
  });
});

describe("catalog merging", () => {
  test("known() covers offered and not-offered alike", () => {
    const catalog: TermCatalog = {
      ...emptyCatalog("26/FA"),
      sections: { a: {} as SectionsResponse },
      notOffered: ["b"],
    };
    expect(known(catalog)).toEqual(new Set(["a", "b"]));
  });

  test("age is measured from the fetch stamp", () => {
    const catalog = { ...emptyCatalog("26/FA"), fetchedAt: "2026-08-12T00:00:00.000Z" };
    expect(ageInHours(catalog, Date.parse("2026-08-12T06:00:00.000Z"))).toBe(6);
  });
});
