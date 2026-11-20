import { parseServerSettings } from "@ostra/domain";

import type { FleetSettings } from "@/components/runners/pool-sheet";

import webPackage from "../../package.json";

/**
 * What the fleet's pages need from the server's settings (ticket 30): core's address as a runner
 * reaches it, the server's version (the panel and core ship as one release, ADR 0046), and the
 * instance's join token lifetime (`OSTRA_JOIN_TOKEN_DAYS`).
 */
export const fleetSettings = (): FleetSettings => {
  const parsed = parseServerSettings(process.env);
  return {
    serverUrl: parsed.ok ? parsed.settings.corePublicUrl : "http://localhost:8787",
    serverVersion: webPackage.version,
    joinTokenDays: parsed.ok ? parsed.settings.joinTokenDays : 30,
  };
};
