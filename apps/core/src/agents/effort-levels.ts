import { controlsAgentEffort } from "@ostra/api";
import type { AgentEffortLevels } from "@ostra/domain";

// Core's agent registry for reasoning effort (F-137, ADR 0066): the levels each agent adapter can
// send for a model. The dispatch, the task spec and a driver's change read this one function, as
// the API's `AgentEffort` port does, so the panel, the spec and a change agree. Until the agent
// adapters declare their own levels (ticket 57's `effortLevels`), it reads them off the model's
// controls; an agent core doesn't know offers `default` alone, so its tasks run at its default.

export const agentEffortLevels: AgentEffortLevels = (adapter, input) => controlsAgentEffort.levelsFor(adapter, input);
