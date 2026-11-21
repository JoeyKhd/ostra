import { OpenCodeAdapter } from "@ostra/adapter-opencode";
import type { AgentAdapter } from "@ostra/adapter-sdk";
import { messageFileLimits } from "@ostra/domain";
import type { FileSettings, MessageFilesDeps } from "@ostra/domain";

// Core's agent registry for images in a prompt (F-148, ADR 0070, Q332): whether each shipped agent
// adapter takes images in its prompt, as the adapter itself declares it (`promptImages`, a
// capability of the shared `AgentAdapter`). A member's message that core sends (a Linear
// follow-up, ticket 12's files) decides its images with it, as the API's sends do: an agent no
// adapter declares takes none, and its images go as files only, with the thread saying why.

const shippedAgents: readonly AgentAdapter[] = [new OpenCodeAdapter()];

const takesImages = new Map(shippedAgents.map((agent) => [agent.name, agent.capabilities.promptImages]));

/** Whether the agent adapter by this name takes images in its prompt. */
export const agentTakesImages = (adapter: string): boolean => takesImages.get(adapter) === true;

/** What core's member messages bind their files with: the settings' limits, and the agents above. */
export const coreMessageFilesDeps = (files: FileSettings): MessageFilesDeps => ({ limits: messageFileLimits(files), agentTakesImages });
