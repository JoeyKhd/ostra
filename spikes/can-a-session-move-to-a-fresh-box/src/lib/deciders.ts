// Answers for a driver with no member behind it.
//
//   withinWorkspace  approves a tool call only when everything it names lies
//                    inside the task's workspace; rejects it otherwise
//   rejectOnce       rejects every tool call (the question turns: answer from memory)
//   allowOnce        approves every tool call (kept for spike 1's copy; unused here)
//
// AGENTS.md: an agent's reach ends at its task's workspace. OpenCode's own
// `external_directory: deny` rule covers its file tools (spike 1 checked
// this), but not the shell tool. So the decider also reads a shell command
// and rejects one that names a path outside the workspace, the home dir or a
// parent dir. That is a guard against a mistake, not a boundary: a command can
// reach outside without naming a path. The boundary is the box (a container,
// spike 3).

import path from "node:path";
import type { ElicitationResponder, PermissionDecider } from "./acp-driver.ts";

type Request = Parameters<PermissionDecider>[0];
type Response = Awaited<ReturnType<PermissionDecider>>;

const choose = (request: Request, kind: "allow_once" | "reject_once"): Response => {
  const option = request.options.find((o) => o.kind === kind);
  return option === undefined ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId: option.optionId } };
};

export const allowOnce: PermissionDecider = (request) => Promise.resolve(choose(request, "allow_once"));

export const rejectOnce: PermissionDecider = (request) => Promise.resolve(choose(request, "reject_once"));

export const declineQuestions: ElicitationResponder = () => Promise.resolve({ action: "decline" });

export type WorkspaceScope = {
  /** The workspace as the agent sees it: a host path, or a container path. */
  readonly workspace: string;
  /** Paths are POSIX (a container), not the host's own kind. */
  readonly posix: boolean;
};

/** Keys of a tool's raw input that name a path. */
const PATH_KEYS = new Set(["path", "filePath", "file_path", "file", "directory", "dir", "cwd", "workdir", "target", "destination", "source"]);

const pathsInRawInput = (raw: unknown): string[] => {
  if (typeof raw !== "object" || raw === null) return [];
  const found: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (PATH_KEYS.has(key) && typeof value === "string" && value !== "") found.push(value);
    if (key === "paths" && Array.isArray(value)) for (const item of value) if (typeof item === "string") found.push(item);
  }
  return found;
};

const commandOf = (raw: unknown): string | undefined => {
  if (typeof raw !== "object" || raw === null || !("command" in raw)) return undefined;
  return typeof raw.command === "string" ? raw.command : undefined;
};

/** Whether `candidate`, resolved against the workspace, lies inside it. */
export const insideWorkspace = (scope: WorkspaceScope, candidate: string): boolean => {
  // A drive path means nothing in a container: never inside.
  if (scope.posix && /^[A-Za-z]:[\\/]/.test(candidate)) return false;
  const p = scope.posix ? path.posix : path;
  const resolved = p.resolve(scope.workspace, candidate);
  const root = p.resolve(scope.workspace);
  const fold = (s: string): string => (scope.posix || process.platform !== "win32" ? s : s.toLowerCase());
  return fold(resolved) === fold(root) || fold(resolved).startsWith(fold(root.endsWith(p.sep) ? root : `${root}${p.sep}`));
};

/** Absolute paths, a home dir or a parent dir named in a shell command. */
const SHELL_ESCAPES: readonly RegExp[] = [
  /(?:^|[\s"'=(:])([A-Za-z]:[\\/][^\s"'`;|&<>)]*)/g,
  /(?:^|[\s"'=(])(\/[^\s"'`;|&<>)]*)/g,
];
const SHELL_ALWAYS_OUTSIDE = /(?:^|[\s"'=(/\\])\.\.(?:[/\\\s"')]|$)|(?:^|[\s"'=(])~|\$HOME\b|\$\{HOME\}|%USERPROFILE%|%APPDATA%|%LOCALAPPDATA%|\$env:/i;
const HARMLESS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

/** Why a shell command is refused, or undefined when it names nothing outside the workspace. */
export const shellReach = (scope: WorkspaceScope, command: string): string | undefined => {
  if (SHELL_ALWAYS_OUTSIDE.test(command)) return "names a parent or home directory";
  for (const pattern of SHELL_ESCAPES) {
    for (const match of command.matchAll(pattern)) {
      const candidate = match[1];
      if (candidate === undefined || HARMLESS.has(candidate)) continue;
      if (!insideWorkspace(scope, candidate)) return "names a path outside the workspace";
    }
  }
  return undefined;
};

export type ScopeTally = { allowed: number; rejected: number; readonly rejectedKinds: Record<string, number> };

export const newScopeTally = (): ScopeTally => ({ allowed: 0, rejected: 0, rejectedKinds: {} });

/** Approves a tool call only when every path it names is inside the workspace. */
export const withinWorkspace = (scope: WorkspaceScope, tally?: ScopeTally): PermissionDecider => (request) => {
  const call = request.toolCall;
  const kind = call.kind ?? "other";
  const paths = [...(call.locations ?? []).map((l) => l.path), ...pathsInRawInput(call.rawInput)];
  const command = commandOf(call.rawInput);
  const outside =
    kind === "fetch"
      ? "fetches from the network"
      : paths.some((p) => !insideWorkspace(scope, p))
        ? "a path outside the workspace"
        : command === undefined
          ? undefined
          : shellReach(scope, command);
  if (tally !== undefined) {
    if (outside === undefined) tally.allowed += 1;
    else {
      tally.rejected += 1;
      tally.rejectedKinds[kind] = (tally.rejectedKinds[kind] ?? 0) + 1;
    }
  }
  return Promise.resolve(choose(request, outside === undefined ? "allow_once" : "reject_once"));
};
