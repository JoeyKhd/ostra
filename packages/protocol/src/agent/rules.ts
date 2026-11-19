import { z } from "zod";

import { approvalRuleIdSchema, taskApprovalRuleIdSchema } from "../ids.ts";
import { runnerLimits } from "../runner/limits.ts";

// Approval rules and task rules (ADR 0049, F-026, protocol minor 2), and the pure matcher every
// side shares. They live here, not in `packages/domain`, because the runner and the adapters are
// Apache-2.0 and can't import the domain (Q190): the runner checks task rules, a `runner-only`
// adapter checks profile rules, core stores them and the panel shows what a rule covers.
//
// A rule's effect is always "ask a person". The matcher never runs a shell: a command is split
// into words by the small reader below, and a path is compared after normalizing it.

/** The four tools a rule can name. */
export const approvalToolSchema = z.enum(["edit", "execute", "fetch", "mcp"]);
export type ApprovalTool = z.infer<typeof approvalToolSchema>;

/** A command prefix: its words, as written, such as `pnpm add`. */
const commandPrefix = z.string().trim().min(1).max(500);
/** A path glob with `*` and `**`, repo-relative, forward slashes. */
const pathGlob = z.string().trim().min(1).max(1024);

export const approvalRuleMatchSchema = z.discriminatedUnion("kind", [
  /** `edit` only: a path that matches the glob. */
  z.strictObject({ kind: z.literal("path-glob"), glob: pathGlob }),
  /** `execute` only: a command whose words start with one of the prefixes. */
  z.strictObject({ kind: z.literal("command-prefix"), prefixes: z.array(commandPrefix).min(1).max(200) }),
  /** `execute` only: a command that doesn't start with one of the allowlist's prefixes. */
  z.strictObject({ kind: z.literal("command-outside"), allowlist: z.array(commandPrefix).max(500) }),
  /** Every tool: any request of the tool. */
  z.strictObject({ kind: z.literal("any") }),
  /** `mcp` only: a call to a server the spec doesn't mark read-only, or doesn't list. */
  z.strictObject({ kind: z.literal("mcp-not-read-only") }),
]);
export type ApprovalRuleMatch = z.infer<typeof approvalRuleMatchSchema>;
export type ApprovalRuleMatchKind = ApprovalRuleMatch["kind"];

/** Which tools each match kind fits. The schema and the profile editor's pickers follow it. */
export const matchKindTools: Readonly<Record<ApprovalRuleMatchKind, readonly ApprovalTool[]>> = {
  "path-glob": ["edit"],
  "command-prefix": ["execute"],
  "command-outside": ["execute"],
  any: ["edit", "execute", "fetch", "mcp"],
  "mcp-not-read-only": ["mcp"],
};

/** Whether a match kind fits a tool. */
export const matchFitsTool = (kind: ApprovalRuleMatchKind, tool: ApprovalTool): boolean =>
  matchKindTools[kind].includes(tool);

/** The preset a rule came from (ADR 0049), for the editor's chip. */
export const approvalRulePresetSchema = z.enum(["dependency", "migration", "allowlist", "network"]);
export type ApprovalRulePreset = z.infer<typeof approvalRulePresetSchema>;

/** A profile's rule: requests of `tool` that `match` covers need a person (ADR 0049). */
export const approvalRuleSchema = z
  .strictObject({
    ruleId: approvalRuleIdSchema,
    /** The rule's name, as the card and the receipt show it. */
    name: z.string().trim().min(1).max(200),
    tool: approvalToolSchema,
    match: approvalRuleMatchSchema,
    /** The preset it came from, when it did. */
    preset: approvalRulePresetSchema.optional(),
  })
  .refine((rule) => matchFitsTool(rule.match.kind, rule.tool), {
    message: "the match doesn't fit the rule's tool",
    path: ["match", "kind"],
  });
export type ApprovalRule = z.infer<typeof approvalRuleSchema>;

/**
 * A "for this task" rule (ADR 0049, Q167): the tool and a pattern drawn from the request that
 * was approved. A path is exact; a command is a prefix of words; a URL is a host; an MCP call is
 * the server and tool's name. `ruleId` is the `TaskApprovalRule` row.
 */
export const taskRuleSchema = z.strictObject({
  ruleId: taskApprovalRuleIdSchema,
  tool: approvalToolSchema,
  pattern: z.string().min(1).max(1024),
});
export type TaskRule = z.infer<typeof taskRuleSchema>;

/** A task rule before core has written its row: the command's and the event's `taskRule`. */
export type TaskRulePattern = Pick<TaskRule, "tool" | "pattern">;

/** What a request touches, for the card, the rule check and the task rule's pattern. */
export const approvalSubjectKindSchema = z.enum(["path", "command", "url", "tool"]);
export type ApprovalSubjectKind = z.infer<typeof approvalSubjectKindSchema>;

export const approvalSubjectSchema = z.strictObject({
  kind: approvalSubjectKindSchema,
  /** The path, the command line, the URL, or `<server>/<tool>`. May quote the repo: never logged. */
  value: z.string().min(1).max(8192),
});
export type ApprovalSubject = z.infer<typeof approvalSubjectSchema>;

/** The tool a subject's kind belongs to. */
export const toolForSubjectKind = (kind: ApprovalSubjectKind): ApprovalTool => {
  switch (kind) {
    case "path":
      return "edit";
    case "command":
      return "execute";
    case "url":
      return "fetch";
    case "tool":
      return "mcp";
    default:
      return kind satisfies never;
  }
};

/** A request as the matcher reads it. */
export type ApprovalRequestSubject = { readonly tool: ApprovalTool; readonly subject: ApprovalSubject };

/** What the matcher needs from the task spec: the MCP servers and whether each is read-only. */
export type RuleContext = {
  readonly mcpServers: readonly { readonly name: string; readonly readOnly: boolean }[];
};

export const emptyRuleContext: RuleContext = { mcpServers: [] };

/** An MCP call's subject value: the server's name and the tool's, `<server>/<tool>`. */
export const mcpSubjectValue = (server: string, tool: string): string => `${server}/${tool}`;

/** The server's name in an MCP subject value. */
export const mcpServerOfSubject = (value: string): string => {
  const slash = value.indexOf("/");
  return slash === -1 ? value : value.slice(0, slash);
};

// ---------- paths ----------

/**
 * A request's path, repo- or workspace-relative with forward slashes, `.` segments and repeated
 * slashes removed. `null` when it leaves the root (a `..` above it) or is absolute: such a path
 * matches every glob, so it always asks.
 */
export const normalizeRulePath = (path: string): string | null => {
  const slashed = path.replaceAll("\\", "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed)) {
    return null;
  }
  const segments: string[] = [];
  for (const segment of slashed.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        return null;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? null : segments.join("/");
};

const escapeRegex = (text: string): string => text.replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`);

const segmentToRegex = (segment: string): string => {
  let source = "";
  for (const char of segment) {
    if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegex(char);
    }
  }
  return source;
};

/**
 * A glob as a regular expression: `*` and `?` within one segment, `**` as a whole segment for
 * any number of segments (none included), so `**\/package.json` matches `package.json` too.
 */
export const globToRegExp = (glob: string): RegExp => {
  const segments = glob.trim().replaceAll("\\", "/").replace(/^\.\//, "").split("/").filter((s) => s !== "");
  let source = "";
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**") {
      source += last ? ".*" : "(?:[^/]+/)*";
      return;
    }
    source += segmentToRegex(segment) + (last ? "" : "/");
  });
  return new RegExp(`^${source}$`);
};

/** Whether a path matches a glob. A path that leaves the root matches every glob. */
export const pathMatchesGlob = (path: string, glob: string): boolean => {
  const normalized = normalizeRulePath(path);
  return normalized === null ? true : globToRegExp(glob).test(normalized);
};

// ---------- commands ----------

/** A command line read into its simple commands, without a shell. */
export type ParsedCommand = {
  /** Each simple command's words, split at `&&`, `||`, `;`, `|`, `&`, newlines and parentheses. */
  readonly segments: readonly (readonly string[])[];
  /** Whether it holds a `$(...)`, a backtick or a process substitution, whose words can't be read. */
  readonly substitution: boolean;
};

const OPERATOR_CHARS = new Set([";", "|", "&", "\n", "(", ")"]);

/**
 * Splits a command line into simple commands and their words. Quotes group words and are
 * removed; a backslash escapes the next character outside single quotes. Never runs anything.
 */
export const parseCommandLine = (line: string): ParsedCommand => {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  let substitution = false;
  const endWord = (): void => {
    if (inWord) {
      words.push(word);
    }
    word = "";
    inWord = false;
  };
  const endSegment = (): void => {
    endWord();
    if (words.length > 0) {
      segments.push(words);
    }
    words = [];
  };
  for (let index = 0; index < line.length; index += 1) {
    const char = line.charAt(index);
    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        word += char;
      }
      continue;
    }
    if (char === "\\" && index + 1 < line.length) {
      index += 1;
      word += line.charAt(index);
      inWord = true;
      continue;
    }
    if (char === "`" || (char === "$" && line.charAt(index + 1) === "(") || ((char === "<" || char === ">") && line.charAt(index + 1) === "(")) {
      substitution = true;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else {
        word += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
      continue;
    }
    if (char === "`") {
      endSegment();
      continue;
    }
    if (char === "$" && line.charAt(index + 1) === "(") {
      endSegment();
      index += 1;
      continue;
    }
    const previous = line.charAt(index - 1);
    if (char === "&" && (previous === ">" || previous === "<" || line.charAt(index + 1) === ">")) {
      // A redirection (`2>&1`, `&>file`), not a background command.
      word += char;
      inWord = true;
      continue;
    }
    if (OPERATOR_CHARS.has(char) || char === "\r") {
      endSegment();
      continue;
    }
    if (char === " " || char === "\t") {
      endWord();
      continue;
    }
    word += char;
    inWord = true;
  }
  endSegment();
  return { segments, substitution };
};

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** A simple command's words with leading `NAME=value` assignments dropped and the program's path cut to its name. */
const commandWords = (segment: readonly string[]): readonly string[] => {
  let start = 0;
  while (start < segment.length && ENV_ASSIGNMENT.test(segment[start] ?? "")) {
    start += 1;
  }
  const words = segment.slice(start);
  const [program, ...rest] = words;
  if (program === undefined) {
    return [];
  }
  const name = program.replaceAll("\\", "/").split("/").pop() ?? program;
  return [name, ...rest];
};

const prefixWords = (prefix: string): readonly string[] => parseCommandLine(prefix).segments[0] ?? [];

const startsWithWords = (words: readonly string[], prefix: readonly string[]): boolean =>
  prefix.length > 0 && prefix.length <= words.length && prefix.every((word, index) => words[index] === word);

/** Whether any simple command of the line starts with one of the prefixes. */
export const commandMatchesPrefix = (line: string, prefixes: readonly string[]): boolean => {
  const parsed = parseCommandLine(line);
  const wanted = prefixes.map(prefixWords);
  return parsed.segments.some((segment) => {
    const words = commandWords(segment);
    return wanted.some((prefix) => startsWithWords(words, prefix));
  });
};

/**
 * Whether a command line goes outside the allowlist: one of its simple commands starts with none
 * of the prefixes, or it holds a substitution whose words can't be read. An empty line is inside.
 */
export const commandOutsideAllowlist = (line: string, allowlist: readonly string[]): boolean => {
  const parsed = parseCommandLine(line);
  if (parsed.substitution) {
    return true;
  }
  const allowed = allowlist.map(prefixWords);
  return parsed.segments.some((segment) => {
    const words = commandWords(segment);
    return !allowed.some((prefix) => startsWithWords(words, prefix));
  });
};

// ---------- URLs ----------

/** A URL's host in lower case, without the port; `null` when it isn't a URL. */
export const hostOfUrl = (value: string): string | null => {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "" ? null : host;
  } catch {
    return null;
  }
};

// ---------- matching ----------

/** Whether one profile rule covers a request. */
export const ruleMatches = (rule: ApprovalRule, request: ApprovalRequestSubject, context: RuleContext): boolean => {
  if (rule.tool !== request.tool) {
    return false;
  }
  const { subject } = request;
  const match = rule.match;
  switch (match.kind) {
    case "any":
      return true;
    case "path-glob":
      return subject.kind === "path" && pathMatchesGlob(subject.value, match.glob);
    case "command-prefix":
      return subject.kind === "command" && commandMatchesPrefix(subject.value, match.prefixes);
    case "command-outside":
      return subject.kind === "command" && commandOutsideAllowlist(subject.value, match.allowlist);
    case "mcp-not-read-only": {
      if (subject.kind !== "tool") {
        return false;
      }
      const server = context.mcpServers.find((entry) => entry.name === mcpServerOfSubject(subject.value));
      return server?.readOnly !== true;
    }
    default:
      return match satisfies never;
  }
};

/** The first profile rule that covers a request, or `null` when none does and the request goes on. */
export const firstMatchingRule = (
  rules: readonly ApprovalRule[],
  request: ApprovalRequestSubject,
  context: RuleContext = emptyRuleContext,
): ApprovalRule | null => rules.find((rule) => ruleMatches(rule, request, context)) ?? null;

/**
 * The "for this task" pattern drawn from a request (ADR 0049, Q167): the exact path; the program
 * and its first argument; the host; the server and tool's name. `null` when the subject gives no
 * safe pattern (a path leaving the root, a command with a substitution or several commands, a URL
 * that doesn't parse), and the card then offers no "for this task".
 */
export const taskRulePatternFor = (request: ApprovalRequestSubject): TaskRulePattern | null => {
  const { subject, tool } = request;
  switch (subject.kind) {
    case "path": {
      const path = normalizeRulePath(subject.value);
      return path === null ? null : { tool, pattern: path };
    }
    case "command": {
      const parsed = parseCommandLine(subject.value);
      const [only, ...others] = parsed.segments;
      if (parsed.substitution || only === undefined || others.length > 0) {
        return null;
      }
      const words = commandWords(only).slice(0, 2);
      return words.length === 0 ? null : { tool, pattern: words.join(" ") };
    }
    case "url": {
      const host = hostOfUrl(subject.value);
      return host === null ? null : { tool, pattern: host };
    }
    case "tool":
      return { tool, pattern: subject.value };
    default:
      return subject.kind satisfies never;
  }
};

/**
 * Whether a task rule answers a request. Narrower than a profile rule on purpose: a path is the
 * same path, a command is one simple command with no substitution that starts with the pattern's
 * words, a URL has the same host, an MCP call is the same server and tool.
 */
export const taskRuleMatches = (rule: TaskRulePattern, request: ApprovalRequestSubject): boolean => {
  if (rule.tool !== request.tool) {
    return false;
  }
  const { subject } = request;
  switch (subject.kind) {
    case "path":
      return normalizeRulePath(subject.value) === rule.pattern;
    case "command": {
      const parsed = parseCommandLine(subject.value);
      const [only, ...others] = parsed.segments;
      return (
        !parsed.substitution &&
        only !== undefined &&
        others.length === 0 &&
        startsWithWords(commandWords(only), prefixWords(rule.pattern))
      );
    }
    case "url":
      return hostOfUrl(subject.value) === rule.pattern.toLowerCase();
    case "tool":
      return subject.value === rule.pattern;
    default:
      return subject.kind satisfies never;
  }
};

/** The first task rule that answers a request, or `null`. */
export const firstMatchingTaskRule = <Rule extends TaskRulePattern>(
  rules: readonly Rule[],
  request: ApprovalRequestSubject,
): Rule | null => rules.find((rule) => taskRuleMatches(rule, request)) ?? null;

/** The most rules one profile or task carries, for the arrays that hold them. */
export const approvalRulesSchema = z.array(approvalRuleSchema).max(runnerLimits.approvalRulesMax);
export const taskRulesSchema = z.array(taskRuleSchema).max(runnerLimits.approvalRulesMax);
