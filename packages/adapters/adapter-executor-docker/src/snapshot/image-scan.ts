import { open } from "node:fs/promises";
import zlib from "node:zlib";

// The scan before a snapshot is used (F-051, ADR 0038 as amended, Q153), ported from spike 3
// (`spikes/what-is-inside-a-box/src/snapshot/image-scan.ts`): the image as `docker save` writes it
// (a tar of the config, the manifests and each layer), each entry decompressed when it's gzip or
// zstd, searched for every setup secret's value as raw bytes and as base64 at each of its three
// alignments. A layer is a tar once decompressed, so a secret in any file of any layer shows up as
// its bytes. It streams the archive from disk, a chunk at a time, so an image of gigabytes scans in
// a little memory.
//
// It never returns or logs a value: only the names of the secrets it found. A value under 6
// characters is skipped (ADR 0038), and an encoding other than base64 isn't caught; the docs say so.

/** A value under this many characters isn't searched for: it would match by chance. */
export const SCAN_MIN_CHARS = 6;

export type ScanTarget = { readonly name: string; readonly value: string };

export type ImageScan = {
  /** The archive's entries scanned. */
  readonly entries: number;
  /** The bytes searched, after decompression. */
  readonly bytesScanned: number;
  /** The names of the targets found, in the targets' order. Empty is the pass. */
  readonly found: readonly string[];
};

/**
 * What a value looks like in the image: its bytes, and its base64 at each alignment, with the
 * characters that depend on the bytes around it left out. A form under 6 characters is dropped.
 */
export const needlesOf = (value: string): readonly Buffer[] => {
  if (value.length < SCAN_MIN_CHARS) {
    return [];
  }
  const raw = Buffer.from(value, "utf8");
  const needles: Buffer[] = [raw];
  for (const shift of [0, 1, 2] as const) {
    const encoded = Buffer.concat([Buffer.alloc(shift), raw]).toString("base64").replace(/=+$/, "");
    const total = shift + raw.length;
    // The first characters carry the unknown bytes before it; the last ones the bytes after.
    const head = shift === 0 ? 0 : shift === 1 ? 2 : 3;
    const tail = total % 3 === 0 ? 0 : 1;
    const form = encoded.slice(head, encoded.length - tail);
    if (form.length >= SCAN_MIN_CHARS) {
      needles.push(Buffer.from(form, "latin1"));
    }
  }
  return needles;
};

/** Finds the needles in a stream of chunks, across chunk boundaries. */
const matcher = (targets: readonly { readonly name: string; readonly needles: readonly Buffer[] }[], found: Set<string>) => {
  const longest = Math.max(1, ...targets.flatMap((target) => target.needles.map((needle) => needle.length)));
  let carry = Buffer.alloc(0);
  return {
    feed: (chunk: Buffer): void => {
      const window = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
      for (const target of targets) {
        if (!found.has(target.name) && target.needles.some((needle) => window.includes(needle))) {
          found.add(target.name);
        }
      }
      carry = Buffer.from(window.subarray(Math.max(0, window.length - (longest - 1))));
    },
    reset: (): void => {
      carry = Buffer.alloc(0);
    },
  };
};

/** A tar header's size field: octal, or base-256 for an entry over 8 GiB. */
const entrySize = (header: Buffer): number => {
  const field = header.subarray(124, 136);
  if (((field[0] ?? 0) & 0x80) !== 0) {
    let size = 0;
    for (let index = 1; index < field.length; index += 1) {
      size = size * 256 + (field[index] ?? 0);
    }
    return size;
  }
  const text = field.toString("latin1").replaceAll("\0", "").trim();
  return text === "" ? 0 : Number.parseInt(text, 8);
};

const isGzip = (head: Buffer): boolean => head[0] === 0x1f && head[1] === 0x8b;
const isZstd = (head: Buffer): boolean => head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd;

const CHUNK = 1024 * 1024;

/**
 * Scans an image archive (`docker save`'s tar, or an OCI layout's) for each target's value.
 * Throws when the file can't be read or isn't a tar, so the caller fails the build.
 */
export const scanImageArchive = async (file: string, targets: readonly ScanTarget[]): Promise<ImageScan> => {
  const searched = targets.map((target) => ({ name: target.name, needles: needlesOf(target.value) })).filter((target) => target.needles.length > 0);
  const found = new Set<string>();
  const search = matcher(searched, found);
  const handle = await open(file, "r");
  let entries = 0;
  let bytesScanned = 0;
  try {
    const header = Buffer.alloc(512);
    let offset = 0;
    for (;;) {
      const { bytesRead } = await handle.read(header, 0, 512, offset);
      if (bytesRead === 0) {
        break;
      }
      if (bytesRead < 512) {
        throw new Error("the image archive ends inside a tar header");
      }
      if (header.every((byte) => byte === 0)) {
        break;
      }
      const magic = header.subarray(257, 262).toString("latin1");
      if (magic !== "ustar") {
        throw new Error("the image archive isn't a tar");
      }
      const size = entrySize(header);
      offset += 512;
      entries += 1;
      search.reset();
      bytesScanned += await scanEntry(handle, offset, size, search.feed);
      offset += Math.ceil(size / 512) * 512;
    }
  } finally {
    await handle.close();
  }
  return { entries, bytesScanned, found: targets.map((target) => target.name).filter((name, index, all) => found.has(name) && all.indexOf(name) === index) };
};

/** One entry's bytes, decompressed when they are gzip or zstd, fed to the search. Answers the bytes searched. */
const scanEntry = async (
  handle: Awaited<ReturnType<typeof open>>,
  start: number,
  size: number,
  feed: (chunk: Buffer) => void,
): Promise<number> => {
  if (size === 0) {
    return 0;
  }
  const head = Buffer.alloc(Math.min(4, size));
  await handle.read(head, 0, head.length, start);
  const decompressor = isGzip(head) ? zlib.createGunzip() : isZstd(head) ? zlib.createZstdDecompress() : null;
  let scanned = 0;
  if (decompressor === null) {
    // Raw: an uncompressed layer, the config, a manifest.
    const buffer = Buffer.alloc(Math.min(CHUNK, size));
    for (let at = 0; at < size; ) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - at), start + at);
      if (bytesRead === 0) {
        throw new Error("the image archive ends inside an entry");
      }
      feed(buffer.subarray(0, bytesRead));
      scanned += bytesRead;
      at += bytesRead;
    }
    return scanned;
  }
  const done = new Promise<void>((resolve, reject) => {
    decompressor.on("data", (chunk: Buffer) => {
      feed(chunk);
      scanned += chunk.length;
    });
    decompressor.once("end", resolve);
    decompressor.once("error", reject);
  });
  const buffer = Buffer.alloc(Math.min(CHUNK, size));
  for (let at = 0; at < size; ) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - at), start + at);
    if (bytesRead === 0) {
      throw new Error("the image archive ends inside an entry");
    }
    const piece = Buffer.from(buffer.subarray(0, bytesRead));
    at += bytesRead;
    if (!decompressor.write(piece)) {
      await new Promise((resolve) => decompressor.once("drain", resolve));
    }
  }
  decompressor.end();
  await done;
  return scanned;
};
