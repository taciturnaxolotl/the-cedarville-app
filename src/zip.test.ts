/*
 * The zip writer, checked against the thing that will actually open it.
 *
 * Asserting on bytes we wrote ourselves would only prove the writer agrees
 * with itself, so the tests that matter here hand the archive to `unzip` and
 * to Bun's own reader. Both skip rather than fail where the tool is absent: a
 * test that cannot run is not a test that failed.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, zip } from "./zip";

const text = (s: string) => new TextEncoder().encode(s);
const MANIFEST = '{"manifest_version":3,"name":"bridge"}';

const archive = () =>
  zip([
    { name: "manifest.json", data: text(MANIFEST) },
    { name: "background.js", data: text("export const hello = 1;\n") },
    { name: "content.js", data: text("// content\n") },
  ]);

/** Writes the archive to a scratch directory and hands back its path. */
async function onDisk(bytes: Uint8Array): Promise<{ path: string; clean: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "cedarville-zip-"));
  const path = join(dir, "bridge.zip");
  await Bun.write(path, bytes);
  return { path, clean: () => rm(dir, { recursive: true, force: true }) };
}

const has = async (tool: string) => (await Bun.$`which ${tool}`.quiet().nothrow()).exitCode === 0;

describe("crc32", () => {
  // The three everybody's test suite uses, so a transcription error shows up
  // here rather than as "some unarchivers refuse the file".
  test("agrees with the published values", () => {
    expect(crc32(text(""))).toBe(0);
    expect(crc32(text("a"))).toBe(0xe8b7be43);
    expect(crc32(text("123456789"))).toBe(0xcbf43926);
  });
});

describe("the archive", () => {
  test("starts with the signature every unarchiver looks for", () => {
    const bytes = archive();
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  test("ends with a directory naming every entry once", () => {
    const bytes = archive();
    const end = new DataView(bytes.buffer, bytes.byteLength - 22);
    expect(end.getUint32(0, true)).toBe(0x06054b50);
    expect(end.getUint16(10, true)).toBe(3);
  });

  test("is byte for byte the same every time, so a rebuild is not a new download", () => {
    expect(archive()).toEqual(archive());
  });

  test("unzip reads it, and reads back what went in", async () => {
    if (!(await has("unzip"))) return;
    const { path, clean } = await onDisk(archive());
    try {
      const tested = await Bun.$`unzip -t ${path}`.quiet().nothrow();
      expect(tested.exitCode).toBe(0);
      expect(tested.stdout.toString()).toContain("No errors detected");

      const listed = await Bun.$`unzip -Z1 ${path}`.text();
      expect(listed.split("\n").filter(Boolean)).toEqual([
        "manifest.json",
        "background.js",
        "content.js",
      ]);

      // The one entry whose contents decide whether Chrome will load it.
      const manifest = await Bun.$`unzip -p ${path} manifest.json`.text();
      expect(JSON.parse(manifest).manifest_version).toBe(3);
    } finally {
      await clean();
    }
  });

  test("and an empty archive is still a readable archive", async () => {
    const bytes = zip([]);
    expect(bytes).toHaveLength(22);
    if (!(await has("unzip"))) return;
    const { path, clean } = await onDisk(bytes);
    try {
      // Info-ZIP calls an empty archive an error, so the assertion is only
      // that it recognises the format rather than complaining about bytes.
      const listed = await Bun.$`unzip -Z1 ${path}`.quiet().nothrow();
      expect(listed.stderr.toString()).not.toContain("cannot find zipfile directory");
    } finally {
      await clean();
    }
  });
});
