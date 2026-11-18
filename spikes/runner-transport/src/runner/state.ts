import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { CommandId, SessionId, TaskId } from "../protocol/ids.ts";

// The runner's own durable state: which commands it applied, which one it was
// in the middle of, and its sessions with their lease epochs.

export const SessionState = z.enum(["running", "stopped", "fenced", "stale"]);
export type SessionState = z.infer<typeof SessionState>;

const RunnerState = z.strictObject({
  lastAppliedSeq: z.number().int().nonnegative(),
  applied: z.array(CommandId),
  inflight: z.strictObject({ id: CommandId, seq: z.number().int().positive(), kind: z.string() }).nullable(),
  sessions: z.record(
    SessionId,
    z.strictObject({ taskId: TaskId, leaseEpoch: z.number().int().positive(), state: SessionState }),
  ),
});
export type RunnerState = z.infer<typeof RunnerState>;

export type StateStore = {
  readonly load: () => Promise<RunnerState>;
  readonly save: (s: RunnerState) => Promise<void>;
};

const empty = (): RunnerState => ({ lastAppliedSeq: 0, applied: [], inflight: null, sessions: {} });

export const memoryStateStore = (): StateStore => {
  let saved = empty();
  return {
    load: () => Promise.resolve(structuredClone(saved)),
    save: (s) => {
      saved = structuredClone(s);
      return Promise.resolve();
    },
  };
};

export const fileStateStore = (dir: string): StateStore => {
  const file = path.join(dir, "state.json");
  let chain: Promise<unknown> = Promise.resolve();
  return {
    load: async () => {
      await mkdir(dir, { recursive: true });
      try {
        const parsed = RunnerState.safeParse(JSON.parse(await readFile(file, "utf8")));
        return parsed.success ? parsed.data : empty();
      } catch {
        return empty();
      }
    },
    save: (s) => {
      const text = JSON.stringify(s);
      const next = chain.then(async () => {
        const tmp = `${file}.tmp`;
        await writeFile(tmp, text);
        await rename(tmp, file);
      });
      chain = next.catch(() => undefined);
      return next;
    },
  };
};
