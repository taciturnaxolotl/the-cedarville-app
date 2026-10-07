/**
 * Writing a zip, because the extension has to be handed to a student somehow.
 *
 * Chrome will not install an extension from a web page. A `.crx` offered over
 * HTTP has been refused since Chrome 33 on Windows and everywhere since 75,
 * and dragging one onto chrome://extensions is refused too; the only paths
 * left are the Web Store and "load unpacked". So what a student downloads is
 * a folder, and a folder travels as a zip.
 *
 * Stored rather than deflated, and dated to the zip epoch rather than to now.
 * Both for the same reason: the build should produce the same bytes from the
 * same source, so a rebuild on a different machine is not a new download for
 * everybody. The extension is 150 kilobytes of text that the web server gzips
 * on the way out anyway, which is the compression that actually matters here.
 *
 * No dependency and no shelling out to `zip`: a build that needs a tool from
 * the host works on the machine it was written on and fails in a sandbox.
 */

/** Zip's own epoch, 1980-01-01 00:00:00, in DOS date and time fields. */
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
/** 2.0: the version that knew about directories and stored entries. */
const VERSION = 20;
/** Unix 0644 in the high half, which is what keeps a file readable. */
const EXTERNAL_ATTRS = 0o100644 << 16;

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** The checksum zip has always used, over the bytes exactly as stored. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** The path inside the archive. Forward slashes, no leading slash. */
  name: string;
  data: Uint8Array;
}

/** Little-endian, which is the only endianness a zip has ever been written in. */
class Bytes {
  #parts: Uint8Array[] = [];
  #length = 0;

  u16(value: number): this {
    const out = new Uint8Array(2);
    new DataView(out.buffer).setUint16(0, value, true);
    return this.raw(out);
  }

  u32(value: number): this {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value >>> 0, true);
    return this.raw(out);
  }

  raw(bytes: Uint8Array): this {
    this.#parts.push(bytes);
    this.#length += bytes.length;
    return this;
  }

  get length(): number {
    return this.#length;
  }

  done(): Uint8Array {
    const out = new Uint8Array(this.#length);
    let at = 0;
    for (const part of this.#parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

/**
 * An archive of the given files, in the order given.
 *
 * Entries sit at the root rather than inside a folder named after the
 * download: every unarchiver already makes that folder, and two of them would
 * mean a student picking the wrong one in "load unpacked" and being told there
 * is no manifest.
 */
export function zip(entries: readonly ZipEntry[]): Uint8Array {
  const body = new Bytes();
  const directory = new Bytes();

  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const sum = crc32(entry.data);
    const offset = body.length;

    body
      .u32(LOCAL)
      .u16(VERSION)
      .u16(0) // no flags: not encrypted, sizes known up front
      .u16(0) // stored
      .u16(DOS_TIME)
      .u16(DOS_DATE)
      .u32(sum)
      .u32(entry.data.length)
      .u32(entry.data.length)
      .u16(name.length)
      .u16(0) // no extra field
      .raw(name)
      .raw(entry.data);

    directory
      .u32(CENTRAL)
      .u16(VERSION) // made by
      .u16(VERSION) // needed to extract
      .u16(0)
      .u16(0)
      .u16(DOS_TIME)
      .u16(DOS_DATE)
      .u32(sum)
      .u32(entry.data.length)
      .u32(entry.data.length)
      .u16(name.length)
      .u16(0) // extra
      .u16(0) // comment
      .u16(0) // first disk, there being one
      .u16(0) // internal attributes
      .u32(EXTERNAL_ATTRS)
      .u32(offset)
      .raw(name);
  }

  const end = new Bytes()
    .u32(END)
    .u16(0)
    .u16(0)
    .u16(entries.length)
    .u16(entries.length)
    .u32(directory.length)
    .u32(body.length)
    .u16(0);

  return new Bytes().raw(body.done()).raw(directory.done()).raw(end.done()).done();
}
