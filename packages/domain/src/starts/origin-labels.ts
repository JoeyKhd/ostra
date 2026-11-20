import type { Tx } from "@ostra/db";

// The labels a task's runner needs (F-067, F-011, F-106; milestone 6's ticket 11): its profile's,
// and the pool labels of the automation that started it. Every queueing of the task (its first
// dispatch, a reopen, a requeue) takes them from here, so an automation's labels reach admission
// each time and a profile's label change applies to the next queueing.

/** The task's profile labels with its automation's pool labels, sorted, each once. */
export const requiredLabelsInTx = async (
  tx: Tx,
  task: { readonly organizationId: string; readonly automationId: string | null },
  profileLabels: readonly string[],
): Promise<readonly string[]> => {
  const automation =
    task.automationId === null
      ? null
      : await tx.automation.findFirst({ where: { id: task.automationId, organizationId: task.organizationId }, select: { poolLabels: true } });
  return [...new Set([...profileLabels, ...(automation?.poolLabels ?? [])])].sort();
};
