import { shippedAgentEffort } from "@ostra/api";
import type { AgentEffortLevels } from "@ostra/domain";

// Core's agent registry for reasoning effort (F-137, ADR 0066): the levels each agent adapter can
// send for a model, as the adapter itself declares them (`reasoningEffort` and `effortLevels`). The
// dispatch, the task spec and a driver's change read this one function, as the API's `AgentEffort`
// port does, so the panel, the spec and a change agree. An agent no adapter declares offers
// `default` alone, so its tasks run at its default.

export const agentEffortLevels: AgentEffortLevels = (adapter, input) => shippedAgentEffort.levelsFor(adapter, input);
