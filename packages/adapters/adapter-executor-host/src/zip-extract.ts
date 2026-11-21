import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";

// Milestone 8 (ticket 11, F-121): the pinned headless shell comes as a zip (Chrome for Testing's
// only format), and Node reads none, while the machine's own tools differ (no `unzip` on many Linux
// machines, `tar` reads zips only on Windows and macOS). So the runner reads the few parts of the
// format the archive uses: the central directory, stored and deflated entries, and the Unix modes
// of its executables. A zip is read only after its SHA-256 matched the pin, and an entry that would
// land outside the folder, a link, or a ZIP64 archive is refused all the same.

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const ZIP64_LOCATOR = 0x07064b50;
/** The end record is at most 22 bytes and a 64 KiB comment from the end. */
const EOCD_SEARCH = 22 + 0xffff;

type Entry = {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
  readonly mode: number | null;
};

/** What a refused archive says: its structure, never a file's content. */
const refused = (why: string): Error => new Error(`the archive was refused: ${why}`);

/** An entry's folder-relative path, or `null` when it would leave the folder. */
export const safeEntryPath = (name: string): string | null => {
  const unified = name.replaceAll("\\", "/");
  if (unified === "" || unified.startsWith("/") || /^[A-Za-z]:/.test(unified) || unified.includes("\0")) {
    return null;
  }
  const parts = unified.split("/").filter((part) => part !== "" && part !== ".");
  return parts.length === 0 || parts.includes("..") ? null : parts.join("/");
};

const readEntries = async (file: string): Promise<readonly Entry[]> => {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const tailLength = Math.min(size, EOCD_SEARCH);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    let eocd = -1;
    for (let at = tailLength - 22; at >= 0; at -= 1) {
      if (tail.readUInt32LE(at) === EOCD) {
        eocd = at;
        break;
      }
    }
    if (eocd === -1) throw refused("it has no end record");
    if (eocd >= 20 && tail.readUInt32LE(eocd - 20) === ZIP64_LOCATOR) throw refused("it's a ZIP64 archive");
    const count = tail.readUInt16LE(eocd + 10);
    const directorySize = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);
    if (directoryOffset + directorySize > size) throw refused("its directory is past its end");
    const directory = Buffer.alloc(directorySize);
    await handle.read(directory, 0, directorySize, directoryOffset);
    const entries: Entry[] = [];
    let at = 0;
    for (let index = 0; index < count; index += 1) {
      if (at + 46 > directory.length || directory.readUInt32LE(at) !== CENTRAL) throw refused("its directory is broken");
      const madeBy = directory.readUInt16LE(at + 4) >> 8;
      const flags = directory.readUInt16LE(at + 8);
      const method = directory.readUInt16LE(at + 10);
      const compressedSize = directory.readUInt32LE(at + 20);
      const entrySize = directory.readUInt32LE(at + 24);
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      const external = directory.readUInt32LE(at + 38);
      const localOffset = directory.readUInt32LE(at + 42);
      const name = directory.subarray(at + 46, at + 46 + nameLength).toString("utf8");
      if ((flags & 0x1) !== 0) throw refused("an entry is encrypted");
      // Made on Unix (3): the mode is the external attributes' high half.
      const mode = madeBy === 3 ? external >>> 16 : null;
      if (mode !== null && (mode & 0o170000) === 0o120000) throw refused("an entry is a link");
      entries.push({ name, method, compressedSize, size: entrySize, localOffset, mode });
      at += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    await handle.close();
  }
};

/** Where an entry's bytes start: after its local header, whose name and extra lengths may differ from the directory's. */
const dataOffset = async (file: string, entry: Entry): Promise<number> => {
  const handle = await open(file, "r");
  try {
    const header = Buffer.alloc(30);
    await handle.read(header, 0, 30, entry.localOffset);
    if (header.readUInt32LE(0) !== LOCAL) throw refused("an entry's header is broken");
    return entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  } finally {
    await handle.close();
  }
};

/**
 * Extracts a zip into `dest`, which it makes. Entries are written as they stream, never whole in
 * memory; an executable keeps its execute bits on Linux and macOS. Resolves with the number of files.
 */
export const extractZip = async (file: string, dest: string): Promise<number> => {
  const root = path.resolve(dest);
  await mkdir(root, { recursive: true });
  let files = 0;
  for (const entry of await readEntries(file)) {
    const relative = safeEntryPath(entry.name);
    if (relative === null) throw refused("an entry would land outside its folder");
    const target = path.join(root, ...relative.split("/"));
    if (entry.name.endsWith("/")) {
      await mkdir(target, { recursive: true });
      continue;
    }
    if (entry.method !== 0 && entry.method !== 8) throw refused(`an entry uses compression method ${String(entry.method)}`);
    await mkdir(path.dirname(target), { recursive: true });
    const start = await dataOffset(file, entry);
    const sink = createWriteStream(target, { mode: 0o644 });
    if (entry.compressedSize === 0) {
      // An empty stored file: nothing to read.
      sink.end();
      await new Promise<void>((resolve, reject) => {
        sink.once("finish", resolve);
        sink.once("error", reject);
      });
    } else {
      const source = createReadStream(file, { start, end: start + entry.compressedSize - 1 });
      await (entry.method === 0 ? pipeline(source, sink) : pipeline(source, createInflateRaw(), sink));
    }
    if (sink.bytesWritten !== entry.size) throw refused("an entry's size isn't what its directory says");
    if (process.platform !== "win32" && entry.mode !== null && (entry.mode & 0o111) !== 0) {
      await chmod(target, 0o755);
    }
    files += 1;
  }
  return files;
};
