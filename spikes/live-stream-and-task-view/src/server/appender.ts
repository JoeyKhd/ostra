import type { PoolClient } from "pg";
import { z } from "zod";
import type { AppenderMetrics } from "../shared/api.ts";
import type { LiveTextFrame, TaskEvent } from "../shared/events.ts";
import { TaskId, type SegmentId } from "../shared/ids.ts";
import { rows, withTx, type Db } from "./db.ts";
import type { Logger } from "./log.ts";

export type DraftEvent = {
  readonly runnerSeq: number | null; // null for events the server itself writes (a member's message, an answer)
  readonly at: number;
  readonly event: TaskEvent;
};

export type AppendRequest = {
  readonly taskId: TaskId;
  readonly events: readonly DraftEvent[];
  readonly live: readonly LiveTextFrame[];
};

export type AppendOutcome =
  | { ok: true; accepted: number; duplicates: number; headSeq: number; lastRunnerSeq: number }
  | { ok: false; reason: "unknown-task" }
  | { ok: false; reason: "gap"; expectedRunnerSeq: number };

export type WakeItem = { readonly taskId: TaskId; readonly seq: number; readonly live: boolean };

export type CommitResult = {
  readonly outcomes: AppendOutcome[];
  readonly wake: WakeItem[];
  readonly stats: { readonly payloadBytes: number; readonly liveUpserts: number; readonly liveBytes: number };
};

const counterRow = z.object({
  task_id: TaskId,
  next_seq: z.coerce.number(),
  last_runner_seq: z.coerce.number(),
});

type Counter = { nextSeq: number; lastRunnerSeq: number; touchedLive: boolean; changed: boolean };

// Segments whose completed message committed recently, per appender. A late partial for one of them must
// not resurrect its live row. A janitor also deletes rows nobody refreshed for a minute.
type RecentlyCompleted = Map<string, number>;
const COMPLETED_TTL_MS = 60_000;

const segmentKey = (taskId: TaskId, segmentId: SegmentId): string => `${taskId}\u0000${segmentId}`;

// Saves a batch of requests inside the caller's transaction. One statement per table, however many
// events: the counter rows are locked in task order, so two writers never deadlock.
const commitBatch = async (client: PoolClient, requests: readonly AppendRequest[], recent: RecentlyCompleted): Promise<CommitResult> => {
  const taskIds = [...new Set(requests.map((r) => r.taskId))].sort();
  const locked = await rows(
    client,
    counterRow,
    "SELECT task_id, next_seq, last_runner_seq FROM task_counters WHERE task_id = ANY($1::text[]) ORDER BY task_id FOR UPDATE",
    [taskIds],
  );
  const counters = new Map<TaskId, Counter>();
  for (const row of locked) {
    counters.set(row.task_id, {
      nextSeq: row.next_seq,
      lastRunnerSeq: row.last_runner_seq,
      touchedLive: false,
      changed: false,
    });
  }

  const evTask: string[] = [];
  const evSeq: number[] = [];
  const evRunner: (number | null)[] = [];
  const evAt: number[] = [];
  const evKind: string[] = [];
  const evPayload: string[] = [];
  let payloadBytes = 0;

  const apId: string[] = [];
  const apTask: string[] = [];
  const apTool: string[] = [];
  const apOptions: string[] = [];

  const doneTask: string[] = [];
  const doneSegment: string[] = [];

  const liveByKey = new Map<string, { frame: LiveTextFrame; taskId: TaskId }>();

  const outcomes: AppendOutcome[] = [];

  for (const request of requests) {
    const counter = counters.get(request.taskId);
    if (counter === undefined) {
      outcomes.push({ ok: false, reason: "unknown-task" });
      continue;
    }
    let accepted = 0;
    let duplicates = 0;
    let gap: number | null = null;
    for (const draft of request.events) {
      if (draft.runnerSeq !== null) {
        if (draft.runnerSeq <= counter.lastRunnerSeq) {
          duplicates += 1;
          continue;
        }
        if (draft.runnerSeq !== counter.lastRunnerSeq + 1) {
          gap = counter.lastRunnerSeq + 1;
          break;
        }
        counter.lastRunnerSeq = draft.runnerSeq;
      }
      const { kind, ...payload } = draft.event;
      const json = JSON.stringify(payload);
      payloadBytes += json.length;
      evTask.push(request.taskId);
      evSeq.push(counter.nextSeq);
      evRunner.push(draft.runnerSeq);
      evAt.push(draft.at);
      evKind.push(kind);
      evPayload.push(json);
      counter.nextSeq += 1;
      counter.changed = true;
      accepted += 1;
      const event = draft.event;
      if (event.kind === "approval.requested") {
        apId.push(event.approvalId);
        apTask.push(request.taskId);
        apTool.push(event.toolCallId);
        apOptions.push(JSON.stringify(event.options));
      }
      if (event.kind === "agent.message" || event.kind === "agent.thought") {
        doneTask.push(request.taskId);
        doneSegment.push(event.segmentId);
        recent.set(segmentKey(request.taskId, event.segmentId), Date.now());
      }
    }
    for (const frame of request.live) {
      liveByKey.set(segmentKey(request.taskId, frame.segmentId), { frame, taskId: request.taskId });
      counter.touchedLive = true;
    }
    if (gap !== null) {
      outcomes.push({ ok: false, reason: "gap", expectedRunnerSeq: gap });
    } else {
      outcomes.push({
        ok: true,
        accepted,
        duplicates,
        headSeq: counter.nextSeq - 1,
        lastRunnerSeq: counter.lastRunnerSeq,
      });
    }
  }

  if (evTask.length > 0) {
    await client.query(
      `INSERT INTO events (task_id, seq, runner_seq, at_ms, kind, payload)
       SELECT task_id, seq, runner_seq, at_ms, kind, payload::jsonb
       FROM unnest($1::text[], $2::bigint[], $3::bigint[], $4::bigint[], $5::text[], $6::text[])
         AS t(task_id, seq, runner_seq, at_ms, kind, payload)`,
      [evTask, evSeq, evRunner, evAt, evKind, evPayload],
    );
  }

  const changedIds: string[] = [];
  const changedNext: number[] = [];
  const changedRunner: number[] = [];
  for (const [taskId, counter] of counters) {
    if (!counter.changed) continue;
    changedIds.push(taskId);
    changedNext.push(counter.nextSeq);
    changedRunner.push(counter.lastRunnerSeq);
  }
  if (changedIds.length > 0) {
    await client.query(
      `UPDATE task_counters c SET next_seq = v.next_seq, last_runner_seq = v.last_runner_seq
       FROM unnest($1::text[], $2::bigint[], $3::bigint[]) AS v(task_id, next_seq, last_runner_seq)
       WHERE c.task_id = v.task_id`,
      [changedIds, changedNext, changedRunner],
    );
  }

  if (apId.length > 0) {
    await client.query(
      `INSERT INTO approvals (approval_id, task_id, tool_call_id, options)
       SELECT approval_id, task_id, tool_call_id, options::jsonb
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS t(approval_id, task_id, tool_call_id, options)
       ON CONFLICT (approval_id) DO NOTHING`,
      [apId, apTask, apTool, apOptions],
    );
  }

  if (doneTask.length > 0) {
    await client.query(
      `DELETE FROM task_live_text l USING unnest($1::text[], $2::text[]) AS d(task_id, segment_id)
       WHERE l.task_id = d.task_id AND l.segment_id = d.segment_id`,
      [doneTask, doneSegment],
    );
  }

  const liveTask: string[] = [];
  const liveSegment: string[] = [];
  const liveTurn: string[] = [];
  const livePart: string[] = [];
  const liveText: string[] = [];
  let liveBytes = 0;
  for (const [key, { frame, taskId }] of liveByKey) {
    if (recent.has(key)) continue;
    liveTask.push(taskId);
    liveSegment.push(frame.segmentId);
    liveTurn.push(frame.turnId);
    livePart.push(frame.part);
    liveText.push(frame.text);
    liveBytes += frame.text.length;
  }
  if (liveTask.length > 0) {
    // Every open segment upserts its whole accumulated text on every flush: this is the UNLOGGED table's cost.
    await client.query(
      `INSERT INTO task_live_text (task_id, segment_id, turn_id, part, text)
       SELECT task_id, segment_id, turn_id, part, text
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[]) AS t(task_id, segment_id, turn_id, part, text)
       ON CONFLICT (task_id, segment_id) DO UPDATE SET text = EXCLUDED.text, updated_at = now()`,
      [liveTask, liveSegment, liveTurn, livePart, liveText],
    );
  }

  const doneTasks = new Set(doneTask);
  const wake: WakeItem[] = [];
  for (const [taskId, counter] of counters) {
    if (counter.changed || counter.touchedLive) {
      wake.push({ taskId, seq: counter.nextSeq - 1, live: counter.touchedLive || doneTasks.has(taskId) });
    }
  }
  return { outcomes, wake, stats: { payloadBytes, liveUpserts: liveTask.length, liveBytes } };
};

type Pending = {
  request: AppendRequest;
  resolve: (outcome: AppendOutcome) => void;
  reject: (error: unknown) => void;
};

export type Appender = {
  readonly metrics: AppenderMetrics;
  // Group commit: requests that arrive while a transaction is open ride in the next one.
  readonly append: (request: AppendRequest) => Promise<AppendOutcome>;
  // The same commit inside a transaction the caller owns (a member's message, an answer, a take-over).
  readonly commit: (client: PoolClient, requests: readonly AppendRequest[]) => Promise<CommitResult>;
};

export const createAppender = (db: Db, flushMs: number, afterCommit: (wake: WakeItem[]) => void, log: Logger): Appender => {
  const metrics: AppenderMetrics = {
    flushes: 0,
    eventsCommitted: 0,
    flushMsTotal: 0,
    flushMsMax: 0,
    maxBatchEvents: 0,
    failures: 0,
    liveUpserts: 0,
    liveBytes: 0,
    payloadBytes: 0,
  };
  const recent: RecentlyCompleted = new Map();
  let queue: Pending[] = [];
  let timer: NodeJS.Timeout | null = null;
  let flushing = false;

  const purgeCompleted = (): void => {
    if (recent.size === 0) return;
    const cutoff = Date.now() - COMPLETED_TTL_MS;
    for (const [key, at] of recent) if (at < cutoff) recent.delete(key);
  };

  const flush = async (): Promise<void> => {
    if (flushing) return;
    const batch = queue;
    if (batch.length === 0) return;
    queue = [];
    flushing = true;
    const started = performance.now();
    try {
      const { outcomes, wake, stats } = await withTx(db, (client) =>
        commitBatch(
          client,
          batch.map((p) => p.request),
          recent,
        ),
      );
      let committed = 0;
      batch.forEach((pending, i) => {
        const outcome = outcomes[i];
        if (outcome === undefined) {
          pending.reject(new Error("missing outcome"));
          return;
        }
        if (outcome.ok) committed += outcome.accepted;
        pending.resolve(outcome);
      });
      const ms = performance.now() - started;
      metrics.flushes += 1;
      metrics.eventsCommitted += committed;
      metrics.flushMsTotal += ms;
      metrics.flushMsMax = Math.max(metrics.flushMsMax, ms);
      metrics.maxBatchEvents = Math.max(metrics.maxBatchEvents, committed);
      metrics.payloadBytes += stats.payloadBytes;
      metrics.liveUpserts += stats.liveUpserts;
      metrics.liveBytes += stats.liveBytes;
      afterCommit(wake);
    } catch (error) {
      metrics.failures += 1;
      log.error("append.flush_failed", { requests: batch.length });
      for (const pending of batch) pending.reject(error);
    } finally {
      flushing = false;
      if (queue.length > 0) setImmediate(() => void flush());
    }
    purgeCompleted();
  };

  const schedule = (): void => {
    if (flushing || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, flushMs);
  };

  return {
    metrics,
    append: (request) =>
      new Promise<AppendOutcome>((resolve, reject) => {
        queue.push({ request, resolve, reject });
        schedule();
      }),
    commit: (client, requests) => commitBatch(client, requests, recent),
  };
};
