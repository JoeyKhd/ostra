import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { eventSchema, serverOnlyKinds, type TaskEvent } from "../shared/events.ts";
import type { TaskId } from "../shared/ids.ts";
import { sleep } from "../shared/time.ts";
import { bump, createAcpMapper, newReport, type AcpReport } from "./acp-map.ts";
import type { RunnerClient } from "./runner-client.ts";

// Replays a recorded session through the runner client. The format, agreed with spike 1 (whose README
// should say the same): either a JSON Lines file (`*.jsonl`) or one JSON array (`*.json`, which is what
// spike 1's `.runs/*/events.json` captures are). Each line, or each array element, is one of:
//  - an ostra event: {"kind": "agent.message", ...}
//  - a raw ACP JSON-RPC message, bare or wrapped as {"t": <ms>, "msg": {...}}
//  - a spike 1 capture record: {"kind": "session_update", "sessionId", "update", "seq", "at", ...}, which
//    is an ACP `session/update` notification, and {"kind": "prompt_finished", "response": {"stopReason"}},
//    which is the response to `session/prompt`.
// Every line is accounted for: see `ReplayResult`.

const wrapped = z.looseObject({ t: z.number().optional(), msg: z.unknown() });
const captureUpdate = z.looseObject({ kind: z.literal("session_update"), sessionId: z.string().optional(), update: z.unknown() });
const capturePromptFinished = z.looseObject({ kind: z.literal("prompt_finished"), response: z.unknown() });

export type ReplayResult = {
  file: string;
  // lines (or array elements) in the file that held something
  lines: number;
  events: TaskEvent[];
  report: AcpReport;
  // lines that were not valid JSON
  rejectedLines: number;
  // server-owned events found in a recording (a member's message, an answer): the server writes those
  // itself, so replay does not send them. Counted, not silent.
  serverOwnedSkipped: number;
};

// A spike 1 capture record in ACP's own shape.
const toAcp = (json: unknown): unknown => {
  const update = captureUpdate.safeParse(json);
  if (update.success) return { method: "session/update", params: { sessionId: update.data.sessionId, update: update.data.update } };
  const finished = capturePromptFinished.safeParse(json);
  if (finished.success) return { id: "prompt", result: finished.data.response };
  return json;
};

const rawLines = (file: string, text: string): { items: unknown[]; rejected: number } => {
  if (path.extname(file) === ".json") {
    let whole: unknown;
    try {
      whole = JSON.parse(text);
    } catch {
      return { items: [], rejected: 1 };
    }
    const list = z.array(z.unknown()).safeParse(whole);
    return { items: list.success ? list.data : [whole], rejected: 0 };
  }
  const items: unknown[] = [];
  let rejected = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      items.push(JSON.parse(line));
    } catch {
      rejected += 1;
    }
  }
  return { items, rejected };
};

export const parseRecording = (file: string, text: string): ReplayResult => {
  const mapper = createAcpMapper(path.basename(file, path.extname(file)).replace(/[^a-zA-Z0-9-]/g, "-"));
  const events: TaskEvent[] = [];
  const { items, rejected } = rawLines(file, text);
  let serverOwnedSkipped = 0;
  for (const json of items) {
    const own = eventSchema.safeParse(json);
    if (own.success) {
      if (own.data.kind === "agent.unknown") {
        // an ostra `agent.unknown` line is an unknown the recorder already counted
        bump(mapper.report.unknown, "ostra:agent.unknown");
      } else if (serverOnlyKinds.has(own.data.kind)) {
        bump(mapper.report.ignoredByDesign, `ostra:${own.data.kind}`);
        serverOwnedSkipped += 1;
        continue;
      } else {
        bump(mapper.report.mapped, "ostra-event");
      }
      events.push(own.data);
      continue;
    }
    const wrap = wrapped.safeParse(json);
    const payload = wrap.success && wrap.data.msg !== undefined ? wrap.data.msg : json;
    events.push(...mapper.map(toAcp(payload)));
  }
  events.push(...mapper.finish());
  return { file, lines: items.length + rejected, events, report: mapper.report, rejectedLines: rejected, serverOwnedSkipped };
};

export const findRecordings = async (dir: string): Promise<string[]> => {
  try {
    const entries = await readdir(dir);
    return entries.filter((name) => name.endsWith(".jsonl") || name.endsWith(".json")).map((name) => path.join(dir, name));
  } catch {
    return [];
  }
};

// Spike 1's own captures: `<runs>/<run>/events.json`.
export const findCaptures = async (runsDir: string): Promise<string[]> => {
  try {
    const runs = await readdir(runsDir, { withFileTypes: true });
    const found: string[] = [];
    for (const run of runs) {
      if (!run.isDirectory()) continue;
      const file = path.join(runsDir, run.name, "events.json");
      try {
        await readFile(file, "utf8");
        found.push(file);
      } catch {
        // a run directory without a capture
      }
    }
    return found;
  } catch {
    return [];
  }
};

export const replayFile = async (
  client: RunnerClient,
  taskId: TaskId,
  file: string,
  opts: { delayMs: number },
): Promise<ReplayResult> => {
  const result = parseRecording(file, await readFile(file, "utf8"));
  for (const event of result.events) {
    client.emit(taskId, event);
    if (opts.delayMs > 0) await sleep(opts.delayMs);
  }
  return result;
};

export const mergeReports = (reports: readonly AcpReport[]): AcpReport => {
  const merged = newReport();
  for (const report of reports) {
    for (const key of ["mapped", "ignoredByDesign", "unknown"] as const) {
      for (const [name, count] of report[key]) merged[key].set(name, (merged[key].get(name) ?? 0) + count);
    }
  }
  return merged;
};
