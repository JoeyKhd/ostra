// The DBOS replica's config. ostra owns this format, so the schema rejects unknown fields. The IPC
// messages a DBOS replica exchanges with the harness are the pg-boss replica's own (messages.ts).

import { z } from "zod";
import { replicaIdSchema } from "../ids.ts";

export const dbosWorkerNameSchema = z.enum(["scheduleFire", "group"]);
export type DbosWorkerName = z.infer<typeof dbosWorkerNameSchema>;

export const dbosReplicaConfigSchema = z.strictObject({
  replicaId: replicaIdSchema,
  /** DBOS's executor ID: stable per slot unless the scenario says otherwise (see d4-schedules.ts). */
  executorId: z.string().min(1),
  databaseUrl: z.string().min(1),
  workers: z.array(dbosWorkerNameSchema),
  /** The group queue's limit per key, and how many of its workflows one process runs. */
  partitionConcurrency: z.number().int().min(1),
  workerConcurrency: z.number().int().min(1),
  pollingIntervalMs: z.number().int().min(100),
});
export type DbosReplicaConfig = z.output<typeof dbosReplicaConfigSchema>;
export type DbosReplicaConfigInput = z.input<typeof dbosReplicaConfigSchema>;
