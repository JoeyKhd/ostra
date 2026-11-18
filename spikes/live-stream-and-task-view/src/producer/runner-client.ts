import { commandsResponse, type RunnerCommand } from "../shared/api.ts";
import { ingestResponse, type IngestBatch, type LiveTextFrame, type RunnerEvent, type TaskEvent } from "../shared/events.ts";
import type { SegmentId, TaskId } from "../shared/ids.ts";
import { sleep } from "../shared/time.ts";

// A stand-in for the runner's side of ADR 0034 over HTTP: per-task runner sequence numbers, batches
// that stay queued until acknowledged, and a resend that is safe because saving is idempotent.

type TaskState = {
  runnerSeq: number;
  acked: number;
  buffer: RunnerEvent[];
  live: Map<SegmentId, LiveTextFrame>;
};

export type RunnerClientStats = {
  emitted: number;
  acked: number;
  requests: number;
  retries: number;
  failures: number;
  gaps: number;
};

export type RunnerClientOptions = {
  readonly baseUrl: string;
  readonly token: string;
  readonly batchMs: number;
};

export type RunnerClient = {
  readonly stats: RunnerClientStats;
  readonly emit: (taskId: TaskId, event: TaskEvent, at?: number) => number;
  // Partial text: the latest accumulated text per segment, shipped with the next batch.
  readonly live: (taskId: TaskId, frame: LiveTextFrame) => void;
  readonly start: () => void;
  readonly stop: () => Promise<void>;
  readonly pendingCount: () => number;
  readonly drain: (timeoutMs: number) => Promise<void>;
  readonly flush: () => Promise<void>;
  readonly commands: (taskId: TaskId, after: number) => Promise<RunnerCommand[]>;
};

export const createRunnerClient = (options: RunnerClientOptions): RunnerClient => {
  const stats: RunnerClientStats = { emitted: 0, acked: 0, requests: 0, retries: 0, failures: 0, gaps: 0 };
  const tasks = new Map<TaskId, TaskState>();
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  let stopped = false;

  const state = (taskId: TaskId): TaskState => {
    let found = tasks.get(taskId);
    if (found === undefined) {
      found = { runnerSeq: 0, acked: 0, buffer: [], live: new Map() };
      tasks.set(taskId, found);
    }
    return found;
  };

  const pendingCount = (): number => {
    let n = 0;
    for (const task of tasks.values()) n += task.buffer.length;
    return n;
  };

  const sendOnce = async (): Promise<void> => {
    const batches: IngestBatch[] = [];
    const sentCounts: { taskId: TaskId; events: number; lastSeq: number }[] = [];
    for (const [taskId, task] of tasks) {
      if (task.buffer.length === 0 && task.live.size === 0) continue;
      const events = task.buffer.slice(0, 2000);
      const live = [...task.live.values()];
      batches.push({ taskId, events, live });
      sentCounts.push({ taskId, events: events.length, lastSeq: events[events.length - 1]?.runnerSeq ?? 0 });
    }
    if (batches.length === 0) return;
    // Live frames are sent once; a lost partial is display only.
    for (const batch of batches) state(batch.taskId).live.clear();
    stats.requests += 1;
    let response: Response;
    try {
      response = await fetch(`${options.baseUrl}/runner/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${options.token}` },
        body: JSON.stringify({ tasks: batches }),
      });
    } catch {
      stats.failures += 1;
      stats.retries += 1;
      return; // events stay buffered and go again
    }
    if (!response.ok) {
      stats.failures += 1;
      stats.retries += 1;
      await response.arrayBuffer().catch(() => undefined);
      return;
    }
    const parsed = ingestResponse.parse(await response.json());
    parsed.outcomes.forEach((outcome, i) => {
      const sent = sentCounts[i];
      if (sent === undefined) return;
      const task = state(sent.taskId);
      if (outcome.ok) {
        task.buffer = task.buffer.filter((e) => e.runnerSeq > sent.lastSeq);
        task.acked = Math.max(task.acked, outcome.lastRunnerSeq);
        stats.acked += sent.events;
      } else if (outcome.reason === "gap") {
        stats.gaps += 1;
      }
    });
  };

  const flush = async (): Promise<void> => {
    if (inFlight !== null) {
      await inFlight;
      return;
    }
    const run = sendOnce();
    inFlight = run;
    try {
      await run;
    } finally {
      inFlight = null;
    }
  };

  const drain = async (timeoutMs: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (pendingCount() > 0 && Date.now() < deadline) {
      await flush().catch(() => undefined);
      if (pendingCount() > 0) await sleep(50);
    }
  };

  const start = (): void => {
    stopped = false;
    const loop = (): void => {
      if (stopped) return;
      timer = setTimeout(() => {
        const run = flush().catch(() => undefined);
        void run.finally(loop);
      }, options.batchMs);
    };
    loop();
  };

  return {
    stats,
    emit: (taskId, event, at = Date.now()) => {
      const task = state(taskId);
      task.runnerSeq += 1;
      task.buffer.push({ runnerSeq: task.runnerSeq, at, event });
      stats.emitted += 1;
      return task.runnerSeq;
    },
    live: (taskId, frame) => {
      state(taskId).live.set(frame.segmentId, frame);
    },
    start,
    stop: async () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      await drain(10_000);
    },
    pendingCount,
    drain,
    flush,
    commands: async (taskId, after) => {
      const url = `${options.baseUrl}/runner/commands?taskId=${encodeURIComponent(taskId)}&after=${String(after)}`;
      const response = await fetch(url, { headers: { authorization: `Bearer ${options.token}` } });
      if (!response.ok) throw new Error(`commands ${String(response.status)}`);
      return commandsResponse.parse(await response.json()).commands;
    },
  };
};
