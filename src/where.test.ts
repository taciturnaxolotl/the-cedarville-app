import { describe, expect, test } from "bun:test";
import { APP_ORIGIN, COMPANION, EXTENSION_ORIGIN } from "./where";

describe("who is allowed to talk to whom", () => {
  /*
   * There used to be a `loopback` guard here, for a route on the catalog
   * server that wrote a capture to disk. It read the hostname off the
   * request, which is a header the client sends — a guard that asks the
   * attacker whether they are an attacker. The route is gone, and with it the
   * only thing a transcript could be written to a hosted server through.
   *
   * What remains is the arrangement that never needed a guard: the companion
   * binds to the loopback address rather than inspecting requests for one.
   */
  test("the companion is loopback only, whatever the port", () => {
    expect(COMPANION.startsWith("http://127.0.0.1:")).toBe(true);
  });

  test("and the extension is addressed by its pinned id", () => {
    expect(EXTENSION_ORIGIN).toMatch(/^chrome-extension:\/\/[a-p]{32}$/);
    expect(APP_ORIGIN).toMatch(/^https?:\/\//);
  });
});
