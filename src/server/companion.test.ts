import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTENSION_ORIGIN } from "../where";
import { capturePath, readCapture, serveCompanion } from "./companion";

const CAPTURE = JSON.stringify({ studentId: "1", evaluations: {}, enrolled: [] });

let home = "";
let running: ReturnType<typeof serveCompanion> = null;
/** An ephemeral port: a test may not take the one a real companion wants. */
let base = "";

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "cedarville-"));
  process.env.CEDARVILLE_CAPTURE = join(home, "evaluations.json");
  running = serveCompanion(undefined, 0);
  base = `http://127.0.0.1:${running?.port}`;
});

afterAll(async () => {
  running?.stop();
  delete process.env.CEDARVILLE_CAPTURE;
  await rm(home, { recursive: true, force: true });
});

const post = (body: string, origin?: string) =>
  fetch(`${base}/capture`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body,
  });

describe("where a capture is kept", () => {
  test("an explicit path wins, so it can live somewhere encrypted", () => {
    expect(capturePath()).toBe(join(home, "evaluations.json"));
  });

  test("otherwise the user's data directory, not whatever directory we started in", () => {
    const named = process.env.CEDARVILLE_CAPTURE as string;
    const xdg = process.env.XDG_DATA_HOME;
    delete process.env.CEDARVILLE_CAPTURE;
    process.env.XDG_DATA_HOME = "/tmp/xdg";
    expect(capturePath()).toBe("/tmp/xdg/cedarville/evaluations.json");
    if (xdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = xdg;
    process.env.CEDARVILLE_CAPTURE = named;
  });
});

describe("the loopback intake", () => {
  test("takes a capture from the extension and writes it", async () => {
    const res = await post(CAPTURE, EXTENSION_ORIGIN);
    expect(res.status).toBe(200);
    expect(await readCapture()).toMatchObject({ studentId: "1" });
  });

  test("refuses every other origin", async () => {
    // A page cannot set its own Origin, so this is what keeps the port from
    // being an open door for any tab that guesses the number.
    for (const origin of ["https://evil.example", "http://localhost:5173", undefined]) {
      const res = await post(CAPTURE, origin);
      expect(res.status).toBe(403);
    }
  });

  test("refuses a body that is not a capture", async () => {
    const res = await post("not json", EXTENSION_ORIGIN);
    expect(res.status).toBe(400);
  });

  test("answers a preflight, since the post is cross-origin by nature", async () => {
    const res = await fetch(`${base}/capture`, {
      method: "OPTIONS",
      headers: { origin: EXTENSION_ORIGIN },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(EXTENSION_ORIGIN);
  });

  test("offers nothing else at all", async () => {
    expect((await fetch(`${base}/`)).status).toBe(404);
    // Notably not a way to read one back out: the port takes, it never gives.
    expect((await fetch(`${base}/capture`)).status).toBe(404);
  });

  test("a second companion yields the port rather than crashing the server", () => {
    const second = serveCompanion(undefined, running?.port);
    expect(second).toBeNull();
  });
});
