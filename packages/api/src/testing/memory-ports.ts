import { randomUUID } from "node:crypto";

import { jobKey } from "@ostra/domain";
import type { CommandOutbox, EnqueueOptions, JobName, JobPayload, JobQueue, OutboxCommand } from "@ostra/domain";
import { commandIdSchema, commandSeqSchema } from "@ostra/protocol";
import type { CommandBody, CommandKind, CommandId, CommandSeq, OrganizationId, RunnerId } from "@ostra/protocol";

// In-memory versions of the two ports the panel doesn't implement: the job queue (`packages/jobs`,
// ticket 23) and the command outbox (core, ticket 26). They record what a router asked for, with
// the same key rule as the real queue, so a test checks what was enqueued without a worker.

export type RecordedJob = {
  readonly job: JobName;
  readonly key: string;
  readonly payload: unknown;
  readonly options: EnqueueOptions | undefined;
};

export type MemoryJobQueue = JobQueue & {
  readonly jobs: readonly RecordedJob[];
  readonly clear: () => void;
};

/** Sending a job with a key that exists returns the existing one (ADR 0037), as the real queue does. */
export const memoryJobQueue = (): MemoryJobQueue => {
  const jobs: RecordedJob[] = [];
  return {
    jobs,
    clear: () => {
      jobs.length = 0;
    },
    enqueueInTx: <N extends JobName>(_tx: unknown, job: N, payload: JobPayload<N>, options?: EnqueueOptions) => {
      const key = jobKey(job, payload);
      if (!jobs.some((existing) => existing.key === key)) {
        jobs.push({ job, key, payload, options });
      }
      return Promise.resolve();
    },
  };
};

export type RecordedCommand = {
  readonly organizationId: OrganizationId;
  readonly runnerId: RunnerId;
  readonly kind: CommandKind;
  readonly body: CommandBody<CommandKind>;
  readonly seq: CommandSeq;
  readonly commandId: CommandId;
  readonly notAfter: number;
};

export type MemoryOutbox = CommandOutbox & {
  readonly commands: readonly RecordedCommand[];
};

/** Numbers commands per runner from 1, gap-free, like the real outbox. */
export const memoryOutbox = (): MemoryOutbox => {
  const commands: RecordedCommand[] = [];
  const counters = new Map<RunnerId, number>();
  return {
    commands,
    enqueueInTx: <K extends CommandKind>(_tx: unknown, organizationId: OrganizationId, runnerId: RunnerId, command: OutboxCommand<K>) => {
      const next = (counters.get(runnerId) ?? 0) + 1;
      counters.set(runnerId, next);
      const seq = commandSeqSchema.parse(next);
      const commandId = commandIdSchema.parse(randomUUID());
      commands.push({ organizationId, runnerId, kind: command.kind, body: command.body, seq, commandId, notAfter: command.notAfter });
      return Promise.resolve({ commandId, seq });
    },
  };
};
