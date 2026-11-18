// Applies a solution's steps to a workspace by plain file edits, with no agent
// involved. The oracle uses it to prove a reference solution is right.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Step } from "./schema.ts";

/** Replaces `oldString` with `newString` once. Throws when the text isn't there exactly once, as OpenCode's edit tool does. */
export const replaceOnce = (text: string, oldString: string, newString: string): string => {
  const parts = text.split(oldString);
  if (parts.length !== 2) throw new Error(`the text to replace occurs ${String(parts.length - 1)} times, expected 1`);
  return parts.join(newString);
};

export const applySteps = async (workspace: string, steps: readonly Step[]): Promise<void> => {
  for (const step of steps) {
    // A step outside the workspace is an escape attempt: the oracle judges what a result holds, and never carries one out.
    if ((step.tool === "edit" || step.tool === "write") && path.isAbsolute(step.path)) continue;
    switch (step.tool) {
      case "read":
      case "shell":
      case "question":
        break;
      case "edit": {
        const file = path.join(workspace, step.path);
        await writeFile(file, replaceOnce(await readFile(file, "utf8"), step.oldString, step.newString));
        break;
      }
      case "write": {
        const file = path.join(workspace, step.path);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, step.content);
        break;
      }
      default:
        step satisfies never;
    }
  }
};
