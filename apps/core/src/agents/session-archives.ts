import { OpenCodeAdapter } from "@ostra/adapter-opencode";
import type { AgentAdapter } from "@ostra/adapter-sdk";

// Core's agent registry for session archives (ADR 0039, milestone 2's ticket 18): whether each
// shipped agent adapter imports one, as the adapter itself declares it (`sessionArchive`, a
// capability of the shared `AgentAdapter`). Every dispatch core makes reads this one function, a
// reopen's and "Start the app"'s alike (F-141, Q300), so a box restores the agent's session wherever
// it starts. An agent no adapter declares imports none: its reopens use the rebuild template.

const shippedAgents: readonly AgentAdapter[] = [new OpenCodeAdapter()];

const importsArchive = new Map(shippedAgents.map((agent) => [agent.name, agent.capabilities.sessionArchive]));

/** Whether the agent adapter by this name imports a session archive. */
export const agentImportsArchives = (adapter: string): boolean => importsArchive.get(adapter) === true;
