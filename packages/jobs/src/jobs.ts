// The seam: the only file that imports pg-boss (ADR 0037, Q78). Everything else goes through
// `createJobs`, so a swap to DBOS, or a fork, stays bounded. Ported from
// spikes/durable-queue-choice/src/jobs.ts.

import { silentLogger } from "@ostra/adapter-sdk";
import type { Logger } from "@ostra/adapter-sdk";
import type { Tx } from "@ostra/db";
import { jobKey, jobNames, parseJobPayload } from "@ostra/domain";
import type { EnqueueOptions, JobName, JobPayload, JobQueue } from "@ostra/domain";
import { fromPrisma, PgBoss } from "pg-boss";
import type { Queue, SendOptions, WorkOptions } from "pg-boss";
import { z } from "zod";

import { DEAD_LETTER_QUEUE, queueName, queueSettings } from "./definitions.ts";

/**
 * `enqueue-only`: the panel. It enqueues inside its transactions and never migrates, supervises,
 * runs schedules or works (ADR 0016). `worker`: core. It installs the schema and the queues,
 * supervises, runs the schedules and the handlers.
 */
export type JobsRole = "enqueue-only" | "worker";

export type CreateJobsOptions = {
  /** Holds credentials: never logged. */
  readonly databaseUrl: string;
  readonly role: JobsRole;
  /** The name this process shows in pg-boss's registry, such as `core-<host>-<pid>`. */
  readonly instanceName?: string;
  /** pg-boss's own pool. Default 4: jobs are short and the handlers use the app's own client. */
  readonly poolMax?: number;
  /** How often an idle worker polls its queue, in seconds (at least 0.5). Default 2. */
  readonly pollingIntervalSeconds?: number;
  /** How often a worker frees expired and dead-heartbeat jobs, in seconds. Default 30. */
  readonly superviseIntervalSeconds?: number;
  readonly logger?: Logger;
};

/** A job's ID in pg-boss's table: a UUID. */
export const jobIdSchema = z.uuid().brand<"JobId">();
export type JobId = z.infer<typeof jobIdSchema>;

export type SendResult =
  | { readonly kind: "enqueued"; readonly jobId: JobId }
  /** A job with the same key is queued, waiting to retry or running: that one stands (ADR 0037, rule 2). */
  | { readonly kind: "existing"; readonly jobId: JobId | null };

export type JobState = "created" | "retry" | "active" | "completed" | "cancelled" | "failed";

export type JobSummary = {
  readonly id: JobId;
  readonly state: JobState;
  readonly retryCount: number;
  readonly key: string | null;
};

/** What a handler gets: the payload parsed by its job's schema, never the raw row. */
export type JobContext<N extends JobName> = {
  readonly job: N;
  readonly jobId: JobId;
  readonly key: string | null;
  readonly retryCount: number;
  readonly payload: JobPayload<N>;
  readonly logger: Logger;
};

export type JobHandler<N extends JobName> = (context: JobContext<N>) => Promise<void>;

export type WorkerOptions = {
  /** How many of this job one process runs at once. Default 4. */
  readonly localConcurrency?: number;
};

export type Jobs = JobQueue & {
  /** Connects. A worker also installs or upgrades pg-boss's schema and creates every queue. */
  readonly start: () => Promise<void>;
  /** Stops the workers (letting a running handler finish when `graceful`) and closes the pool. */
  readonly stop: (options?: { readonly graceful?: boolean; readonly timeoutMs?: number }) => Promise<void>;
  /** `enqueueInTx`, with what happened: a new job, or the one already under that key. */
  readonly sendInTx: <N extends JobName>(
    tx: Tx,
    job: N,
    payload: JobPayload<N>,
    options?: EnqueueOptions,
  ) => Promise<SendResult>;
  /** Registers a handler (workers only). The payload is parsed by the job's schema first. */
  readonly work: <N extends JobName>(job: N, handler: JobHandler<N>, options?: WorkerOptions) => Promise<void>;
  /**
   * A recurring job by cron, stored in the database: one job per tick however many workers run
   * (workers only). `scheduleKey` tells several schedules of one job apart, such as a provider's ID.
   */
  readonly schedule: <N extends JobName>(job: N, scheduleKey: string, cron: string, payload: JobPayload<N>) => Promise<void>;
  readonly unschedule: (job: JobName, scheduleKey: string) => Promise<void>;
  /** Cancels the queued or retrying job under this payload's key. `true` when one was cancelled. */
  readonly cancelInTx: <N extends JobName>(tx: Tx | null, job: N, payload: JobPayload<N>) => Promise<boolean>;
  /** The jobs under this payload's key, newest last. */
  readonly find: <N extends JobName>(job: N, payload: JobPayload<N>) => Promise<readonly JobSummary[]>;
  readonly role: JobsRole;
};

const jobRowSchema = z.looseObject({
  id: jobIdSchema,
  state: z.enum(["created", "retry", "active", "completed", "cancelled", "failed"]),
  retryCount: z.number().int().nonnegative(),
  singletonKey: z.string().nullable(),
});

const toSendOptions = (key: string, options: EnqueueOptions | undefined): SendOptions => ({
  singletonKey: key,
  // pg-boss counts a delay in whole seconds.
  ...(options?.startAfterMs === undefined || options.startAfterMs <= 0
    ? {}
    : { startAfter: Math.max(1, Math.ceil(options.startAfterMs / 1000)) }),
});

const queueOptions = (job: JobName): Omit<Queue, "name"> => {
  const settings = queueSettings[job];
  return {
    policy: "exclusive",
    retryLimit: settings.retryLimit,
    retryDelay: settings.retryDelay,
    retryBackoff: true,
    retryDelayMax: settings.retryDelayMax,
    heartbeatSeconds: settings.heartbeatSeconds,
    expireInSeconds: settings.expireInSeconds,
    deadLetter: DEAD_LETTER_QUEUE,
  };
};

export const createJobs = (options: CreateJobsOptions): Jobs => {
  const worker = options.role === "worker";
  const logger = (options.logger ?? silentLogger).child({ component: "jobs" });
  const pollingIntervalSeconds = Math.max(0.5, options.pollingIntervalSeconds ?? 2);

  const boss = new PgBoss({
    connectionString: options.databaseUrl,
    max: options.poolMax ?? 4,
    ...(options.instanceName === undefined ? {} : { instanceName: options.instanceName }),
    // The panel never migrates, supervises or runs schedules: core does all three.
    migrate: worker,
    supervise: worker,
    schedule: worker,
    superviseIntervalSeconds: options.superviseIntervalSeconds ?? 30,
  });
  boss.on("error", (error: Error) => {
    logger.error("jobs.error", { name: error.name });
  });
  boss.on("warning", (warning) => {
    const type: unknown = Reflect.get(Object(warning.data), "type");
    logger.warn("jobs.warning", { type: typeof type === "string" ? type : "unknown" });
  });

  const requireWorker = (what: string): void => {
    if (!worker) {
      throw new Error(`jobs: ${what} needs the worker role; this instance is enqueue-only`);
    }
  };

  const sendInTx = async <N extends JobName>(
    tx: Tx,
    job: N,
    payload: JobPayload<N>,
    enqueueOptions?: EnqueueOptions,
  ): Promise<SendResult> => {
    const parsed = parseJobPayload(job, payload);
    if (!parsed.ok) {
      throw new Error(`jobs: the payload of ${job} doesn't match its schema`);
    }
    const key = jobKey(job, parsed.payload);
    // Written through the caller's transaction: the job exists only if that commits.
    const db = fromPrisma(tx);
    const id = await boss.send(queueName(job), parsed.payload, { ...toSendOptions(key, enqueueOptions), db });
    if (id !== null) {
      logger.debug("job.enqueued", { job, key });
      return { kind: "enqueued", jobId: jobIdSchema.parse(id) };
    }
    const [existing] = await boss.findJobs(queueName(job), { key, queued: true, db });
    logger.debug("job.existing", { job, key });
    const existingId = jobIdSchema.safeParse(existing?.id);
    return { kind: "existing", jobId: existingId.success ? existingId.data : null };
  };

  const find = async <N extends JobName>(job: N, payload: JobPayload<N>): Promise<readonly JobSummary[]> => {
    const rows = await boss.findJobs(queueName(job), { key: jobKey(job, payload) });
    const out: JobSummary[] = [];
    for (const row of rows) {
      const parsed = jobRowSchema.safeParse(row);
      if (parsed.success) {
        out.push({
          id: parsed.data.id,
          state: parsed.data.state,
          retryCount: parsed.data.retryCount,
          key: parsed.data.singletonKey,
        });
      }
    }
    return out;
  };

  return {
    role: options.role,
    start: async () => {
      await boss.start();
      if (worker) {
        await boss.createQueue(DEAD_LETTER_QUEUE, { policy: "standard", retentionSeconds: 14 * 24 * 3600 });
        for (const job of jobNames) {
          await boss.createQueue(queueName(job), queueOptions(job));
        }
      }
      logger.info("jobs.started", { role: options.role });
    },
    stop: async (stopOptions) => {
      await boss.stop({
        graceful: stopOptions?.graceful ?? true,
        timeout: stopOptions?.timeoutMs ?? 10_000,
      });
    },
    enqueueInTx: async (tx, job, payload, enqueueOptions) => {
      await sendInTx(tx, job, payload, enqueueOptions);
    },
    sendInTx,
    work: async (job, handler, workerOptions) => {
      requireWorker("work()");
      // A literal `includeMetadata: true` is what makes pg-boss type the jobs with their metadata.
      const workOptions = {
        includeMetadata: true,
        localConcurrency: workerOptions?.localConcurrency ?? 4,
        pollingIntervalSeconds,
        batchSize: 1,
      } as const satisfies WorkOptions;
      await boss.work<unknown, undefined, typeof workOptions>(queueName(job), workOptions, async (batch) => {
        for (const raw of batch) {
          const parsed = parseJobPayload(job, raw.data);
          const key = raw.singletonKey;
          const jobId = jobIdSchema.parse(raw.id);
          if (!parsed.ok) {
            logger.error("job.payload-invalid", { job, jobId });
            throw new Error(`the payload of ${job} doesn't match its schema`);
          }
          const jobLogger = logger.child({ job, jobId, key });
          try {
            await handler({
              job,
              jobId,
              key,
              retryCount: raw.retryCount,
              payload: parsed.payload,
              logger: jobLogger,
            });
          } catch (error) {
            jobLogger.warn("job.failed", {
              retryCount: raw.retryCount,
              error: error instanceof Error ? error.name : "unknown",
            });
            throw error;
          }
        }
        return undefined;
      });
    },
    schedule: async (job, scheduleKey, cron, payload) => {
      requireWorker("schedule()");
      const parsed = parseJobPayload(job, payload);
      if (!parsed.ok) {
        throw new Error(`jobs: the payload of ${job} doesn't match its schema`);
      }
      await boss.schedule(queueName(job), cron, parsed.payload, {
        key: scheduleKey,
        singletonKey: jobKey(job, parsed.payload),
      });
    },
    unschedule: async (job, scheduleKey) => {
      requireWorker("unschedule()");
      await boss.unschedule(queueName(job), scheduleKey);
    },
    cancelInTx: async (tx, job, payload) => {
      const key = jobKey(job, payload);
      const connection = tx === null ? {} : { db: fromPrisma(tx) };
      const queued = await boss.findJobs(queueName(job), { key, queued: true, ...connection });
      const ids = queued.map((row) => row.id);
      if (ids.length === 0) {
        return false;
      }
      const response = await boss.cancel(queueName(job), ids, connection);
      logger.debug("job.cancelled", { job, key, count: response.affected });
      return response.affected > 0;
    },
    find,
  };
};
