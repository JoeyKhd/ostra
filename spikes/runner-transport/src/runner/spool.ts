import { mkdir, open, readFile, readdir, rename, rm, truncate, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { EventItem } from "../protocol/messages.ts";

// The runner's disk spool (ADR 0034): every event is appended here before it
// is sent, and dropped only once the server has acked it after its commit.
// Append-only segment files per session, plus an `acked` cursor file.
//
// kill -9 doesn't lose what `write` already handed to the OS; a machine crash
// could, and fsync per batch would close that (not measured here).

export type Spool = {
  readonly lastSeq: () => number;
  readonly ackedUpTo: () => number;
  /** Unacked bytes, for the quota. */
  readonly bytes: () => number;
  readonly append: (make: (seq: number) => EventItem) => Promise<number>;
  /** Unacked items from `fromSeq`, at most `maxItems` and about `maxBytes`. */
  readonly read: (fromSeq: number, maxItems: number, maxBytes: number) => EventItem[];
  readonly ack: (upTo: number) => Promise<void>;
  readonly close: () => Promise<void>;
};

type Pending = { seq: number; item: EventItem; size: number };

const SEGMENT_LINES = 2_000;
const Line = z.strictObject({ seq: z.number().int().positive(), item: EventItem });

const readTail = (pending: readonly Pending[], ackedUpTo: number, fromSeq: number, maxItems: number, maxBytes: number): EventItem[] => {
  const first = pending[0];
  if (first === undefined) return [];
  const start = Math.max(fromSeq, ackedUpTo + 1) - first.seq;
  const out: EventItem[] = [];
  let bytes = 0;
  for (let i = Math.max(0, start); i < pending.length && out.length < maxItems; i += 1) {
    const p = pending[i];
    if (p === undefined) break;
    if (out.length > 0 && bytes + p.size > maxBytes) break;
    out.push(p.item);
    bytes += p.size;
  }
  return out;
};

export const memorySpool = (): Spool => {
  let pending: Pending[] = [];
  let last = 0;
  let acked = 0;
  let bytes = 0;
  return {
    lastSeq: () => last,
    ackedUpTo: () => acked,
    bytes: () => bytes,
    append: (make) => {
      last += 1;
      const item = make(last);
      const size = JSON.stringify(item).length;
      pending.push({ seq: last, item, size });
      bytes += size;
      return Promise.resolve(last);
    },
    read: (fromSeq, maxItems, maxBytes) => readTail(pending, acked, fromSeq, maxItems, maxBytes),
    ack: (upTo) => {
      if (upTo <= acked) return Promise.resolve();
      acked = Math.min(upTo, last);
      const keep = pending.filter((p) => p.seq > acked);
      for (const p of pending) if (p.seq <= acked) bytes -= p.size;
      pending = keep;
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  };
};

const segName = (firstSeq: number): string => `seg-${String(firstSeq).padStart(12, "0")}.jsonl`;
const AckedFile = z.coerce.number().int().nonnegative();

export const openFileSpool = async (dir: string): Promise<Spool> => {
  await mkdir(dir, { recursive: true });
  const ackedPath = path.join(dir, "acked");
  let acked = 0;
  try {
    acked = AckedFile.parse((await readFile(ackedPath, "utf8")).trim());
  } catch {
    acked = 0;
  }

  // Recover: read every segment, drop a torn last line, keep what isn't acked.
  type Segment = { name: string; first: number; last: number; lines: number };
  const segments: Segment[] = [];
  let pending: Pending[] = [];
  let prev: number | undefined;
  const names = (await readdir(dir)).filter((n) => n.startsWith("seg-")).sort();
  for (const name of names) {
    const file = path.join(dir, name);
    const text = await readFile(file, "utf8");
    let good = 0;
    let first = 0;
    let segLast = 0;
    let lines = 0;
    for (const raw of text.split("\n")) {
      if (raw.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        break; // a torn write from kill -9: everything after it is discarded
      }
      const line = Line.safeParse(parsed);
      if (!line.success || (prev !== undefined && line.data.seq !== prev + 1)) break;
      good += Buffer.byteLength(raw) + 1;
      prev = line.data.seq;
      if (first === 0) first = line.data.seq;
      segLast = line.data.seq;
      lines += 1;
      if (line.data.seq > acked) pending.push({ seq: line.data.seq, item: line.data.item, size: raw.length });
    }
    if (good < Buffer.byteLength(text)) await truncate(file, good);
    if (lines > 0) segments.push({ name, first, last: segLast, lines });
    else await rm(file, { force: true });
  }
  let last = Math.max(acked, prev ?? 0);
  let bytes = pending.reduce((a, p) => a + p.size, 0);

  let current: { seg: Segment; fh: FileHandle } | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn);
    chain = next.catch(() => undefined);
    return next;
  };

  const dropAckedSegments = async (): Promise<void> => {
    for (const seg of [...segments]) {
      if (seg.last > acked || seg === current?.seg) continue;
      await rm(path.join(dir, seg.name), { force: true });
      segments.splice(segments.indexOf(seg), 1);
    }
  };

  return {
    lastSeq: () => last,
    ackedUpTo: () => acked,
    bytes: () => bytes,
    append: (make) =>
      serial(async () => {
        const seq = last + 1;
        const item = make(seq);
        const raw = JSON.stringify({ seq, item });
        if (current === undefined || current.seg.lines >= SEGMENT_LINES) {
          if (current !== undefined) await current.fh.close();
          const seg: Segment = { name: segName(seq), first: seq, last: seq - 1, lines: 0 };
          segments.push(seg);
          current = { seg, fh: await open(path.join(dir, seg.name), "a") };
        }
        await current.fh.write(`${raw}\n`);
        current.seg.last = seq;
        current.seg.lines += 1;
        last = seq;
        pending.push({ seq, item, size: raw.length });
        bytes += raw.length;
        return seq;
      }),
    read: (fromSeq, maxItems, maxBytes) => readTail(pending, acked, fromSeq, maxItems, maxBytes),
    ack: (upTo) =>
      serial(async () => {
        if (upTo <= acked) return;
        acked = Math.min(upTo, last);
        const keep: Pending[] = [];
        for (const p of pending) {
          if (p.seq <= acked) bytes -= p.size;
          else keep.push(p);
        }
        pending = keep;
        const tmp = `${ackedPath}.tmp`;
        await writeFile(tmp, String(acked));
        await rename(tmp, ackedPath);
        await dropAckedSegments();
      }),
    close: () =>
      serial(async () => {
        if (current !== undefined) await current.fh.close();
        current = undefined;
      }),
  };
};
