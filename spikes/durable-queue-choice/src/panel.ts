// The "panel" process, run as a child. In ostra this is the Next.js server: it enqueues jobs inside
// its own Prisma transactions and manages schedules, but never runs a worker, never supervises and
// never migrates (ADR 0016, ADR 0037). The harness drives it over IPC.

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.ts";
import { boardIdSchema, transitionJobKey } from "./ids.ts";
import type { JobId, TaskId } from "./ids.ts";
import {
  githubEffectJob,
  githubEffectNaiveJob,
  groupWorkJob,
  scheduleFireJob,
  taskTimeoutJob,
  taskTransitionJob,
} from "./job-defs.ts";
import { createJobs } from "./jobs.ts";
import type { EnqueueResult, LogEvent } from "./jobs.ts";
import { panelCommandSchema, panelConfigSchema } from "./messages.ts";
import type { PanelCommand, PanelOut, PanelReply } from "./messages.ts";

const rawConfig: unknown = JSON.parse(process.env["PANEL_CONFIG"] ?? "null");
const config = panelConfigSchema.parse(rawConfig);

const emit = (message: PanelOut): void => {
  process.send?.(message);
};

const log = (event: LogEvent): void => {
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), panel: config.panelId, level: event.level, event: event.event, ...event.fields })}\n`,
  );
};

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: config.databaseUrl, max: 5 }),
});

const jobs = createJobs({
  connectionString: config.databaseUrl,
  role: "producer",
  instanceName: config.panelId,
  poolMax: 3,
  monitorIntervalSeconds: 60,
  superviseIntervalSeconds: 60,
  onLog: log,
});

process.on("disconnect", () => {
  // The harness went away (not our own shutdown): leave.
  if (!stopping) {
    process.exit(1);
  }
});

const ROLLBACK = "spike-rollback";

type Decision = "commit" | "abort";
type Gate = { readonly settle: (decision: Decision) => void; readonly done: Promise<void> };
const openTransactions = new Map<string, Gate>();

const ok = (requestId: string, jobIds: readonly JobId[] = [], details: PanelReply["details"] = {}): PanelReply => ({
  type: "reply",
  requestId,
  ok: true,
  jobIds: [...jobIds],
  details,
});

/**
 * Only the error's class and code leave this process. A Prisma error's message can embed the
 * arguments of the failing query, which in ostra are ticket content, and logs carry IDs and
 * fields, never content (AGENTS.md, Code).
 */
const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? ` ${error.code}` : "";
    return `${error.name}${code}`;
  }
  return "unknown error";
};

const fail = (requestId: string, error: unknown): PanelReply => ({
  type: "reply",
  requestId,
  ok: false,
  error: describeError(error),
  jobIds: [],
  details: {},
});

const idsOf = (result: EnqueueResult): readonly JobId[] => (result.kind === "enqueued" ? [result.jobId] : []);

const kindOf = (result: EnqueueResult): string => result.kind;

/** The fixed key of the transition job a task gets: `task:<TaskId>:prepare:0`. */
const prepareKey = (taskId: TaskId): string => transitionJobKey(taskId, "prepare", 0);

const handle = async (command: PanelCommand): Promise<PanelReply | null> => {
  switch (command.type) {
    case "enqueue-task": {
      let jobIds: readonly JobId[] = [];
      try {
        await prisma.$transaction(async (tx) => {
          await tx.task.create({ data: { id: command.taskId, title: "task", state: "queued" } });
          const payload = { taskId: command.taskId, transition: "prepare", seq: 0 } as const;
          const options = { singletonKey: prepareKey(command.taskId) };
          const result = command.viaTransaction
            ? await jobs.enqueueInTx(tx, taskTransitionJob, payload, options)
            : await jobs.enqueue(taskTransitionJob, payload, options);
          jobIds = idsOf(result);
          if (!command.commit) {
            throw new Error(ROLLBACK);
          }
        });
        return ok(command.requestId, jobIds, { committed: true });
      } catch (error) {
        if (error instanceof Error && error.message === ROLLBACK) {
          return ok(command.requestId, jobIds, { committed: false });
        }
        return fail(command.requestId, error);
      }
    }
    case "open-tx": {
      let settle: (decision: Decision) => void = () => undefined;
      const decision = new Promise<Decision>((resolve) => {
        settle = resolve;
      });
      const done = (async () => {
        try {
          await prisma.$transaction(
            async (tx) => {
              await tx.task.create({ data: { id: command.taskId, title: "task", state: "queued" } });
              const result = await jobs.enqueueInTx(
                tx,
                taskTransitionJob,
                { taskId: command.taskId, transition: "prepare", seq: 0 },
                { singletonKey: prepareKey(command.taskId) },
              );
              emit(ok(command.requestId, idsOf(result), { open: true }));
              if ((await decision) === "abort") {
                throw new Error(ROLLBACK);
              }
            },
            { maxWait: 10_000, timeout: 300_000 },
          );
        } catch (error) {
          if (!(error instanceof Error) || error.message !== ROLLBACK) {
            log({ level: "error", event: "open-tx.failed", fields: { error: describeError(error) } });
          }
        }
      })();
      openTransactions.set(command.requestId, { settle, done });
      return null;
    }
    case "settle-open-tx": {
      const gate = openTransactions.get(command.openRequestId);
      if (gate === undefined) {
        return fail(command.requestId, new Error("no such open transaction"));
      }
      gate.settle(command.decision);
      await gate.done;
      openTransactions.delete(command.openRequestId);
      return ok(command.requestId, [], { settled: command.decision });
    }
    case "send-twice": {
      // ADR 0037, rule 2: "sending a job twice returns the existing one". Both sends use the same fixed key.
      const key = prepareKey(command.taskId);
      const results = await prisma.$transaction(async (tx) => {
        await tx.task.create({ data: { id: command.taskId, title: "task", state: "queued" } });
        if (command.target === "transition") {
          const payload = { taskId: command.taskId, transition: "prepare", seq: 0 } as const;
          const first = await jobs.enqueueInTx(tx, taskTransitionJob, payload, { singletonKey: key });
          const second = await jobs.enqueueInTx(tx, taskTransitionJob, payload, { singletonKey: key });
          return [first, second] as const;
        }
        // The control: a standard queue, delayed so no worker could touch it either way.
        const payload = { taskId: command.taskId, expectState: "queued" } as const;
        const options = { singletonKey: key, startAfterSeconds: 3600 };
        const first = await jobs.enqueueInTx(tx, taskTimeoutJob, payload, options);
        const second = await jobs.enqueueInTx(tx, taskTimeoutJob, payload, options);
        return [first, second] as const;
      });
      return ok(command.requestId, [...idsOf(results[0]), ...idsOf(results[1])], {
        first: kindOf(results[0]),
        second: kindOf(results[1]),
        key,
      });
    }
    case "resend-transition": {
      const result = await prisma.$transaction(async (tx) =>
        jobs.enqueueInTx(
          tx,
          taskTransitionJob,
          { taskId: command.taskId, transition: "prepare", seq: 0 },
          { singletonKey: prepareKey(command.taskId) },
        ),
      );
      return ok(command.requestId, idsOf(result), { kind: kindOf(result) });
    }
    case "enqueue-effects": {
      const definition = command.naive ? githubEffectNaiveJob : githubEffectJob;
      const ids = await prisma.$transaction(async (tx) =>
        jobs.enqueueManyInTx(
          tx,
          definition,
          command.jobs.map((job) => ({ payload: job })),
        ),
      );
      return ok(command.requestId, ids);
    }
    case "enqueue-group": {
      const ids: JobId[] = [];
      for (let offset = 0; offset < command.jobs.length; offset += command.batchSize) {
        const slice = command.jobs.slice(offset, offset + command.batchSize);
        const batch = await prisma.$transaction(async (tx) =>
          jobs.enqueueManyInTx(
            tx,
            groupWorkJob,
            slice.map((job) => ({ payload: job, options: { groupId: job.key } })),
          ),
        );
        ids.push(...batch);
      }
      return ok(command.requestId, ids, { count: ids.length });
    }
    case "send-timeout": {
      const result = await prisma.$transaction(async (tx) => {
        await tx.task.create({ data: { id: command.taskId, title: "task", state: command.taskState } });
        return jobs.enqueueInTx(
          tx,
          taskTimeoutJob,
          { taskId: command.taskId, expectState: command.expectState },
          { startAfterSeconds: command.startAfterSeconds },
        );
      });
      return ok(command.requestId, idsOf(result));
    }
    case "move-task-on": {
      await prisma.task.update({ where: { id: command.taskId }, data: { state: command.newState } });
      return ok(command.requestId);
    }
    case "cancel-timeout": {
      const cancelled = await jobs.cancel(taskTimeoutJob, command.jobId);
      return ok(command.requestId, [command.jobId], { cancelled });
    }
    case "create-schedules": {
      for (let index = 0; index < command.count; index += 1) {
        const board = boardIdSchema.parse(`board-${String(index).padStart(3, "0")}`);
        const guarded = command.guard === "all" || index % 2 === 1;
        await jobs.schedule(
          scheduleFireJob,
          board,
          command.cron,
          { board, variant: guarded ? "guarded" : "plain" },
          guarded ? { singletonKey: board, singletonSeconds: 60 } : undefined,
        );
      }
      return ok(command.requestId, [], { created: command.count });
    }
    case "remove-schedules": {
      for (let index = 0; index < command.count; index += 1) {
        await jobs.unschedule(scheduleFireJob, boardIdSchema.parse(`board-${String(index).padStart(3, "0")}`));
      }
      return ok(command.requestId, [], { removed: command.count });
    }
    case "report": {
      const instances = await jobs.instances();
      const self = instances.find((instance) => instance.pid === process.pid);
      return ok(command.requestId, [], {
        workerRegistrations: jobs.workerRegistrationCount(),
        registered: self !== undefined,
        registrySupervise: self?.supervise ?? false,
        registrySchedule: self?.schedule ?? false,
        registryMigrate: self?.migrate ?? false,
        registryWorkers: self?.workerRegistrations ?? -1,
      });
    }
    case "stop": {
      return null;
    }
    default: {
      command satisfies never;
      return null;
    }
  }
};

let stopping = false;

const shutdown = async (): Promise<void> => {
  if (stopping) {
    return;
  }
  stopping = true;
  await jobs.stop({ graceful: true, timeoutMs: 10_000 });
  await prisma.$disconnect();
  emit({ type: "stopped", panelId: config.panelId });
  // Nothing else may keep the event loop alive: a panel with no worker loops exits by itself once
  // the IPC channel to the harness is closed. The safety timer is unref'd, so it fires only if
  // something else is holding the loop open.
  setTimeout(() => process.exit(3), 5_000).unref();
  process.disconnect();
};

process.on("message", (raw: unknown) => {
  const parsed = panelCommandSchema.safeParse(raw);
  if (!parsed.success) {
    return;
  }
  const command = parsed.data;
  if (command.type === "stop") {
    shutdown().catch(() => {
      process.exit(1);
    });
    return;
  }
  const requestId = command.requestId;
  handle(command)
    .then((reply) => {
      if (reply !== null) {
        emit(reply);
      }
    })
    .catch((error: unknown) => {
      log({ level: "error", event: "command.failed", fields: { type: command.type, error: describeError(error) } });
      emit(fail(requestId, error));
    });
});

const main = async (): Promise<void> => {
  await jobs.start();
  log({ level: "info", event: "panel.ready", fields: {} });
  emit({ type: "ready", panelId: config.panelId, pid: process.pid });
};

main().catch((error: unknown) => {
  // A start() failure is pg-boss's own (a missing schema, a refused connection): it carries no
  // task data, so this one message is forwarded, for the harness to record (C6, step 0).
  const detail = error instanceof Error ? `${error.name}: ${error.message.slice(0, 300)}` : "unknown";
  emit({ type: "fatal", panelId: config.panelId, error: detail });
  process.exit(1);
});
