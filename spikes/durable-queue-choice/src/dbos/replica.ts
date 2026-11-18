// A "core" replica on DBOS Transact, run as a child process: the DBOS twin of src/replica.ts. It
// launches DBOS (migrations, recovery of its own executor's work, the queue dispatcher and the
// scheduler, which fires on whichever replica holds DBOS's background lock) and records what each
// workflow does in ostra's tables, the same rows the pg-boss handlers write.

import { setTimeout as delay } from "node:timers/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.ts";
import type { LogEvent } from "../jobs.ts";
import { replicaInSchema } from "../messages.ts";
import type { ReplicaOut } from "../messages.ts";
import { startDbosCore } from "./jobs.ts";
import type { DbosCore } from "./jobs.ts";
import { dbosReplicaConfigSchema } from "./messages.ts";

const rawConfig: unknown = JSON.parse(process.env["DBOS_REPLICA_CONFIG"] ?? "null");
const config = dbosReplicaConfigSchema.parse(rawConfig);
const replicaId = config.replicaId;

const emit = (message: ReplicaOut): void => {
  process.send?.(message);
};

const log = (event: LogEvent): void => {
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), replica: replicaId, executor: config.executorId, level: event.level, event: event.event, ...event.fields })}\n`,
  );
};

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: config.databaseUrl, max: 10 }),
});

process.on("disconnect", () => {
  process.exit(1);
});

let core: DbosCore | undefined;

const main = async (): Promise<void> => {
  const wants = new Set(config.workers);
  core = await startDbosCore({
    connectionString: config.databaseUrl,
    executorId: config.executorId,
    poolSize: 10,
    onLog: log,
    ...(wants.has("scheduleFire")
      ? {
          scheduleFire: async (_scheduledAt, context, meta) => {
            // jobCreated is overwritten by the harness from the workflow's own created_at: a fire is
            // judged by when DBOS created the workflow, as a pg-boss fire is by its job's created_on.
            await prisma.scheduleFire.create({
              data: { scheduleKey: context.board, variant: context.variant, jobId: meta.workflowId, replicaId, jobCreated: new Date() },
            });
          },
        }
      : {}),
    ...(wants.has("group")
      ? {
          groupWork: {
            partitionConcurrency: config.partitionConcurrency,
            workerConcurrency: config.workerConcurrency,
            pollingIntervalMs: config.pollingIntervalMs,
            handler: async (work, meta) => {
              await prisma.groupEvent.create({ data: { groupKey: work.key, jobId: meta.workflowId, kind: "start", replicaId } });
              await delay(work.workMs);
              await prisma.groupEvent.create({ data: { groupKey: work.key, jobId: meta.workflowId, kind: "end", replicaId } });
            },
          },
        }
      : {}),
  });
  log({ level: "info", event: "replica.ready", fields: { workers: config.workers.length } });
  emit({ type: "ready", replicaId, pid: process.pid });
};

let stopping = false;
process.on("message", (raw: unknown) => {
  const parsed = replicaInSchema.safeParse(raw);
  if (!parsed.success || stopping) {
    return;
  }
  stopping = true;
  const shutdown = async (): Promise<void> => {
    log({ level: "info", event: "replica.stopping", fields: {} });
    await core?.stop({ workflowCompletionTimeoutMs: 15_000 });
    await prisma.$disconnect();
    emit({ type: "stopped", replicaId });
    process.exit(0);
  };
  shutdown().catch(() => {
    process.exit(1);
  });
});

main().catch((error: unknown) => {
  emit({ type: "fatal", replicaId, error: error instanceof Error ? `${error.name}: ${error.message.slice(0, 300)}` : "unknown" });
  process.exit(1);
});
