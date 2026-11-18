import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { fakeEvent } from "../shared/fake-event.ts";

// The event rate criterion 4 runs at: what spike 1 (how-should-the-runner-drive-opencode)
// recorded against the model.env endpoint. Read-only: this spike never writes there.
//
// Order: OSTRA_SPIKE1_EVENTS_PER_MIN (with OSTRA_SPIKE1_BYTES_PER_EVENT) if set;
// else the highest rate any of spike 1's runs recorded (the load floor is about the
// busy case, and a quiet turn's rate would understate it); else a working value.

export type Spike1Rate = {
  readonly eventsPerMin: number;
  /** Stored bytes per event that spike 1 saw, or undefined when unknown. */
  readonly bytesPerEvent: number | undefined;
  /** `--event-bytes` for the fake agent, so a stored event is about `bytesPerEvent` long. */
  readonly padBytes: number;
  readonly source: string;
  readonly fromSpike1: boolean;
};

const RATE_KEY = "events per minute (model.env endpoint)";
const BYTES_KEY = "bytes per minute (model.env endpoint, whole session)";
const FALLBACK = { eventsPerMin: 120, padBytes: 200 } as const;

const Report = z.looseObject({
  passBar: z.array(z.looseObject({ recorded: z.record(z.string(), z.unknown()).optional() })),
});

/** The fake agent's event with no padding, serialized: what padding adds to. */
const overheadBytes = (): number => Buffer.byteLength(JSON.stringify(fakeEvent("sess-load-0", 1, 0)));

const padFor = (bytesPerEvent: number): number => Math.max(0, Math.round(bytesPerEvent - overheadBytes()));

const fromRuns = async (runsDir: string): Promise<{ eventsPerMin: number; bytesPerMin: number | undefined; run: string } | undefined> => {
  let names: string[];
  try {
    names = (await readdir(runsDir)).filter((n) => n.startsWith("run-"));
  } catch {
    return undefined;
  }
  let best: { eventsPerMin: number; bytesPerMin: number | undefined; run: string } | undefined;
  for (const name of names) {
    let text: string;
    try {
      text = await readFile(path.join(runsDir, name, "report.json"), "utf8");
    } catch {
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      continue;
    }
    const r = Report.safeParse(raw);
    if (!r.success) continue;
    for (const c of r.data.passBar) {
      const rate = z.number().positive().safeParse(c.recorded?.[RATE_KEY]);
      if (!rate.success) continue;
      const bytes = z.number().positive().safeParse(c.recorded?.[BYTES_KEY]);
      if (best === undefined || rate.data > best.eventsPerMin) {
        best = { eventsPerMin: rate.data, bytesPerMin: bytes.success ? bytes.data : undefined, run: name };
      }
    }
  }
  return best;
};

export const spike1Rate = async (spikesRoot: string): Promise<Spike1Rate> => {
  const envRate = z.coerce.number().positive().safeParse(process.env["OSTRA_SPIKE1_EVENTS_PER_MIN"]);
  if (envRate.success) {
    const envBytes = z.coerce.number().positive().safeParse(process.env["OSTRA_SPIKE1_BYTES_PER_EVENT"]);
    return {
      eventsPerMin: envRate.data,
      bytesPerEvent: envBytes.success ? envBytes.data : undefined,
      padBytes: envBytes.success ? padFor(envBytes.data) : FALLBACK.padBytes,
      source: "OSTRA_SPIKE1_EVENTS_PER_MIN",
      fromSpike1: true,
    };
  }
  const runsDir = path.join(spikesRoot, "how-should-the-runner-drive-opencode", ".runs");
  const best = await fromRuns(runsDir);
  if (best !== undefined) {
    const bytesPerEvent = best.bytesPerMin === undefined ? undefined : best.bytesPerMin / best.eventsPerMin;
    return {
      eventsPerMin: best.eventsPerMin,
      bytesPerEvent,
      padBytes: bytesPerEvent === undefined ? FALLBACK.padBytes : padFor(bytesPerEvent),
      source: `spike 1's ${best.run}/report.json (the highest rate its runs recorded on the model.env endpoint)`,
      fromSpike1: true,
    };
  }
  return { ...FALLBACK, bytesPerEvent: undefined, source: "a working value: no spike 1 report with a recorded rate was found", fromSpike1: false };
};
