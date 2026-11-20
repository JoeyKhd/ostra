import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { eventsFrameSchema, organizationIdSchema, runnerIdSchema } from "@ostra/protocol";
import type { DownFrame, EventsFrame } from "@ostra/protocol";
import { describe, expect, it } from "vitest";

import type { RunnerRef } from "../gateway/context.ts";
import { ingestTimingBucketsMs, timedIngest } from "./timing.ts";

// Ticket 34 (F-117): the load test reads each replica's ingest time from its `ingest.timing` lines.

const runner: RunnerRef = {
  runnerId: runnerIdSchema.parse("0198a3c4-0000-7000-8000-000000000001"),
  organizationId: organizationIdSchema.parse("0198a3c4-0000-7000-8000-000000000003"),
};

describe("ingest timing", () => {
  it("F-117: each frame's ingest time lands in its bucket, and one line sums an interval", async () => {
    const records: LogRecord[] = [];
    const logger = createLogger((record) => records.push(record));
    let clock = 0;
    const durations = [3, 7, 40, 700, 4000];
    let call = 0;
    const timed = timedIngest(
      (): Promise<readonly DownFrame[]> => {
        clock += durations[call] ?? 0;
        call += 1;
        return Promise.resolve([]);
      },
      logger,
      { intervalMs: 3_600_000, now: () => clock },
    );
    const frame = (events: number): EventsFrame =>
      eventsFrameSchema.parse({
        type: "events",
        events: Array.from({ length: events }, (_unused, index) => ({
          sessionId: "0198a3c4-0000-7000-8000-000000000002",
          sessionSeq: index + 1,
          leaseEpoch: 1,
          at: 1_800_000_000_000,
          event: { kind: "turn.started", turnId: "0198a3c4-0000-7000-8000-000000000004" },
        })),
      });
    for (const events of [1, 2, 3, 4, 5]) {
      await timed.ingest(runner, frame(events));
    }
    timed.stop();
    const lines = records.filter((record) => record.message === "ingest.timing");
    expect(lines).toHaveLength(1);
    const fields = lines[0]?.fields ?? {};
    expect(fields).toMatchObject({ frames: 5, events: 15, totalMs: 4750, maxMs: 4000 });
    const buckets = Array.from({ length: ingestTimingBucketsMs.length + 1 }, () => 0);
    // 3 < 5; 7 < 10; 40 < 50; 700 < 1000; 4000 past every bound.
    for (const index of [0, 1, 3, 7, ingestTimingBucketsMs.length]) buckets[index] = (buckets[index] ?? 0) + 1;
    expect(fields["buckets"]).toEqual(buckets);
    // An interval with no frame logs nothing.
    timed.stop();
    expect(records.filter((record) => record.message === "ingest.timing")).toHaveLength(1);
  });
});
