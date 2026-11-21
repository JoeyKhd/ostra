import { err, ok } from "../common/result.ts";
import type { Result } from "../common/result.ts";

// Milestone 8 (F-145, ADR 0069): a streaming reader of tar archives (POSIX ustar, with pax
// extended headers and GNU long names), for a code host that serves a commit as an archive, as
// GitHub does (`git archive`'s tarball) and GitLab would. It reads any byte stream, holds only the
// entries its caller asks to read, and lets every other byte stream past, so an archive is never
// written to disk and never held whole in memory. Paths, link targets and bytes are the repo's
// content: none reaches an error message.

const BLOCK = 512;
/** The most a pax or GNU long-name header holds: past it, the archive is refused. */
const META_MAX_BYTES = 64 * 1024;

export type TarEntryType = "file" | "directory" | "symlink" | "hardlink" | "other";

/** An entry's header, as its pax and GNU headers amend it. */
export type TarEntry = {
  readonly path: string;
  readonly type: TarEntryType;
  readonly size: number;
  /** Its permission bits, such as `0o755`. */
  readonly mode: number;
  /** A link's target; `""` for anything else. */
  readonly linkTarget: string;
};

/** What to do with an entry: hold its bytes, let them stream past, or stop reading the archive. */
export type TarDecision = "read" | "skip" | "stop";

export type TarHandlers = {
  readonly entry: (entry: TarEntry) => TarDecision;
  /** A file the caller chose to read, with its bytes. */
  readonly bytes: (entry: TarEntry, bytes: Uint8Array) => void;
  /** The archive's global pax `comment`, where `git archive` writes the commit it archived. */
  readonly comment?: (comment: string) => void;
};

/** How reading ended: at the archive's end marker, or when a handler said `stop`. */
export type TarOutcome = "ended" | "stopped";

type ByteSource = {
  /** Exactly `count` bytes, or `null` when the stream ends first. */
  readonly read: (count: number) => Promise<Uint8Array | null>;
  /** Lets `count` bytes stream past; `false` when the stream ends first. */
  readonly skip: (count: number) => Promise<boolean>;
  readonly close: () => Promise<void>;
};

const byteSource = (source: AsyncIterable<Uint8Array>): ByteSource => {
  const iterator = source[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let head = 0;
  let buffered = 0;
  let ended = false;
  const pull = async (): Promise<boolean> => {
    if (ended) {
      return false;
    }
    const next = await iterator.next();
    if (next.done === true) {
      ended = true;
      return false;
    }
    if (next.value.length > 0) {
      chunks.push(next.value);
      buffered += next.value.length;
    }
    return true;
  };
  /** Takes up to `count` bytes off the front chunk, copying them into `into` at `at` when given. */
  const take = (count: number, into?: { readonly buffer: Uint8Array; readonly at: number }): number => {
    const chunk = chunks[0];
    if (chunk === undefined) {
      return 0;
    }
    const length = Math.min(count, chunk.length - head);
    into?.buffer.set(chunk.subarray(head, head + length), into.at);
    head += length;
    buffered -= length;
    if (head === chunk.length) {
      chunks.shift();
      head = 0;
    }
    return length;
  };
  return {
    read: async (count) => {
      while (buffered < count) {
        if (!(await pull())) {
          return null;
        }
      }
      const out = new Uint8Array(count);
      let at = 0;
      while (at < count) {
        at += take(count - at, { buffer: out, at });
      }
      return out;
    },
    skip: async (count) => {
      let left = count;
      while (left > 0) {
        if (buffered === 0 && !(await pull())) {
          return false;
        }
        left -= take(left);
      }
      return true;
    },
    close: async () => {
      if (!ended) {
        ended = true;
        await iterator.return?.();
      }
    },
  };
};

const decoder = new TextDecoder();

/** A NUL-ended text field of a header. */
const field = (block: Uint8Array, start: number, length: number): string => {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return decoder.decode(end === -1 ? slice : slice.subarray(0, end));
};

/** A numeric field: octal text, or base-256 (its first byte's high bit set) for a big size. */
const numeric = (block: Uint8Array, start: number, length: number): number | null => {
  const first = block[start] ?? 0;
  if ((first & 0x80) !== 0) {
    let value = first & 0x7f;
    for (let index = start + 1; index < start + length; index += 1) {
      value = value * 256 + (block[index] ?? 0);
    }
    return Number.isSafeInteger(value) ? value : null;
  }
  const text = field(block, start, length).trim();
  if (text === "") {
    return 0;
  }
  return /^[0-7]+$/.test(text) ? Number.parseInt(text, 8) : null;
};

/** A header's checksum: its bytes summed, the checksum's own field counted as spaces. */
const checksumMatches = (block: Uint8Array): boolean => {
  const stored = numeric(block, 148, 8);
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
  }
  return stored === sum;
};

/** A pax header's records, `"<length> <key>=<value>\n"` each, by key; `null` when one doesn't read. */
const paxRecords = (body: Uint8Array): Map<string, string> | null => {
  const records = new Map<string, string>();
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    if (space === -1) {
      return null;
    }
    const length = Number(decoder.decode(body.subarray(at, space)));
    if (!Number.isSafeInteger(length) || length <= space - at || at + length > body.length) {
      return null;
    }
    const record = decoder.decode(body.subarray(space + 1, at + length - 1));
    const equals = record.indexOf("=");
    if (equals === -1) {
      return null;
    }
    records.set(record.slice(0, equals), record.slice(equals + 1));
    at += length;
  }
  return records;
};

const typeOf = (flag: number): TarEntryType => {
  switch (String.fromCharCode(flag)) {
    case "\u0000":
    case "0":
    case "7":
      return "file";
    case "5":
      return "directory";
    case "2":
      return "symlink";
    case "1":
      return "hardlink";
    default:
      return "other";
  }
};

const padOf = (size: number): number => (BLOCK - (size % BLOCK)) % BLOCK;

/**
 * Reads a tar archive from `source`, entry by entry, asking `handlers.entry` what to do with each.
 * Errors that are the archive's (a bad checksum, a header that doesn't read, an archive cut short)
 * are an `err` in ostra's words; the stream's own errors (a dropped connection) are thrown.
 */
export const readTar = async (source: AsyncIterable<Uint8Array>, handlers: TarHandlers): Promise<Result<TarOutcome, string>> => {
  const reader = byteSource(source);
  /** What the pax and GNU headers before an entry say about it. */
  let pending: { path?: string; linkTarget?: string; size?: number } = {};
  try {
    for (;;) {
      const block = await reader.read(BLOCK);
      if (block === null) {
        return err("the archive ends before its end marker");
      }
      if (block.every((byte) => byte === 0)) {
        return ok("ended");
      }
      if (!checksumMatches(block)) {
        return err("an archive header's checksum doesn't match");
      }
      const flag = String.fromCharCode(block[156] ?? 0);
      const headerSize = numeric(block, 124, 12);
      if (headerSize === null) {
        return err("an archive header's size doesn't read");
      }
      if (flag === "x" || flag === "g" || flag === "L" || flag === "K") {
        if (headerSize > META_MAX_BYTES) {
          return err("an archive's extended header is too large");
        }
        const body = await reader.read(headerSize);
        if (body === null || !(await reader.skip(padOf(headerSize)))) {
          return err("the archive ends inside a header");
        }
        if (flag === "L" || flag === "K") {
          const end = body.indexOf(0);
          const text = decoder.decode(end === -1 ? body : body.subarray(0, end));
          pending = flag === "L" ? { ...pending, path: text } : { ...pending, linkTarget: text };
          continue;
        }
        const records = paxRecords(body);
        if (records === null) {
          return err("an archive's extended header doesn't read");
        }
        if (flag === "g") {
          const comment = records.get("comment");
          if (comment !== undefined) {
            handlers.comment?.(comment);
          }
          continue;
        }
        const path = records.get("path");
        const linkTarget = records.get("linkpath");
        const size = records.get("size");
        if (size !== undefined && !/^\d+$/.test(size)) {
          return err("an archive's extended header has a size that doesn't read");
        }
        pending = {
          ...pending,
          ...(path === undefined ? {} : { path }),
          ...(linkTarget === undefined ? {} : { linkTarget }),
          ...(size === undefined ? {} : { size: Number(size) }),
        };
        continue;
      }
      const name = field(block, 0, 100);
      const prefix = field(block, 257, 6) === "ustar" ? field(block, 345, 155) : "";
      const type = typeOf(block[156] ?? 0);
      const size = pending.size ?? headerSize;
      const entry: TarEntry = {
        path: pending.path ?? (prefix === "" ? name : `${prefix}/${name}`),
        type,
        size: type === "file" ? size : 0,
        mode: numeric(block, 100, 8) ?? 0,
        linkTarget: pending.linkTarget ?? field(block, 157, 100),
      };
      pending = {};
      const decision = handlers.entry(entry);
      if (decision === "stop") {
        return ok("stopped");
      }
      if (decision === "read" && type === "file") {
        const bytes = await reader.read(size);
        if (bytes === null || !(await reader.skip(padOf(size)))) {
          return err("the archive ends inside a file");
        }
        handlers.bytes(entry, bytes);
        continue;
      }
      if (!(await reader.skip(size + padOf(size)))) {
        return err("the archive ends inside a file");
      }
    }
  } finally {
    await reader.close();
  }
};
