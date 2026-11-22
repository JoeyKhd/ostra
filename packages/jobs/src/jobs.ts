// The seam: the only file that imports pg-boss (ADR 0037, Q78). Everything else goes through
// `createJobs`, so a swap to DBOS, or a fork, stays bounded. Ported from
// spikes/durable-queue-choice/src/jobs.ts.

import { silentLogger } from "@ostra/adapter-sdk";
import type { Logger } from "@ostra/adapter-sdk";
import { utcConnectionString } from "@ostra/db";
import type { Tx } from "@ostra/db";
import { jobKey, jobNames, parseJobPayload } from "@ostra/domain";
import type { EnqueueOptions, JobName, JobPayload, JobQueue } from "@ostra/domain";
import { fromPrisma, PgBoss } from "pg-boss";
import type { Queue, SendOptions, WorkOptions } from "pg-boss";
import { z } from "zod";

import { CRON_FORWARD_POLL_SECONDS, CRON_PASS_SECONDS, cronPeriodSeconds, DEAD_LETTER_QUEUE, FORWARDING_HEARTBEAT_SECONDS, FORWARDING_QUEUE, queueName, queueSettings } from "./definitions.ts";

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

/** What the boot check found (ADR 0037, Q158): a worker refuses to start on any problem. */
export type BootCheck = { readonly ok: true } | { readonly ok: false; readonly problems: readonly string[] };

export type Jobs = JobQueue & {
  /**
   * Connects. A worker also installs or upgrades pg-boss's schema, creates every queue, sets the
   * forwarding queue's heartbeat, and runs the boot check: it throws, and no worker runs, when the
   * check fails.
   */
  readonly start: () => Promise<void>;
  /** Reads back the forwarding queue's heartbeat and the session's time zone. */
  readonly bootCheck: () => Promise<BootCheck>;
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
  readonly schedule: <N extends JobName>(
    job: N,
    scheduleKey: string,
    cron: string,
    payload: JobPayload<N>,
    /** The tick's slot; default: the cron's period (`cronPeriodSeconds`). */
    options?: { readonly singletonSeconds?: number },
  ) => Promise<void>;
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

const timezoneRowSchema = z.looseObject({ TimeZone: z.string() });

const toSendOptions = (key: string, options: EnqueueOptions | undefined): SendOptions => ({
  singletonKey: key,
  ...(options?.group === undefined
    ? {}
    : { group: options.group.tier === undefined ? { id: options.group.id } : { id: options.group.id, tier: options.group.tier } }),
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
    // Every session in UTC (Q158).
    connectionString: utcConnectionString(options.databaseUrl),
    max: options.poolMax ?? 4,
    ...(options.instanceName === undefined ? {} : { instanceName: options.instanceName }),
    // The panel never migrates, supervises or runs schedules: core does all three.
    migrate: worker,
    supervise: worker,
    schedule: worker,
    superviseIntervalSeconds: options.superviseIntervalSeconds ?? 30,
    // pg-boss frees dead-heartbeat and expired jobs in its monitor pass, which runs at most every
    // `monitorIntervalSeconds` (default 60), whatever the supervise interval. Kept equal, so a
    // killed replica's job is freed within the supervise interval as documented (ticket 21).
    monitorIntervalSeconds: options.superviseIntervalSeconds ?? 30,
    // A schedule's tick seconds after its minute, not up to half a minute (F-106, ticket 37).
    cronMonitorIntervalSeconds: CRON_PASS_SECONDS,
    cronWorkerIntervalSeconds: CRON_FORWARD_POLL_SECONDS,
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

  const bootCheck = async (): Promise<BootCheck> => {
    const problems: string[] = [];
    const forwarding = await boss.getQueue(FORWARDING_QUEUE);
    if (forwarding === null) {
      problems.push(`pg-boss has no ${FORWARDING_QUEUE} queue: its schedules can't be checked (was pg-boss upgraded?)`);
    } else if (forwarding.heartbeatSeconds !== FORWARDING_HEARTBEAT_SECONDS) {
      problems.push(
        `${FORWARDING_QUEUE} has heartbeatSeconds ${String(forwarding.heartbeatSeconds)}, not ${String(FORWARDING_HEARTBEAT_SECONDS)}: a killed replica would strand its batch for 15 minutes`,
      );
    }
    const zone = timezoneRowSchema.safeParse((await boss.getDb().executeSql("SHOW timezone")).rows[0]);
    if (!zone.success || !/^(UTC|Etc\/UTC)$/i.test(zone.data.TimeZone)) {
      problems.push(`the database session's time zone is ${zone.success ? zone.data.TimeZone : "unreadable"}, not UTC`);
    }
    return problems.length === 0 ? { ok: true } : { ok: false, problems };
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
        // ADR 0037, after spike 8: a heartbeat on the forwarding queue, then the check that it holds.
        if ((await boss.getQueue(FORWARDING_QUEUE)) === null) {
          await boss.createQueue(FORWARDING_QUEUE);
        }
        await boss.updateQueue(FORWARDING_QUEUE, { heartbeatSeconds: FORWARDING_HEARTBEAT_SECONDS });
        const checked = await bootCheck();
        if (!checked.ok) {
          logger.error("jobs.boot_check_failed", { problems: checked.problems.join("; ") });
          await boss.stop({ graceful: false, timeout: 2_000 });
          throw new Error(`jobs: the boot check failed, so no worker starts: ${checked.problems.join("; ")}`);
        }
      }
      logger.info("jobs.started", { role: options.role });
    },
    bootCheck,
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
      const groupConcurrency = queueSettings[job].groupConcurrency;
      const workOptions = {
        includeMetadata: true,
        localConcurrency: workerOptions?.localConcurrency ?? 4,
        pollingIntervalSeconds,
        batchSize: 1,
        // A throttle per group, the same on every replica (ADR 0037).
        ...(groupConcurrency === undefined ? {} : { groupConcurrency }),
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
    schedule: async (job, scheduleKey, cron, payload, scheduleOptions) => {
      requireWorker("schedule()");
      const parsed = parseJobPayload(job, payload);
      if (!parsed.ok) {
        throw new Error(`jobs: the payload of ${job} doesn't match its schema`);
      }
      await boss.schedule(queueName(job), cron, parsed.payload, {
        key: scheduleKey,
        // The tick's slot (ADR 0037, after spike 8): a replayed forwarding batch's second send falls in it.
        singletonKey: jobKey(job, parsed.payload),
        singletonSeconds: scheduleOptions?.singletonSeconds ?? cronPeriodSeconds(cron),
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
