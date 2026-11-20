import type { SecretStoreAdapter } from "@ostra/adapter-sdk";
import type { Db } from "@ostra/db";
import { checkRegistry } from "@ostra/domain";
import type { ChangeNotices, Clock, RegistryProbe } from "@ostra/domain";
import type { JobHandler } from "@ostra/jobs";

// `registry.check` (F-120, ticket 17): after an admin sets the registry, core checks it with its own
// calls (`probe.ts`) and keeps the result with its time, for the panel. A newer setting enqueues a
// newer check (the job's key holds the settings' version), so an old one that runs late only
// writes what it found for the row as it is now.

export type RegistryCheckDeps = {
  readonly db: Db;
  readonly notices: ChangeNotices;
  readonly clock: Clock;
  readonly secretStore: SecretStoreAdapter;
  readonly probe: RegistryProbe;
};

export const registryCheckHandler =
  (deps: RegistryCheckDeps): JobHandler<"registry.check"> =>
  async (context) => {
    const { organizationId, registryId } = context.payload;
    const result = await checkRegistry(
      { db: deps.db, notices: deps.notices, clock: deps.clock, adapters: { secretStore: deps.secretStore }, probe: deps.probe },
      { organizationId, registryId },
    );
    context.logger.info("registry.checked", { registryId, outcome: result.ok ? result.result.result : result.error, ...(result.ok && result.result.status !== null ? { status: result.result.status } : {}) });
  };
