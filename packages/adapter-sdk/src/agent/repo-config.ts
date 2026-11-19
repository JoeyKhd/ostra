import { access, rename } from "node:fs/promises";
import path from "node:path";

import { normalizeRulePath } from "@ostra/protocol";

import { adapterError, ok } from "../common/result.ts";
import type { AdapterResult } from "../common/result.ts";

// Hiding a repo's own agent config (ADR 0049, Q171). A repo is untrusted input: its agent config
// could allow everything, or add an MCP server that leaks the workspace. An agent that can't make
// the profile's settings win (`projectConfigOverride: false`) gets the files its adapter names in
// `repoConfigPaths` moved aside for the task, and put back before the commit, so they never show
// in the diff as deleted.

/** The suffix a hidden file carries while the task runs. */
export const HIDDEN_CONFIG_SUFFIX = ".ostra-hidden";

/** What was hidden, to put back. */
export type HiddenRepoConfig = {
  /** The absolute paths moved aside, as they were. */
  readonly hidden: readonly string[];
  /** Moves every hidden file back. Idempotent. */
  readonly restore: () => Promise<AdapterResult<void>>;
};

const exists = async (file: string): Promise<boolean> => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};

/**
 * Moves each of `configPaths` found in each repo's checkout aside, as `<path>.ostra-hidden`. A path
 * that leaves the checkout is refused: an adapter names files inside a repo only.
 */
export const hideRepoAgentConfig = async (
  repoDirs: readonly string[],
  configPaths: readonly string[],
): Promise<AdapterResult<HiddenRepoConfig>> => {
  const relative: string[] = [];
  for (const configPath of configPaths) {
    const normalized = normalizeRulePath(configPath);
    if (normalized === null) {
      return adapterError("invalid-input", "an agent's repo config path leaves the repo");
    }
    relative.push(normalized);
  }
  const hidden: string[] = [];
  for (const repoDir of repoDirs) {
    for (const file of relative) {
      const target = path.join(repoDir, ...file.split("/"));
      if (await exists(target)) {
        await rename(target, `${target}${HIDDEN_CONFIG_SUFFIX}`);
        hidden.push(target);
      }
    }
  }
  const restore = async (): Promise<AdapterResult<void>> => {
    for (const target of hidden) {
      const aside = `${target}${HIDDEN_CONFIG_SUFFIX}`;
      if (await exists(aside)) {
        if (await exists(target)) {
          // The agent wrote a file of the same name: the repo's own comes back, the agent's is the change.
          return adapterError("conflict", "the agent wrote its own config where the repo's was hidden");
        }
        await rename(aside, target);
      }
    }
    return ok(undefined);
  };
  return ok({ hidden, restore });
};
