import { renderReposForAgent } from "@ostra/domain";
import type { AgentRepo } from "@ostra/domain";

/** `taskSpecSchema`'s limit on `agent.instructions`. */
const INSTRUCTIONS_MAX = 65_536;

/**
 * The instructions the task spec hands the agent (F-025, F-065, F-098, F-110).
 *
 * The workspace holds one folder per repo. With one repo the runner starts the agent inside it, and
 * nothing is added. With several, the agent starts at the workspace root, so the instructions name
 * each repo's folder, its base branch and the task's branch (the domain's `renderReposForAgent`): a
 * file written at the root is outside every repo, and its work is lost. The profile's own
 * instructions follow. For a runner below minor 3, which has no `memory` section, the memory block
 * comes last (ticket 15). The profile's own text is what's cut when the whole doesn't fit.
 */
export const agentInstructions = (
  profileInstructions: string | null,
  repos: readonly AgentRepo[],
  branchName: string,
  memoryBlock: string | null = null,
): string | null => {
  const note = renderReposForAgent(repos, branchName);
  if (note === null && memoryBlock === null) {
    return profileInstructions;
  }
  const own = profileInstructions?.trim() ?? "";
  const head = note ?? "";
  const tail = memoryBlock ?? "";
  const room = Math.max(0, INSTRUCTIONS_MAX - head.length - tail.length - 4);
  const parts = [head, own.slice(0, room), tail].filter((part) => part !== "");
  return parts.join("\n\n").slice(0, INSTRUCTIONS_MAX);
};
