import { rm } from "node:fs/promises";
import path from "node:path";

// What an agent leaves outside the task's folder on `host`, removed when the box is released
// (ticket 23). OpenCode keeps large tool outputs in `<system temp>/opencode/tool-outputs/<id>`,
// whatever the launch's TEMP says (Q134's interim answer, milestone 1's demo gap). Which ID names the
// folder isn't settled by Q134's research, so both the task's and the agent's own session's go.

/** A folder name that can only be one segment, never `..`. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/** The folders `removeAgentLeftovers` removes, for these IDs: only names that are one plain segment. */
export const agentLeftoverPaths = (tempDir: string, ids: readonly (string | null | undefined)[]): readonly string[] => {
  const root = path.join(tempDir, "opencode", "tool-outputs");
  const names = new Set(ids.filter((id): id is string => typeof id === "string" && SAFE_SEGMENT.test(id) && !id.includes("..")));
  return [...names].map((name) => path.join(root, name));
};

/** Removes the task's agent leftovers in the system temp folder. Never throws. Answers how many paths it tried. */
export const removeAgentLeftovers = async (tempDir: string, ids: readonly (string | null | undefined)[]): Promise<number> => {
  const paths = agentLeftoverPaths(tempDir, ids);
  await Promise.all(paths.map((target) => rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)));
  return paths.length;
};
