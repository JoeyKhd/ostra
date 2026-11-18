import { mkdir, open, readFile, readdir, rename, rm, truncate, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { runnerEventSchema, sessionSeqSchema } from "@ostra/protocol";
import type { RunnerEvent, SessionId } from "@ostra/protocol";
import { z } from "zod";

// The runner's disk spool (ADR 0034): every event of a session is appended here before it's sent,
// and dropped only once the server has acked it after its commit. One folder per session, with
// append-only segment files and an `acked` cursor file.
//
// kill -9 doesn't lose what `write` already handed to the OS; a machine crash could. Spike 6
// measured the first; an fsync per batch would close the second (not done: ADR 0034 doesn't ask).
//
// Ported from spikes/runner-transport/src/runner/spool.ts, with the product's event envelope and a
// quota shared by every session of the runner.

export type SessionSpool = {
  readonly sessionId: SessionId;
  /** The highest session number written; 0 when empty. */
  readonly lastSeq: () => number;
  readonly ackedUpTo: () => number;
  /** Bytes written and not yet acked. */
  readonly bytes: () => number;
  /** Numbers the next event and writes it. Never drops it. */
  readonly append: (make: (sessionSeq: number) => RunnerEvent) => Promise<RunnerEvent>;
  /** Unacked events from `fromSeq` on: at most `maxItems`, and about `maxBytes` (at least one). */
  readonly read: (fromSeq: number, maxItems: number, maxBytes: number) => readonly SpooledEvent[];
  readonly ack: (upTo: number) => Promise<void>;
  readonly close: () => Promise<void>;
  /** Closes it and deletes its folder. */
  readonly destroy: () => Promise<void>;
};

export type SpooledEvent = { readonly event: RunnerEvent; readonly text: string; readonly bytes: number };

const SEGMENT_LINES = 2_000;
const ackedFileSchema = z.coerce.number().pipe(z.number().int().nonnegative());
const lineSchema = z.strictObject({ seq: sessionSeqSchema, event: runnerEventSchema });

const segmentName = (firstSeq: number): string => `seg-${String(firstSeq).padStart(12, "0")}.jsonl`;

type Segment = { readonly name: string; last: number; lines: number };

/** Opens (or creates) one session's spool, recovering from a torn last line. */
export const openSessionSpool = async (dir: string, sessionId: SessionId): Promise<SessionSpool> => {
  await mkdir(dir, { recursive: true });
  const ackedPath = path.join(dir, "acked");
  let acked = 0;
  try {
    const parsed = ackedFileSchema.safeParse((await readFile(ackedPath, "utf8")).trim());
    acked = parsed.success ? parsed.data : 0;
  } catch {
    acked = 0;
  }

  // Recover: read every segment, drop a torn last line, keep what isn't acked.
  const segments: Segment[] = [];
  let pending: SpooledEvent[] = [];
  let previous: number | undefined;
  const names = (await readdir(dir)).filter((name) => name.startsWith("seg-")).sort();
  let broken = false;
  for (const name of names) {
    const file = path.join(dir, name);
    if (broken) {
      // Everything after a torn or out-of-order line is discarded: it was never acked or sent whole.
      await rm(file, { force: true });
      continue;
    }
    const text = await readFile(file, "utf8");
    let goodBytes = 0;
    let lines = 0;
    let segmentLast = 0;
    for (const raw of text.split("\n")) {
      if (raw.length === 0) {
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        broken = true;
        break;
      }
      const line = lineSchema.safeParse(value);
      if (!line.success || line.data.seq !== line.data.event.sessionSeq || (previous !== undefined && line.data.seq !== previous + 1)) {
        broken = true;
        break;
      }
      goodBytes += Buffer.byteLength(raw, "utf8") + 1;
      previous = line.data.seq;
      segmentLast = line.data.seq;
      lines += 1;
      if (line.data.seq > acked) {
        const eventText = JSON.stringify(line.data.event);
        pending.push({ event: line.data.event, text: eventText, bytes: Buffer.byteLength(eventText, "utf8") });
      }
    }
    if (goodBytes < Buffer.byteLength(text, "utf8")) {
      await truncate(file, goodBytes);
    }
    if (lines > 0) {
      segments.push({ name, last: segmentLast, lines });
    } else {
      await rm(file, { force: true });
    }
  }
  let last = Math.max(acked, previous ?? 0);
  let bytes = pending.reduce((sum, item) => sum + item.bytes, 0);

  let current: { readonly segment: Segment; readonly handle: FileHandle } | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work);
    chain = next.catch(() => undefined);
    return next;
  };

  const dropAckedSegments = async (): Promise<void> => {
    for (const segment of [...segments]) {
      if (segment.last > acked || segment === current?.segment) {
        continue;
      }
      await rm(path.join(dir, segment.name), { force: true });
      segments.splice(segments.indexOf(segment), 1);
    }
  };

  const closeCurrent = async (): Promise<void> => {
    if (current !== undefined) {
      await current.handle.close();
    }
    current = undefined;
  };

  return {
    sessionId,
    lastSeq: () => last,
    ackedUpTo: () => acked,
    bytes: () => bytes,
    append: (make) =>
      serial(async () => {
        const seq = last + 1;
        const event = make(seq);
        if (event.sessionSeq !== seq || event.sessionId !== sessionId) {
          throw new Error("a spooled event must carry its session and the number the spool gave it");
        }
        if (current === undefined || current.segment.lines >= SEGMENT_LINES) {
          await closeCurrent();
          const segment: Segment = { name: segmentName(seq), last: seq - 1, lines: 0 };
          segments.push(segment);
          current = { segment, handle: await open(path.join(dir, segment.name), "a") };
        }
        const eventText = JSON.stringify(event);
        await current.handle.write(`${JSON.stringify({ seq, event })}\n`);
        current.segment.last = seq;
        current.segment.lines += 1;
        last = seq;
        const size = Buffer.byteLength(eventText, "utf8");
        pending.push({ event, text: eventText, bytes: size });
        bytes += size;
        return event;
      }),
    read: (fromSeq, maxItems, maxBytes) => {
      const first = pending[0];
      if (first === undefined) {
        return [];
      }
      const start = Math.max(fromSeq, acked + 1) - first.event.sessionSeq;
      const out: SpooledEvent[] = [];
      let size = 0;
      for (let index = Math.max(0, start); index < pending.length && out.length < maxItems; index += 1) {
        const item = pending[index];
        if (item === undefined || (out.length > 0 && size + item.bytes > maxBytes)) {
          break;
        }
        out.push(item);
        size += item.bytes;
      }
      return out;
    },
    ack: (upTo) =>
      serial(async () => {
        if (upTo <= acked) {
          return;
        }
        acked = Math.min(upTo, last);
        const keep: SpooledEvent[] = [];
        for (const item of pending) {
          if (item.event.sessionSeq <= acked) {
            bytes -= item.bytes;
          } else {
            keep.push(item);
          }
        }
        pending = keep;
        const temporary = `${ackedPath}.tmp`;
        await writeFile(temporary, String(acked));
        await rename(temporary, ackedPath);
        await dropAckedSegments();
      }),
    close: () => serial(closeCurrent),
    destroy: () =>
      serial(async () => {
        await closeCurrent();
        pending = [];
        bytes = 0;
        await rm(dir, { recursive: true, force: true });
      }),
  };
};
