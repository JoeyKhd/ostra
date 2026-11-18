import type { Logger } from "@ostra/adapter-sdk";
import { mapTask } from "@ostra/db";
import type { Tx } from "@ostra/db";
import {
  commandIdSchema,
  commandResultSchema,
  commandSeqSchema,
  dispatchBodySchema,
  leaseEpochSchema,
  organizationIdSchema,
  projectIdSchema,
  runnerIdSchema,
} from "@ostra/protocol";
import { z } from "zod";

import type { Ports } from "../ports.ts";
import type { UseCaseResult } from "./common.ts";
import { moveTaskInTx } from "./moves.ts";

// ADR 0034: a runner's answer to a dispatch offer, from its `command-ack`. `accepted` makes the lease
// accepted and the task `preparing`; `rejected` ends the lease and requeues the task. An answer to a
// stale offer (a newer epoch exists, or the offer timed out) changes nothing. Written by ticket 26.

export const acceptOfferInputSchema = z.strictObject({
  runnerId: runnerIdSchema,
  commandId: commandIdSchema,
  seq: commandSeqSchema,
  result: commandResultSchema,
});
export type AcceptOfferInput = z.infer<typeof acceptOfferInputSchema>;

export type AcceptOfferResult = UseCaseResult<
  { readonly outcome: "accepted" | "requeued" },
  "unknown-command" | "not-a-dispatch" | "stale"
>;

export type AcceptOfferDeps = Pick<Ports, "jobs" | "notices" | "clock"> & { readonly tx: Tx; readonly logger?: Logger };

export type AcceptOffer = (deps: AcceptOfferDeps, input: AcceptOfferInput) => Promise<AcceptOfferResult>;

export const acceptOffer: AcceptOffer = async (deps, input) => {
  const { tx } = deps;
  const command = await tx.command.findFirst({ where: { id: input.commandId, runnerId: input.runnerId, seq: input.seq } });
  if (command === null) {
    return { ok: false, error: "unknown-command", message: "no such command for this runner" };
  }
  if (command.kind !== "dispatch") {
    return { ok: false, error: "not-a-dispatch", message: "the command is not an offer" };
  }
  const body = dispatchBodySchema.safeParse(command.body);
  if (!body.success) {
    return { ok: false, error: "not-a-dispatch", message: "the offer's body doesn't parse" };
  }
  const offer = body.data;
  await tx.$queryRaw`SELECT 1 FROM "task" WHERE "id" = ${offer.taskId} AND "organizationId" = ${command.organizationId} FOR UPDATE`;
  const row = await tx.task.findFirst({ where: { id: offer.taskId, organizationId: command.organizationId } });
  const lease = await tx.lease.findFirst({
    where: { taskId: offer.taskId, epoch: offer.leaseEpoch, runnerId: input.runnerId, state: "active" },
  });
  if (row === null || lease === null || row.leaseEpoch !== offer.leaseEpoch) {
    return { ok: false, error: "stale", message: "the offer was withdrawn or replaced" };
  }
  const task = mapTask(row);
  const moveDeps = { tx, notices: deps.notices, ...(deps.logger === undefined ? {} : { logger: deps.logger }) };
  switch (input.result) {
    case "accepted": {
      if (lease.acceptedAt !== null) {
        return { ok: true, outcome: "accepted" };
      }
      await tx.lease.update({ where: { id: lease.id }, data: { acceptedAt: new Date(deps.clock.now()) } });
      await moveTaskInTx(moveDeps, task, { type: "runner_accepted" });
      return { ok: true, outcome: "accepted" };
    }
    case "rejected": {
      // The lease ends and the task goes back to the queue, for the next epoch's dispatch.
      await tx.lease.update({ where: { id: lease.id }, data: { state: "ended", endedAt: new Date(deps.clock.now()), endReason: "rejected" } });
      await tx.box.updateMany({ where: { id: lease.boxId, state: "creating" }, data: { state: "failed", failedReason: "the runner declined the offer" } });
      await tx.task.update({ where: { id: task.id }, data: { dispatchNote: "The runner declined the offer; looking for another." } });
      await deps.jobs.enqueueInTx(tx, "task.dispatch", {
        organizationId: organizationIdSchema.parse(task.organizationId),
        taskId: task.id,
        sessionId: offer.sessionId,
        leaseEpoch: leaseEpochSchema.parse(offer.leaseEpoch + 1),
      });
      await deps.notices.emitInTx(tx, {
        organizationId: organizationIdSchema.parse(task.organizationId),
        projectId: projectIdSchema.parse(task.projectId),
        entity: "task",
        entityId: task.id,
      });
      return { ok: true, outcome: "requeued" };
    }
    case "done":
    case "outcome-unknown":
      return { ok: false, error: "stale", message: "an offer is only accepted or rejected" };
    default:
      return input.result satisfies never;
  }
};
