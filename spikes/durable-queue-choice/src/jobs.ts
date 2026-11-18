// The seam: the only file that imports pg-boss (ADR 0037, Q78).
// In ostra this becomes `packages/jobs`. It holds typed job definitions with Zod-checked
// payloads, `enqueueInTx`, worker registration and schedule management.
//
// Everything else in the spike goes through `createJobs`, so a swap to DBOS stays bounded.

import { PgBoss, fromPrisma } from "pg-boss";
import type { JobWithMetadata, PrismaTransactionLike, Queue, WorkOptions } from "pg-boss";
import type { z } from "zod";
import { jobIdSchema } from "./ids.ts";
import type { JobId } from "./ids.ts";

export type JobDefinition<Q extends string, S extends z.ZodType<object>> = {
  readonly queue: Q;
  /** Jobs carry only IDs (ADR 0037, rule 2). The payload is validated on enqueue and on work. */
  readonly payload: S;
  /** What `createQueue` takes: retry, expiry and heartbeat settings, and the queue policy. */
  readonly queueOptions: Omit<Queue, "name">;
};

export type AnyJobDefinition = JobDefinition<string, z.ZodType<object>>;

export const defineJob = <const Q extends string, S extends z.ZodType<object>>(
  definition: JobDefinition<Q, S>,
): JobDefinition<Q, S> => definition;

export type EnqueueOptions = {
  readonly startAfterSeconds?: number;
  readonly singletonKey?: string;
  readonly groupId?: string;
  readonly priority?: number;
};

export type EnqueueResult =
  | { readonly kind: "enqueued"; readonly jobId: JobId }
  | { readonly kind: "deduplicated" };

export type JobContext<S extends z.ZodType<object>> = {
  readonly job: JobWithMetadata<unknown>;
  /** `job.id`, parsed into its branded type once, here at the seam. */
  readonly jobId: JobId;
  readonly payload: z.output<S>;
};

export type WorkerOptions = {
  readonly localConcurrency: number;
  readonly pollingIntervalSeconds: number;
  /** Limit per group id across every replica. pg-boss notes it can briefly overshoot. */
  readonly groupConcurrency?: number;
};

export type JobsRole =
  /** The core service: migrates the schema, supervises, runs schedules and workers. */
  | "core"
  /** The panel: enqueues and manages schedules. Never works, supervises or migrates. */
  | "producer";

export type LogEvent = {
  readonly level: "info" | "warn" | "error";
  readonly event: string;
  readonly fields: Readonly<Record<string, string | number | boolean>>;
};

export type JobsOptions = {
  readonly connectionString: string;
  readonly role: JobsRole;
  readonly instanceName: string;
  readonly poolMax: number;
  readonly monitorIntervalSeconds: number;
  readonly superviseIntervalSeconds: number;
  readonly onLog: (event: LogEvent) => void;
};

export type JobState = "created" | "retry" | "active" | "completed" | "cancelled" | "failed";

export type JobSummary = {
  readonly id: JobId;
  readonly state: JobState;
  readonly retryCount: number;
};

export type InstanceSummary = {
  readonly name: string | null;
  readonly pid: number;
  readonly live: boolean;
  readonly supervise: boolean;
  readonly schedule: boolean;
  readonly migrate: boolean;
  readonly workerRegistrations: number;
};

export type Jobs = {
  start: () => Promise<void>;
  stop: (options: { readonly graceful: boolean; readonly timeoutMs: number }) => Promise<void>;
  /**
   * Core only. Sets the expiry of pg-boss's own schedule-forwarding queue, which has no heartbeat: a replica killed
   * while it holds a batch leaves those occurrences active until this expiry (15 minutes by default).
   */
  setForwardingExpiry: (seconds: number) => Promise<void>;
  /** Core only: creates every queue (idempotent). The panel never does this. */
  installQueues: (definitions: readonly AnyJobDefinition[]) => Promise<void>;
  enqueueInTx: <S extends z.ZodType<object>>(
    tx: PrismaTransactionLike,
    definition: JobDefinition<string, S>,
    payload: z.input<S>,
    options?: EnqueueOptions,
  ) => Promise<EnqueueResult>;
  /** Enqueue on pg-boss's own pool, outside any caller transaction. Only the control scenario uses it. */
  enqueue: <S extends z.ZodType<object>>(
    definition: JobDefinition<string, S>,
    payload: z.input<S>,
    options?: EnqueueOptions,
  ) => Promise<EnqueueResult>;
  enqueueManyInTx: <S extends z.ZodType<object>>(
    tx: PrismaTransactionLike,
    definition: JobDefinition<string, S>,
    items: readonly { readonly payload: z.input<S>; readonly options?: EnqueueOptions }[],
  ) => Promise<readonly JobId[]>;
  work: <S extends z.ZodType<object>>(
    definition: JobDefinition<string, S>,
    options: WorkerOptions,
    handler: (context: JobContext<S>) => Promise<void>,
  ) => Promise<void>;
  schedule: <S extends z.ZodType<object>>(
    definition: JobDefinition<string, S>,
    key: string,
    cron: string,
    payload: z.input<S>,
    options?: { readonly singletonSeconds?: number; readonly singletonKey?: string },
  ) => Promise<void>;
  unschedule: (definition: AnyJobDefinition, key: string) => Promise<void>;
  cancel: (definition: AnyJobDefinition, jobId: JobId) => Promise<boolean>;
  getJob: (definition: AnyJobDefinition, jobId: JobId) => Promise<JobSummary | null>;
  /** Number of `work()` registrations this instance holds in memory. */
  workerRegistrationCount: () => number;
  /** Instances registered in the database, as pg-boss's registry reports them. */
  instances: () => Promise<readonly InstanceSummary[]>;
};

/** pg-boss's internal queue that carries each due schedule occurrence to the worker that creates the job. */
const FORWARDING_QUEUE = "__pgboss__send-it";

const toSendOptions = (options: EnqueueOptions | undefined) => ({
  ...(options?.startAfterSeconds !== undefined ? { startAfter: options.startAfterSeconds } : {}),
  ...(options?.singletonKey !== undefined ? { singletonKey: options.singletonKey } : {}),
  ...(options?.groupId !== undefined ? { group: { id: options.groupId } } : {}),
  ...(options?.priority !== undefined ? { priority: options.priority } : {}),
});

export const createJobs = (options: JobsOptions): Jobs => {
  const producer = options.role === "producer";

  const boss = new PgBoss({
    connectionString: options.connectionString,
    max: options.poolMax,
    instanceName: options.instanceName,
    // The panel never migrates, never supervises and never runs schedules. The core service does all three.
    migrate: !producer,
    supervise: !producer,
    schedule: !producer,
    monitorIntervalSeconds: options.monitorIntervalSeconds,
    superviseIntervalSeconds: options.superviseIntervalSeconds,
  });

  boss.on("error", (error: Error) => {
    options.onLog({ level: "error", event: "pgboss.error", fields: { name: error.name } });
  });
  boss.on("warning", (warning: { message: string; data: { type?: string } }) => {
    options.onLog({ level: "warn", event: "pgboss.warning", fields: { type: warning.data.type ?? "unknown" } });
  });

  let registrations = 0;

  const queueOf = (definition: AnyJobDefinition): string => definition.queue;

  return {
    start: async () => {
      await boss.start();
    },
    stop: async ({ graceful, timeoutMs }) => {
      await boss.stop({ graceful, timeout: timeoutMs });
    },
    setForwardingExpiry: async (seconds) => {
      await boss.updateQueue(FORWARDING_QUEUE, { expireInSeconds: seconds });
    },
    installQueues: async (definitions) => {
      for (const definition of definitions) {
        await boss.createQueue(queueOf(definition), definition.queueOptions);
      }
    },
    enqueueInTx: async (tx, definition, payload, enqueueOptions) => {
      const parsed = definition.payload.parse(payload);
      // The job is written through the caller's transaction, so it exists only if that commits.
      const jobId = await boss.send(queueOf(definition), parsed, {
        ...toSendOptions(enqueueOptions),
        db: fromPrisma(tx),
      });
      return jobId === null ? { kind: "deduplicated" } : { kind: "enqueued", jobId: jobIdSchema.parse(jobId) };
    },
    enqueue: async (definition, payload, enqueueOptions) => {
      const parsed = definition.payload.parse(payload);
      const jobId = await boss.send(queueOf(definition), parsed, toSendOptions(enqueueOptions));
      return jobId === null ? { kind: "deduplicated" } : { kind: "enqueued", jobId: jobIdSchema.parse(jobId) };
    },
    enqueueManyInTx: async (tx, definition, items) => {
      const inserts = items.map((item) => ({
        data: definition.payload.parse(item.payload),
        ...toSendOptions(item.options),
      }));
      const ids = await boss.insert(queueOf(definition), inserts, { db: fromPrisma(tx), returnId: true });
      return (ids ?? []).map((id) => jobIdSchema.parse(id));
    },
    work: async (definition, workerOptions, handler) => {
      // A literal `includeMetadata: true` is what makes pg-boss type the handler's jobs with metadata.
      const workOptions = {
        includeMetadata: true,
        localConcurrency: workerOptions.localConcurrency,
        pollingIntervalSeconds: workerOptions.pollingIntervalSeconds,
        ...(workerOptions.groupConcurrency !== undefined ? { groupConcurrency: workerOptions.groupConcurrency } : {}),
      } as const satisfies WorkOptions;
      await boss.work<unknown, undefined, typeof workOptions>(queueOf(definition), workOptions, async (jobs) => {
        for (const job of jobs) {
          const payload = definition.payload.parse(job.data);
          await handler({ job, jobId: jobIdSchema.parse(job.id), payload });
        }
        return undefined;
      });
      registrations += 1;
    },
    schedule: async (definition, key, cron, payload, scheduleOptions) => {
      const parsed = definition.payload.parse(payload);
      await boss.schedule(queueOf(definition), cron, parsed, {
        key,
        ...(scheduleOptions?.singletonSeconds !== undefined ? { singletonSeconds: scheduleOptions.singletonSeconds } : {}),
        ...(scheduleOptions?.singletonKey !== undefined ? { singletonKey: scheduleOptions.singletonKey } : {}),
      });
    },
    unschedule: async (definition, key) => {
      await boss.unschedule(queueOf(definition), key);
    },
    cancel: async (definition, jobId) => {
      const response = await boss.cancel(queueOf(definition), jobId);
      return response.affected > 0;
    },
    getJob: async (definition, jobId) => {
      const [job] = await boss.findJobs<unknown>(queueOf(definition), { id: jobId });
      return job === undefined ? null : { id: jobIdSchema.parse(job.id), state: job.state, retryCount: job.retryCount };
    },
    workerRegistrationCount: () => registrations,
    instances: async () => {
      const found = await boss.getInstances();
      return found.map((instance) => ({
        name: instance.name,
        pid: instance.pid,
        live: instance.live,
        supervise: instance.supervise,
        schedule: instance.schedule,
        migrate: instance.migrate,
        workerRegistrations: instance.workers.length,
      }));
    },
  };
};
