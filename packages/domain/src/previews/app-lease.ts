import type { Tx } from "@ostra/db";
import { organizationIdSchema, projectIdSchema, taskIdSchema } from "@ostra/protocol";

import type { Ports } from "../ports.ts";
import { moveSessionInTx } from "../use-cases/moves.ts";

// An `app` lease that never got its box (milestone 8, Q300, ticket 19): the runner declined the
// offer or never answered it. The lease ends, the box that was never made fails, and the session
// "Start the app" made for it stops, with no requeue: the task's own state never moved, and the
// member presses "Start the app" again. A lease a member's message already turned into a turn
// goes the way any turn's offer goes instead.

export const endAppLeaseInTx = async (
  deps: Pick<Ports, "notices" | "clock">,
  tx: Tx,
  lease: { readonly id: string; readonly boxId: string; readonly taskId: string; readonly organizationId: string; readonly projectId: string },
  reason: "rejected" | "offer-timeout",
): Promise<void> => {
  const at = new Date(deps.clock.now());
  await tx.lease.update({ where: { id: lease.id }, data: { state: "ended", endedAt: at, endReason: reason } });
  await tx.box.updateMany({
    where: { id: lease.boxId, state: "creating" },
    data: { state: "failed", failedReason: reason === "rejected" ? "the runner declined the offer" : "the runner didn't answer the offer" },
  });
  const sessions = await tx.session.findMany({ where: { taskId: lease.taskId, boxId: lease.boxId, state: "starting" }, select: { id: true, taskId: true, state: true, outcome: true } });
  for (const session of sessions) {
    await moveSessionInTx({ tx, notices: deps.notices }, session, { type: "stop" });
  }
  await deps.notices.emitInTx(tx, {
    organizationId: organizationIdSchema.parse(lease.organizationId),
    projectId: projectIdSchema.parse(lease.projectId),
    entity: "task",
    entityId: taskIdSchema.parse(lease.taskId),
  });
};
