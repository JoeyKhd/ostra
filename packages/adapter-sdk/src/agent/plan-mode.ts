import { commandOutsideAllowlist, mcpServerOfSubject } from "@ostra/protocol";
import type { ApprovalRequestSubject, RuleContext } from "@ostra/protocol";

// What a plan turn may do (ADR 0049, F-063): read, search, a short list of read-only commands,
// and the tools of an MCP server marked read-only. Never an edit, another command, a fetch or a
// tool of a server that isn't read-only. An agent with a native plan mode refuses the rest itself;
// for the others the runner answers every request of a plan turn with this check.

/** The commands a plan turn may run: they read, and change nothing (working values). */
export const PLAN_MODE_READ_ONLY_COMMANDS: readonly string[] = [
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "pwd",
  "find",
  "grep",
  "rg",
  "tree",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "git ls-files",
  "git blame",
];

/** ACP's tool kinds that only read. */
const READING_KINDS: ReadonlySet<string> = new Set(["read", "search", "think"]);

/**
 * Whether a plan turn may go on with a request: its subject as `describePermission` read it, its
 * ACP kind for the requests that have none (a read, a search), and the spec's MCP servers.
 */
export const planModeAllows = (
  request: { readonly subject: ApprovalRequestSubject | null; readonly toolKind?: string | undefined },
  context: RuleContext,
): boolean => {
  const { subject } = request;
  if (subject === null) {
    return request.toolKind !== undefined && READING_KINDS.has(request.toolKind);
  }
  switch (subject.tool) {
    case "edit":
    case "fetch":
      return false;
    case "execute":
      return !commandOutsideAllowlist(subject.subject.value, PLAN_MODE_READ_ONLY_COMMANDS);
    case "mcp": {
      const server = context.mcpServers.find((entry) => entry.name === mcpServerOfSubject(subject.subject.value));
      return server?.readOnly === true;
    }
    default:
      return subject.tool satisfies never;
  }
};
