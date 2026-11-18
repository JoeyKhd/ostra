// A "core" replica, run as a child process. It migrates and supervises pg-boss, runs the schedule
// pass and works the queues its config names. The harness spawns two or three of these over one
// Postgres and kills them with `kill -9`.

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.ts";
import { registerWorkers } from "./handlers.ts";
import { allJobDefinitions } from "./job-defs.ts";
import { createJobs } from "./jobs.ts";
import type { LogEvent } from "./jobs.ts";
import { replicaConfigSchema, replicaInSchema } from "./messages.ts";
import type { ReplicaOut } from "./messages.ts";

const rawConfig: unknown = JSON.parse(process.env["REPLICA_CONFIG"] ?? "null");
const config = replicaConfigSchema.parse(rawConfig);

const emit = (message: ReplicaOut): void => {
  process.send?.(message);
};

const log = (event: LogEvent): void => {
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), replica: config.replicaId, level: event.level, event: event.event, ...event.fields })}\n`,
  );
};

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: config.databaseUrl, max: 10 }),
});

const jobs = createJobs({
  connectionString: config.databaseUrl,
  role: "core",
  instanceName: config.replicaId,
  poolMax: 10,
  monitorIntervalSeconds: config.monitorIntervalSeconds,
  superviseIntervalSeconds: config.superviseIntervalSeconds,
  onLog: log,
});

// If the harness goes away, so does the replica. No orphans.
process.on("disconnect", () => {
  process.exit(1);
});

const main = async (): Promise<void> => {
  await jobs.start();
  await jobs.installQueues(allJobDefinitions);
  if (config.forwardingExpireSeconds !== undefined) {
    await jobs.setForwardingExpiry(config.forwardingExpireSeconds);
  }
  await registerWorkers({ prisma, jobs, config });
  log({ level: "info", event: "replica.ready", fields: { workers: config.workers.length } });
  emit({ type: "ready", replicaId: config.replicaId, pid: process.pid });
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
    await jobs.stop({ graceful: true, timeoutMs: 15_000 });
    await prisma.$disconnect();
    emit({ type: "stopped", replicaId: config.replicaId });
    process.exit(0);
  };
  shutdown().catch(() => {
    process.exit(1);
  });
});

main().catch((error: unknown) => {
  emit({ type: "fatal", replicaId: config.replicaId, error: error instanceof Error ? error.message : "unknown" });
  process.exit(1);
});
