// THE DBOS SEAM. The only file that imports @dbos-inc/dbos-sdk, as src/jobs.ts is for pg-boss.
// It covers what C3 and C4 need on DBOS Transact's MIT core: two workflows (a scheduled fire and a
// piece of group work), a partitioned queue (the limit per key), runtime schedules, and a producer
// client that never launches DBOS (the panel's role, ADR 0016).
//
// Not used, on purpose: Conductor and the Enterprise package (research/durable-execution.md).

import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";
import type { DLogger } from "@dbos-inc/dbos-sdk";
import type { z } from "zod";
import { groupWorkPayload, scheduleFirePayload } from "../payloads.ts";
import type { LogEvent } from "../jobs.ts";

/** The application every replica and the producer share. Schedules and queues are scoped by it. */
export const DBOS_APP_NAME = "ostra-spike8";
/**
 * Pinned, not DBOS's default (a hash of the workflow source): recovery only picks up workflows whose
 * version matches, and every replica of one release must agree (research/durable-execution.md).
 */
export const DBOS_APP_VERSION = "spike8-v1";
export const SCHEDULE_FIRE_WORKFLOW = "schedule-fire";
export const GROUP_WORK_WORKFLOW = "group-work";
export const GROUP_QUEUE = "group-work";

export type ScheduleFireContext = z.output<typeof scheduleFirePayload>;
export type GroupWork = z.output<typeof groupWorkPayload>;

export type DbosWorkflowContext = {
  /** The workflow's ID: deterministic for a scheduled run (`sched-<schedule>-<tick ISO>`). */
  readonly workflowId: string;
};

export type DbosCoreOptions = {
  readonly connectionString: string;
  /**
   * DBOS's executor ID. Without Conductor, a process restarted under the same ID recovers the PENDING
   * workflows that ID left; nothing recovers those of an ID that never comes back.
   */
  readonly executorId: string;
  readonly poolSize: number;
  readonly onLog: (event: LogEvent) => void;
  readonly scheduleFire?: (scheduledAt: Date, context: ScheduleFireContext, meta: DbosWorkflowContext) => Promise<void>;
  readonly groupWork?: {
    /** Limit per partition key, across every replica (DBOS's partitionConcurrency). */
    readonly partitionConcurrency: number;
    /** Workflows of this queue one process runs at once (pg-boss's localConcurrency). */
    readonly workerConcurrency: number;
    readonly pollingIntervalMs: number;
    readonly handler: (work: GroupWork, meta: DbosWorkflowContext) => Promise<void>;
  };
};

export type DbosCore = {
  stop: (options: { readonly workflowCompletionTimeoutMs: number }) => Promise<void>;
};

/** A DBOS log entry, reduced to a short string: DBOS's own messages, never a workflow's inputs. */
const describeEntry = (entry: unknown): string => {
  if (entry instanceof Error) {
    return `${entry.name}: ${entry.message}`.slice(0, 300);
  }
  return typeof entry === "string" ? entry.slice(0, 300) : "non-string log entry";
};

const loggerFor = (onLog: (event: LogEvent) => void): DLogger => ({
  info: () => undefined,
  debug: () => undefined,
  warn: (entry) => {
    onLog({ level: "warn", event: "dbos.warn", fields: { message: describeEntry(entry) } });
  },
  error: (entry) => {
    onLog({ level: "error", event: "dbos.error", fields: { message: describeEntry(entry) } });
  },
});

const currentWorkflowId = (): string => {
  const workflowId = DBOS.workflowID;
  if (workflowId === undefined) {
    throw new Error("a DBOS workflow ran without a workflow ID");
  }
  return workflowId;
};

/**
 * Starts DBOS in this process as a core replica: registers the workflows, launches (which migrates
 * the `dbos` schema, recovers this executor's PENDING workflows, starts the queue dispatcher and the
 * scheduler), then registers the queue. DBOS is a process-wide singleton: one core per process.
 */
export const startDbosCore = async (options: DbosCoreOptions): Promise<DbosCore> => {
  const { scheduleFire, groupWork } = options;
  if (scheduleFire !== undefined) {
    DBOS.registerWorkflow(
      async (scheduledAt: Date, context: unknown) => {
        // Stored data is external data: the context comes back from the system database.
        const parsed = scheduleFirePayload.parse(context);
        const workflowId = currentWorkflowId();
        // A step, so a run recovered after its replica died does not repeat a recorded effect.
        await DBOS.runStep(() => scheduleFire(scheduledAt, parsed, { workflowId }), { name: "record-fire" });
      },
      { name: SCHEDULE_FIRE_WORKFLOW },
    );
  }
  if (groupWork !== undefined) {
    DBOS.registerWorkflow(
      async (raw: unknown) => {
        const work = groupWorkPayload.parse(raw);
        const workflowId = currentWorkflowId();
        await DBOS.runStep(() => groupWork.handler(work, { workflowId }), { name: "work" });
      },
      { name: GROUP_WORK_WORKFLOW },
    );
  }

  DBOS.setConfig({
    name: DBOS_APP_NAME,
    systemDatabaseUrl: options.connectionString,
    systemDatabasePoolSize: options.poolSize,
    executorID: options.executorId,
    applicationVersion: DBOS_APP_VERSION,
    logger: loggerFor(options.onLog),
    // pg-boss ran with LISTEN/NOTIFY off; DBOS's queues poll either way.
    useListenNotify: false,
  });
  await DBOS.launch();

  if (groupWork !== undefined) {
    await DBOS.registerQueue(GROUP_QUEUE, {
      partitionConcurrency: groupWork.partitionConcurrency,
      workerConcurrency: groupWork.workerConcurrency,
      minPollingIntervalMs: groupWork.pollingIntervalMs,
      onConflict: "always_update",
    });
  }

  return {
    stop: async ({ workflowCompletionTimeoutMs }) => {
      await DBOS.shutdown({ workflowCompletionTimeoutMS: workflowCompletionTimeoutMs });
    },
  };
};

export type DbosProducer = {
  /** Creates one schedule of the schedule-fire workflow, owned by the replicas' application. */
  createSchedule: (name: string, cron: string, context: z.input<typeof scheduleFirePayload>) => Promise<void>;
  deleteSchedule: (name: string) => Promise<void>;
  /** Enqueues one piece of group work on the partitioned queue, the key as its partition. */
  enqueueGroupWork: (work: z.input<typeof groupWorkPayload>) => Promise<string>;
  destroy: () => Promise<void>;
};

type GroupWorkFn = (work: GroupWork) => Promise<void>;

/** The panel's side: a client over the system database. It never launches DBOS and runs no workflow. */
export const createDbosProducer = async (connectionString: string): Promise<DbosProducer> => {
  const client = await DBOSClient.create({
    systemDatabaseUrl: connectionString,
    applicationName: DBOS_APP_NAME,
    systemDatabasePoolSize: 4,
  });
  return {
    createSchedule: async (name, cron, context) => {
      await client.createSchedule({
        scheduleName: name,
        workflowName: SCHEDULE_FIRE_WORKFLOW,
        schedule: cron,
        context: scheduleFirePayload.parse(context),
      });
    },
    deleteSchedule: async (name) => {
      await client.deleteSchedule(name);
    },
    enqueueGroupWork: async (work) => {
      const parsed = groupWorkPayload.parse(work);
      const handle = await client.enqueue<GroupWorkFn>(
        {
          queueName: GROUP_QUEUE,
          workflowName: GROUP_WORK_WORKFLOW,
          queuePartitionKey: parsed.key,
          appVersion: DBOS_APP_VERSION,
        },
        parsed,
      );
      return handle.workflowID;
    },
    destroy: async () => {
      await client.destroy();
    },
  };
};

/**
 * Creates or migrates DBOS's `dbos` schema once, before any replica launches. Three replicas launching
 * on a cold database at once race their migrations: the first run of D3 failed one replica's launch with
 * `deadlock detected` (pg-boss's concurrent install, C3 and C4, has no such race). So the core service's
 * install step runs this, as it runs `prisma migrate deploy`.
 */
export const migrateDbos = async (connectionString: string): Promise<void> => {
  await DBOS.migrate(connectionString);
};
