import path from "node:path";

import type { ApprovalRequestSubject } from "@ostra/protocol";

// What a permission request touches (ADR 0049), read from ACP's standard tool kinds: the base
// class's default `describePermission`. The runner matches the profile's rules and the task's rules
// against it, and the card shows it. A tool call's input is the agent's (vendor data, may quote the
// repo), so it's read loosely and never logged.

/** The subject's part of a permission request, as the driver reads it from ACP. */
export type PermissionFacts = {
  readonly toolKind?: string;
  readonly rawInput?: unknown;
  readonly locations?: readonly string[];
};

const field = (input: unknown, names: readonly string[]): string | null => {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  for (const name of names) {
    const value: unknown = Reflect.get(input, name);
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
    if (Array.isArray(value) && value.length > 0 && value.every((part): part is string => typeof part === "string")) {
      // A command as an argument list, as some agents send it: joined for the matcher, which splits it again.
      return value.join(" ");
    }
  }
  return null;
};

/**
 * A path as the rules read it: relative to the session's folder when it's inside it, with forward
 * slashes. A path outside the folder stays absolute, so it matches every glob and always asks.
 */
export const pathForRules = (value: string, cwd: string): string => {
  if (!path.isAbsolute(value)) {
    return value.replaceAll("\\", "/");
  }
  const relative = path.relative(cwd, value);
  return relative === "" || relative.startsWith("..") || path.isAbsolute(relative) ? value : relative.replaceAll("\\", "/");
};

/** The subject of a request of ACP's standard kinds; `null` for a kind the rules don't watch (a read, a search). */
export const describeStandardPermission = (facts: PermissionFacts, cwd: string): ApprovalRequestSubject | null => {
  const kind = facts.toolKind ?? "";
  if (kind === "edit" || kind === "delete" || kind === "move") {
    const value = facts.locations?.[0] ?? field(facts.rawInput, ["filePath", "file_path", "path", "target"]);
    return value === null ? null : { tool: "edit", subject: { kind: "path", value: pathForRules(value, cwd) } };
  }
  if (kind === "execute") {
    const command = field(facts.rawInput, ["command", "cmd", "commandLine"]);
    return command === null ? null : { tool: "execute", subject: { kind: "command", value: command } };
  }
  if (kind === "fetch") {
    const url = field(facts.rawInput, ["url", "uri"]);
    return url === null ? null : { tool: "fetch", subject: { kind: "url", value: url } };
  }
  return null;
};
