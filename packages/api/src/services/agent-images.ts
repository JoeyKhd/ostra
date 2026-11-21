import { OPENCODE_PROMPT_IMAGES } from "@ostra/adapter-opencode/prompt-images";
import { messageFileLimits } from "@ostra/domain";
import type { FileSettings, MessageFilesDeps } from "@ostra/domain";

// The panel's message files (F-148, ADR 0070, Q332, ticket 14): the limits a message's files keep
// to (`OSTRA_MESSAGE_FILES_*`), and whether each shipped agent takes images in its prompt, as its
// adapter declares it (`promptImages`, read without the adapter's process code). A send decides
// its images with these, as core's own sends do (`coreMessageFilesDeps`): an agent no adapter
// declares takes none, and its images go as files only, the thread saying why.

/** Each shipped agent adapter's `promptImages`, by its registered name. */
const shippedPromptImages: ReadonlyMap<string, boolean> = new Map([["opencode", OPENCODE_PROMPT_IMAGES]]);

/** Whether the agent adapter by this name takes images in its prompt. */
export const shippedAgentTakesImages = (adapter: string): boolean => shippedPromptImages.get(adapter) === true;

/** What the panel's sends bind their files with: the settings' limits, and the agents above. */
export const panelMessageFilesDeps = (files: FileSettings, agentTakesImages: (adapter: string) => boolean = shippedAgentTakesImages): MessageFilesDeps => ({
  limits: messageFileLimits(files),
  agentTakesImages,
});
