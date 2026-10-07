/*
 * The rule groups Colleague will not enumerate, resolved where the session is.
 *
 * Hosted, the server could expand none of these and the plan listed five
 * requirements as unplannable that worked on a laptop whose cache still held
 * the old answers. The fallback is the whole fix, so it is worth a test that
 * fails without it.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

const window = new Window({ url: "http://localhost:5173/" });
Object.assign(globalThis, {
  document: window.document,
  window,
  localStorage: window.localStorage,
  location: window.location,
  navigator: window.navigator,
});

const { planningFrom } = await import("./planning");

/** One rule-based group, exactly as an evaluation states it. */
const group = {
  requirement: "r1",
  text: "One laboratory course from the biological sciences (3.5 credit hours)",
  credits: 3.5,
  bucket: false,
  ids: { requirement: "R1", subrequirement: "S1", group: "G1" },
};

const ctx = { trees: [], allCourses: [] } as never;

/** The search the extension would run, answering one page of courses. */
const extensionAnswering = (courses: { SubjectCode: string; Number: string }[]) => ({
  runtime: {
    sendMessage: (_id: string, msg: { type: string }, cb: (r: unknown) => void) => {
      if (msg.type !== "search") return cb({ ok: false, error: `unexpected ${msg.type}` });
      cb({ ok: true, data: { Courses: courses, TotalPages: 1, CurrentPageIndex: 0 } });
    },
  },
});

beforeEach(() => {
  localStorage.clear();
  Object.assign(globalThis, {
    // The server has nothing: this is the hosted case.
    fetch: async () => ({ ok: true, json: async () => ({}) }),
  });
});

describe("expanding a rule the server cannot", () => {
  test("asks the student's own session when the server comes back empty", async () => {
    Object.assign(globalThis, {
      chrome: extensionAnswering([
        { SubjectCode: "BIO", Number: "1120" },
        { SubjectCode: "BIO", Number: "1130" },
      ]),
    });

    const found = await planningFrom(ctx).expandRules([group]);
    expect(found.get("R1/S1/G1")).toEqual(["BIO-1120", "BIO-1130"]);
  });

  test("and keeps the answer, because a pool is a catalog fact", async () => {
    let asked = 0;
    Object.assign(globalThis, {
      chrome: {
        runtime: {
          sendMessage: (_i: string, _m: unknown, cb: (r: unknown) => void) => {
            asked++;
            cb({
              ok: true,
              data: {
                Courses: [{ SubjectCode: "BIO", Number: "1120" }],
                TotalPages: 1,
                CurrentPageIndex: 0,
              },
            });
          },
        },
      },
    });

    expect((await planningFrom(ctx).expandRules([group])).size).toBe(1);
    expect(asked).toBe(1);
    // A second planning pass, a second view, a reload: the same answer.
    expect((await planningFrom(ctx).expandRules([group])).get("R1/S1/G1")).toEqual(["BIO-1120"]);
    expect(asked).toBe(1);
  });

  test("without an extension it stays unresolved rather than guessing", async () => {
    Object.assign(globalThis, { chrome: undefined });
    expect((await planningFrom(ctx).expandRules([group])).size).toBe(0);
  });
});
