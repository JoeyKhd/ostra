import { commandKindToDb, notifyChannels, NOTIFY_PAYLOAD_MAX_BYTES } from "@ostra/db";
import type { Tx } from "@ostra/db";
import { boxIdSchema, commandBodySchemas, commandIdSchema, commandSeqSchema, runnerIdSchema, stopBodySchema } from "@ostra/protocol";
import type { BoxId, CommandKind, OrganizationId, RunnerId } from "@ostra/protocol";
import { z } from "zod";

import type { CommandOutbox, OutboxCommand } from "./ports.ts";

// The command outbox in Postgres (ADR 0034), shared by the panel (Stop, ticket 33) and core (the
// dispatcher, the grace): a command is a row written in the caller's transaction, numbered per
// runner under the runner row's lock, so numbers are gap-free and in commit order, with one
// `NOTIFY` that commits with it. The gateway that holds the runner's connection sends it, and a
// sweep catches a missed notification. Ported from spikes/runner-transport/src/server/schema.ts
// (`enqueue_command`).

const positive = z.number().int().positive();

/**
 * What goes on the `ostra_runner` channel: IDs only, never a command's body.
 * - `command`: a command for the runner committed.
 * - `connected`: a new connection of the runner, with its epoch: every other replica closes an
 *   older one with `4409`.
 * - `revoked`: the runner was revoked: the replica holding it sends `evict` and closes with `4403`.
 * - `sidecar-command`: a command for a box's sidecar committed (ADR 0034, Q129).
 * - `sidecar-connected`: a new connection of a box's sidecar: every other replica closes an older
 *   one with `4409`.
 */
export const runnerNotificationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("command"), runnerId: runnerIdSchema }),
  z.strictObject({ kind: z.literal("connected"), runnerId: runnerIdSchema, connectionEpoch: positive }),
  z.strictObject({ kind: z.literal("revoked"), runnerId: runnerIdSchema }),
  z.strictObject({ kind: z.literal("sidecar-command"), boxId: boxIdSchema }),
  z.strictObject({ kind: z.literal("sidecar-connected"), boxId: boxIdSchema, connectionEpoch: positive }),
]);
export type RunnerNotification = z.infer<typeof runnerNotificationSchema>;

/** Sends a runner notification that commits with the caller's transaction. */
export const notifyRunnerInTx = async (tx: Tx, notification: RunnerNotification): Promise<void> => {
  const payload = JSON.stringify(runnerNotificationSchema.parse(notification));
  if (payload.length > NOTIFY_PAYLOAD_MAX_BYTES) {
    throw new Error("a runner notification is over the NOTIFY limit");
  }
  await tx.$executeRaw`SELECT pg_notify(${notifyChannels.runner}, ${payload})`;
};

const counterRowSchema = z.strictObject({ commandSeq: commandSeqSchema });
const sidecarCounterRowSchema = z.strictObject({ sidecarCommandSeq: commandSeqSchema });

/** The kinds a `docker` or `kubernetes` box's sidecar takes for its task, instead of the runner (Q129): the driver's answers too. */
const sidecarKinds: ReadonlySet<CommandKind> = new Set<CommandKind>(["steer", "interrupt", "stop", "approval-answer", "question-answer", "plan-answer"]);

/**
 * The box whose sidecar takes this command, or `null` when the runner does: the task's lease on
 * this runner (the stop's own epoch for a stop, else the newest), when its box is on `docker` or
 * `kubernetes`. On `host` the runner is the sidecar.
 */
const sidecarBoxOf = async <K extends CommandKind>(
  tx: Tx,
  organizationId: OrganizationId,
  runnerId: RunnerId,
  command: OutboxCommand<K>,
): Promise<{ readonly boxId: BoxId; readonly taskId: string; readonly projectId: string } | null> => {
  if (command.task === null || !sidecarKinds.has(command.kind)) {
    return null;
  }
  const stop = command.kind === "stop" ? stopBodySchema.safeParse(command.body) : undefined;
  const lease = await tx.lease.findFirst({
    where: {
      taskId: command.task.taskId,
      organizationId,
      runnerId,
      ...(stop?.success === true ? { epoch: stop.data.leaseEpoch } : {}),
    },
    orderBy: { epoch: "desc" },
    select: { boxId: true, taskId: true, projectId: true, box: { select: { executor: true } } },
  });
  if (lease === null || lease.box.executor === "host") {
    return null;
  }
  return { boxId: boxIdSchema.parse(lease.boxId), taskId: lease.taskId, projectId: lease.projectId };
};
const jsonObjectSchema = z.record(z.string(), z.json());

export const postgresCommandOutbox: CommandOutbox = {
  enqueueInTx: async <K extends CommandKind>(
    tx: Tx,
    organizationId: OrganizationId,
    runnerId: RunnerId,
    command: OutboxCommand<K>,
  ) => {
    // Validated against its kind here, so a bad body never reaches a runner.
    const body: unknown = commandBodySchemas[command.kind].parse(command.body);
    const box = await sidecarBoxOf(tx, organizationId, runnerId, command);
    if (box !== null) {
      // The box's own counter, under its row's lock: the sidecar's commands are gap-free too.
      const boxCounters = await tx.$queryRaw<readonly unknown[]>`
        UPDATE "box" SET "sidecarCommandSeq" = "sidecarCommandSeq" + 1, "updatedAt" = now()
        WHERE "id" = ${box.boxId} AND "organizationId" = ${organizationId}
        RETURNING "sidecarCommandSeq"`;
      const boxCounter = sidecarCounterRowSchema.parse(boxCounters[0]);
      const sidecarRow = await tx.sidecarCommand.create({
        data: {
          organizationId,
          projectId: box.projectId,
          taskId: box.taskId,
          boxId: box.boxId,
          seq: boxCounter.sidecarCommandSeq,
          kind: commandKindToDb[command.kind],
          body: jsonObjectSchema.parse(body),
          notAfter: new Date(command.notAfter),
        },
        select: { id: true },
      });
      await notifyRunnerInTx(tx, { kind: "sidecar-command", boxId: box.boxId });
      return { commandId: commandIdSchema.parse(sidecarRow.id), seq: boxCounter.sidecarCommandSeq };
    }
    // The runner's counter, under its row's lock, scoped by organization: another organization's
    // runner is no runner at all.
    const counters = await tx.$queryRaw<readonly unknown[]>`
      UPDATE "runner" SET "commandSeq" = "commandSeq" + 1, "updatedAt" = now()
      WHERE "id" = ${runnerId} AND "organizationId" = ${organizationId}
      RETURNING "commandSeq"`;
    const counter = counterRowSchema.safeParse(counters[0]);
    if (!counter.success) {
      throw new Error("the outbox has no such runner in this organization");
    }
    const row = await tx.command.create({
      data: {
        organizationId,
        runnerId,
        seq: counter.data.commandSeq,
        kind: commandKindToDb[command.kind],
        body: jsonObjectSchema.parse(body),
        projectId: command.task?.projectId ?? null,
        taskId: command.task?.taskId ?? null,
        notAfter: new Date(command.notAfter),
      },
      select: { id: true },
    });
    await notifyRunnerInTx(tx, { kind: "command", runnerId });
    return { commandId: commandIdSchema.parse(row.id), seq: counter.data.commandSeq };
  },
};
