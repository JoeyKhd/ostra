import type { RouterOutputs } from "@/lib/trpc";

// The agent profile shapes the screens read, straight from ticket 34's router: nothing typed again.

export type ProfileRow = RouterOutputs["agentProfiles"]["list"][number];
export type ProfileDetail = RouterOutputs["agentProfiles"]["get"];
export type ProfileDefault = ProfileRow["defaults"][number];
export type ProfileAccess = ProfileRow["access"];
