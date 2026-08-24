import { describe, expect, test } from "bun:test";
import { APP_ORIGIN, COMPANION, EXTENSION_ORIGIN, loopback } from "./where";

describe("who is allowed to talk to whom", () => {
  /*
   * The route this guards writes a transcript to the server's disk, which is
   * the one thing the catalog server promises never to hold. The page half
   * refuses to call it from anywhere but localhost; this is the half that
   * does not depend on the caller keeping its word.
   */
  test("recognises the loopback interface by name and by address", () => {
    for (const url of [
      "http://localhost:5173/dev/capture",
      "http://127.0.0.1:5173/dev/capture",
      "http://[::1]:5173/dev/capture",
    ]) {
      expect(loopback({ url })).toBe(true);
    }
  });

  test("and refuses anything reached over a network", () => {
    for (const url of [
      "https://plan.example.edu/dev/capture",
      "http://192.168.1.20:5173/dev/capture",
      // The classic: a hostname that merely starts with the right letters.
      "http://localhost.example.com/dev/capture",
    ]) {
      expect(loopback({ url })).toBe(false);
    }
  });

  test("the companion is loopback only, whatever the port", () => {
    expect(COMPANION.startsWith("http://127.0.0.1:")).toBe(true);
  });

  test("and the extension is addressed by its pinned id", () => {
    expect(EXTENSION_ORIGIN).toMatch(/^chrome-extension:\/\/[a-p]{32}$/);
    expect(APP_ORIGIN).toMatch(/^https?:\/\//);
  });
});
