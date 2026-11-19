import type { Tx } from "@ostra/db";
import type { OrganizationId, ProviderId } from "@ostra/protocol";

// F-088, F-089: a model provider that answered a task's call with a rate limit holds new
// dispatches until the time it asked for. `dispatchTask` reads the hold; `ingestEvents` sets it
// from the runner's `provider.rate_limited` event.

/**
 * Holds new dispatches on a provider until `until`. A later hold only extends an earlier one, and
 * only a provider of this organization is touched.
 */
export const holdProviderInTx = async (tx: Tx, organizationId: OrganizationId, providerId: ProviderId, until: Date): Promise<void> => {
  await tx.modelProvider.updateMany({
    where: { id: providerId, organizationId, OR: [{ dispatchHeldUntil: null }, { dispatchHeldUntil: { lt: until } }] },
    data: { dispatchHeldUntil: until },
  });
};
