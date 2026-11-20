import { PLAN_MODE_READ_ONLY_COMMANDS } from "@ostra/adapter-sdk";
import type { LaunchMcpServer } from "@ostra/adapter-sdk";
import { commandOutsideAllowlist, parseCommandLine, PROPOSE_ENVIRONMENT_TOOL, SUBMIT_DRAFT_TOOL, SUBMIT_REVIEW_TOOL } from "@ostra/protocol";
import type { ApprovalRule, OstraToolSet, TaskKind, TurnMode } from "@ostra/protocol";

// The profile's approval rules as OpenCode's own permissions (ADR 0049, ADR 0031, F-026), for
// OpenCode 2.3.2's V2 config: an ordered list of `{ action, resource, effect }` where the last rule
// that matches wins. Each was checked against the pinned binary (the adapter's README):
//
// - `edit` covers the `edit`, `write` and `patch` tools, and its resource is the path relative to
//   the workspace. `*` in a resource matches any characters, `/` included.
// - `shell` is checked for each simple command of a line on its own: `node *` allowed doesn't
//   allow `node x && echo hi`. Its resource is the command's text.
// - `webfetch` has the URL as its resource. An MCP tool's action is `<server>_<tool>`.
//
// The rules only ever say "ask": the runner checks every request it gets against the same rules
// with the protocol's matcher, so an `ask` here that covers more than the rule (an over-ask) costs
// one round trip and no person, while one that covers less would let a request through that a
// person should see. Every translation below is therefore a superset of its rule.
//
// Task rules ("for this task") are not written here as `allow`: the runner answers them itself
// and records `approval.auto_answered` (milestone 3's spec, section 4), which it can only do for a
// request that reaches it. A task rule only answers what a profile rule asks about, which reaches
// the runner already, so it adds no ask of its own.
//
// `external_directory` is denied last, after every ask and allow, so nothing a rule adds reaches
// outside the workspace.

/** One of OpenCode's permission rules. */
export type OpenCodePermission = {
  readonly action: string;
  readonly resource: string;
  readonly effect: "allow" | "ask" | "deny";
};

/** The base every task starts from: the agent works freely in its workspace, and never outside it. */
export const permissionRules: readonly [allowAll: OpenCodePermission, denyOutside: OpenCodePermission] = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "deny" },
];

/** ostra's own MCP server for the task (the PR's title and body): never a profile server, never under a rule. */
export const OSTRA_MCP_SERVER = "ostra";

/** OpenCode's wildcard characters, which a literal resource can't hold. */
const WILDCARDS = /[*?[\]]/g;
const HAS_WILDCARD = /[*?[\]]/;

/**
 * An ostra path glob as an OpenCode resource that matches at least what the glob does. OpenCode's
 * `*` crosses `/`, so `*` and `**` both become `*`, and `**\/` becomes `*` too (it may match no
 * folder at all). A bracket, which ostra reads literally, becomes `?`.
 */
export const globToResource = (glob: string): string => {
  const slashed = glob.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  return slashed
    .replaceAll("**/", "*")
    .replaceAll("**", "*")
    .replaceAll(/[[\]]/g, "?")
    .replaceAll(/\*+/g, "*");
};

/**
 * A command prefix as a shell resource that matches every simple command the matcher says starts
 * with it, however it's spelled: its words in order with anything between and around them, so a
 * program's path, an assignment before it, extra spaces and quotes all still ask.
 */
export const prefixToResource = (prefix: string): string | null => {
  const words = parseCommandLine(prefix).segments[0] ?? [];
  if (words.length === 0) {
    return null;
  }
  return `*${words.map((word) => word.replaceAll(WILDCARDS, "*")).join("*")}*`;
};

/**
 * What a shell line can hide from a pattern: a substitution, a backtick, a process substitution,
 * an escape or a quote inside a word. Asked about whenever a rule watches commands, after the
 * allowlist's allows, so the runner's matcher reads the line itself.
 */
const UNREADABLE_SHELL: readonly string[] = ["*$(*", "*`*", "*<(*", "*>(*", "*\\*", '*"*', "*'*"];

/** The literal command an allowlist entry allows: the words alone, and the words with arguments. */
const allowsFor = (prefix: string): readonly string[] => {
  const words = parseCommandLine(prefix).segments[0] ?? [];
  if (words.length === 0 || words.some((word) => HAS_WILDCARD.test(word) || word.includes(" "))) {
    return [];
  }
  const line = words.join(" ");
  return [line, `${line} *`];
};

/** The MCP servers a rule covers: every profile server for `any`, the ones not read-only for `mcp-not-read-only`. */
const serversFor = (rule: ApprovalRule, servers: readonly LaunchMcpServer[]): readonly string[] => {
  switch (rule.match.kind) {
    case "any":
      return servers.map((server) => server.name);
    case "mcp-not-read-only":
      return servers.filter((server) => !server.readOnly).map((server) => server.name);
    case "path-glob":
    case "command-prefix":
    case "command-outside":
      return [];
    default:
      return rule.match satisfies never;
  }
};

export type PermissionInput = {
  readonly approvalRules: readonly ApprovalRule[];
  readonly mcpServers: readonly LaunchMcpServer[];
  /** Milestone 6: the task's kind. Absent: `code`. */
  readonly kind?: TaskKind;
  /** Milestone 6: a refine profile that allows prototyping inside the box. Absent: `false`. */
  readonly allowPrototyping?: boolean;
  /** Milestone 6: the tool sets of ostra's MCP server for the task. Absent: no filter, as before milestone 6. */
  readonly tools?: readonly OstraToolSet[];
};

/**
 * Milestone 6 (ADR 0028): whether a task's agent may edit files. A review task's never does; a
 * refine task's only when its profile allows prototyping (the built-in Refine profile doesn't); a
 * code task's always. The shell stays allowed for every kind: the box contains it (ADR 0031), and
 * a read-only kind's git proxy takes no push.
 */
export const editsAllowed = (kind: TaskKind, allowPrototyping: boolean): boolean => {
  switch (kind) {
    case "code":
      return true;
    case "refine":
      return allowPrototyping;
    case "review":
      return false;
    default:
      return kind satisfies never;
  }
};

/** Milestone 6's tools of ostra's server, each with the tool set that serves it (protocol minor 5). */
export const teamTools: readonly { readonly set: OstraToolSet; readonly tool: string }[] = [
  { set: "draft", tool: SUBMIT_DRAFT_TOOL },
  { set: "review", tool: SUBMIT_REVIEW_TOOL },
  { set: "environment", tool: PROPOSE_ENVIRONMENT_TOOL },
];

/**
 * The deny for each of ostra's milestone 6 tools the task's tool sets don't name (`ostra_<tool>`):
 * OpenCode then offers it to no agent of the task, so a code task never sees `submit_review` even
 * if a server lists it. The sidecar serves only the task's sets too; this is the adapter's own half.
 */
export const toolFilterPermissions = (tools: readonly OstraToolSet[]): readonly OpenCodePermission[] =>
  teamTools.filter((entry) => !tools.includes(entry.set)).map((entry) => ({ action: `${OSTRA_MCP_SERVER}_${entry.tool}`, resource: "*", effect: "deny" as const }));

/**
 * The task's permissions in OpenCode's order (ADR 0049): everything allowed, then each rule as
 * `ask`, and `external_directory` denied last, so it always wins.
 */
export const buildPermissions = (input: PermissionInput): readonly OpenCodePermission[] => {
  const { approvalRules, mcpServers } = input;
  const asks: OpenCodePermission[] = [];
  // "A command outside an allowlist": every command asks, then the allowlist goes on. With several
  // such rules a command must be inside all of them, so only a prefix every allowlist holds is allowed.
  const allowlists = approvalRules.flatMap((rule) => (rule.tool === "execute" && rule.match.kind === "command-outside" ? [rule.match.allowlist] : []));
  const allowlisted: OpenCodePermission[] = [];
  if (allowlists.length > 0) {
    allowlisted.push({ action: "shell", resource: "*", effect: "ask" });
    const prefixes = [...new Set(allowlists.flat())];
    for (const prefix of prefixes) {
      if (allowlists.every((allowlist) => !commandOutsideAllowlist(prefix, allowlist))) {
        for (const resource of allowsFor(prefix)) {
          allowlisted.push({ action: "shell", resource, effect: "allow" });
        }
      }
    }
  }
  let watchesCommands = allowlists.length > 0;
  for (const rule of approvalRules) {
    switch (rule.tool) {
      case "edit":
        asks.push({ action: "edit", resource: rule.match.kind === "path-glob" ? globToResource(rule.match.glob) : "*", effect: "ask" });
        break;
      case "execute":
        watchesCommands = true;
        if (rule.match.kind === "command-prefix") {
          for (const prefix of rule.match.prefixes) {
            const resource = prefixToResource(prefix);
            if (resource !== null) {
              asks.push({ action: "shell", resource, effect: "ask" });
            }
          }
        } else if (rule.match.kind === "any") {
          asks.push({ action: "shell", resource: "*", effect: "ask" });
        }
        break;
      case "fetch":
        // The network: a page, and a web search, which reaches it too.
        asks.push({ action: "webfetch", resource: "*", effect: "ask" }, { action: "websearch", resource: "*", effect: "ask" });
        break;
      case "mcp":
        for (const server of serversFor(rule, mcpServers)) {
          asks.push({ action: `${server}_*`, resource: "*", effect: "ask" });
        }
        break;
      default:
        rule.tool satisfies never;
    }
  }
  const unreadable: OpenCodePermission[] = watchesCommands ? UNREADABLE_SHELL.map((resource) => ({ action: "shell", resource, effect: "ask" })) : [];
  // Milestone 6: a read-only kind's edits denied after every ask, so no rule's ask lets one through;
  // and ostra's tools the task's sets don't name.
  const readOnly: OpenCodePermission[] = editsAllowed(input.kind ?? "code", input.allowPrototyping ?? false) ? [] : [{ action: "edit", resource: "*", effect: "deny" }];
  // Without the sets (a runner before milestone 6), the server is the filter: it serves the defaults.
  const filtered = input.tools === undefined ? [] : toolFilterPermissions(input.tools);
  const [allowAll, denyOutside] = permissionRules;
  return [allowAll, ...allowlisted, ...asks, ...unreadable, ...readOnly, ...filtered, denyOutside];
};

/**
 * What OpenCode's plan agent may not do, on top of its own refusal of edits (ADR 0049, F-063): a
 * command outside the read-only list, a write through a redirection, a fetch, a web search, a
 * subagent (which could edit), and a tool of an MCP server that isn't read-only. Written as the
 * plan agent's own permissions, which OpenCode checks after the task's.
 */
export const planModePermissions = (mcpServers: readonly LaunchMcpServer[]): readonly OpenCodePermission[] => [
  { action: "edit", resource: "*", effect: "deny" },
  { action: "shell", resource: "*", effect: "deny" },
  ...PLAN_MODE_READ_ONLY_COMMANDS.flatMap((command) => allowsFor(command).map((resource) => ({ action: "shell", resource, effect: "allow" as const }))),
  // Anything a read-only command could still be made to do: write a file, or run another command.
  ...["*>*", "*$(*", "*`*", "*<(*"].map((resource) => ({ action: "shell", resource, effect: "deny" as const })),
  { action: "webfetch", resource: "*", effect: "deny" },
  { action: "websearch", resource: "*", effect: "deny" },
  { action: "subagent", resource: "*", effect: "deny" },
  ...mcpServers.filter((server) => !server.readOnly).map((server) => ({ action: `${server.name}_*`, resource: "*", effect: "deny" as const })),
];

/** The OpenCode agent a mode runs as: its own plan agent, with the denies above, or its build agent. Their IDs are ostra's mode names. */
export const agentForMode = (mode: TurnMode): string => mode;
