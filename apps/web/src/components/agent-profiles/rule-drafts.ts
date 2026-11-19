import { approvalRuleIdSchema, matchFitsTool, matchKindTools } from "@ostra/protocol";
import type { ApprovalRule, ApprovalRuleId, ApprovalRuleMatch, ApprovalRuleMatchKind, ApprovalRulePreset, ApprovalTool } from "@ostra/protocol";

import type { MessageKey } from "@/lib/messages";

// A profile's approval rules as the editor and the list show them (agent-profile.md, "Approval
// rules"; agent-profiles.md, "Properties panel"). The protocol stores one glob per `path-glob`
// rule, so a preset such as "Writing a migration" is four rules; the panel shows the consecutive
// rules that share a name, a tool, a match kind and a preset as one rule with several globs, and
// writes it back as those rules, keeping each one's ID. Pure, so it's tested alone.

/** One rule as the panel shows it and the editor edits it. */
export type RuleDraft = {
  /** A key for React and for the open rule; stable across edits. */
  readonly key: string;
  /** The stored rules it stands for, in order; a new rule has none until it's saved. */
  readonly ruleIds: readonly ApprovalRuleId[];
  readonly name: string;
  readonly tool: ApprovalTool;
  readonly matchKind: ApprovalRuleMatchKind;
  /** The globs or the commands, comma-separated; empty for the "any" matches. */
  readonly text: string;
  readonly preset: ApprovalRulePreset | null;
};

const listOf = (match: ApprovalRuleMatch): readonly string[] => {
  switch (match.kind) {
    case "path-glob":
      return [match.glob];
    case "command-prefix":
      return match.prefixes;
    case "command-outside":
      return match.allowlist;
    case "any":
    case "mcp-not-read-only":
      return [];
    default:
      return match satisfies never;
  }
};

/** The comma-separated text's entries, trimmed, empty ones dropped. */
export const entriesOf = (text: string): readonly string[] =>
  text
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

/** A stored rule as the routers return it: `preset` is `null` when it came from none. */
export type RuleLike = Pick<ApprovalRule, "ruleId" | "name" | "tool" | "match"> & { readonly preset?: ApprovalRulePreset | null | undefined };

/** The stored rules as the panel's rules: consecutive path globs of one rule merge. */
export const groupRules = (rules: readonly RuleLike[]): readonly RuleDraft[] => {
  const drafts: RuleDraft[] = [];
  for (const rule of rules) {
    const last = drafts.at(-1);
    const preset = rule.preset ?? null;
    if (
      last !== undefined &&
      rule.match.kind === "path-glob" &&
      last.matchKind === "path-glob" &&
      last.name === rule.name &&
      last.tool === rule.tool &&
      last.preset === preset
    ) {
      drafts[drafts.length - 1] = { ...last, ruleIds: [...last.ruleIds, rule.ruleId], text: `${last.text}, ${rule.match.glob}` };
      continue;
    }
    drafts.push({
      key: rule.ruleId,
      ruleIds: [rule.ruleId],
      name: rule.name,
      tool: rule.tool,
      matchKind: rule.match.kind,
      text: listOf(rule.match).join(", "),
      preset,
    });
  }
  return drafts;
};

/** A rule's stored form: one rule per glob, the drafts' IDs kept in order and new ones minted. */
export const draftToRules = (draft: RuleDraft, newId: () => string): readonly ApprovalRule[] => {
  const ids = [...draft.ruleIds];
  const id = (): ApprovalRuleId => ids.shift() ?? approvalRuleIdSchema.parse(newId());
  const name = draft.name.trim();
  const base = (match: ApprovalRuleMatch): ApprovalRule => ({
    ruleId: id(),
    name,
    tool: draft.tool,
    match,
    ...(draft.preset === null ? {} : { preset: draft.preset }),
  });
  const entries = entriesOf(draft.text);
  switch (draft.matchKind) {
    case "path-glob":
      return entries.map((glob) => base({ kind: "path-glob", glob }));
    case "command-prefix":
      return [base({ kind: "command-prefix", prefixes: [...entries] })];
    case "command-outside":
      return [base({ kind: "command-outside", allowlist: [...entries] })];
    case "any":
      return [base({ kind: "any" })];
    case "mcp-not-read-only":
      return [base({ kind: "mcp-not-read-only" })];
    default:
      return draft.matchKind satisfies never;
  }
};

/** Every draft's stored rules, in order. */
export const draftsToRules = (drafts: readonly RuleDraft[], newId: () => string): readonly ApprovalRule[] =>
  drafts.flatMap((draft) => draftToRules(draft, newId));

/** The match kinds the editor offers for a tool, in its order (agent-profile.md, "A rule open for editing"). */
export const matchKindsFor = (tool: ApprovalTool): readonly ApprovalRuleMatchKind[] => {
  const order: readonly ApprovalRuleMatchKind[] = ["path-glob", "command-prefix", "command-outside", "mcp-not-read-only", "any"];
  return order.filter((kind) => matchKindTools[kind].includes(tool));
};

/** The draft after its tool changes: the match kind moves to the tool's first when it no longer fits. */
export const withTool = (draft: RuleDraft, tool: ApprovalTool): RuleDraft => {
  if (matchFitsTool(draft.matchKind, tool)) return { ...draft, tool };
  const [first] = matchKindsFor(tool);
  return { ...draft, tool, matchKind: first ?? "any", text: "" };
};

/** Whether the match takes globs or commands in the text input. */
export const takesText = (kind: ApprovalRuleMatchKind): boolean => kind === "path-glob" || kind === "command-prefix" || kind === "command-outside";

/** Why a glob isn't one, or `null`: it has to stay inside the repo. */
export const globProblem = (glob: string): string | null => {
  const slashed = glob.replaceAll("\\", "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed)) return "it starts at the root of the disk";
  if (slashed.split("/").includes("..")) return "it leaves the repo with ..";
  if (/[[\]{}]/.test(slashed)) return "only * and ** are supported";
  return null;
};

export type RuleProblem = { readonly key: MessageKey; readonly reason?: string };

/** What stops a rule from closing and the profile from saving, or `null`. */
export const ruleProblem = (draft: RuleDraft): RuleProblem | null => {
  if (draft.name.trim() === "") return { key: "agentProfiles.rules.errorName" };
  const entries = entriesOf(draft.text);
  switch (draft.matchKind) {
    case "path-glob": {
      if (entries.length === 0) return { key: "agentProfiles.rules.errorGlobs" };
      for (const glob of entries) {
        const reason = globProblem(glob);
        if (reason !== null) return { key: "agentProfiles.rules.errorGlob", reason };
      }
      return null;
    }
    case "command-prefix":
      return entries.length === 0 ? { key: "agentProfiles.rules.errorCommands" } : null;
    case "command-outside":
    case "any":
    case "mcp-not-read-only":
      return null;
    default:
      return draft.matchKind satisfies never;
  }
};

/** Up to `shown` entries joined, then `+N` for the rest. */
const firstOf = (entries: readonly string[], shown: number, joiner: string): string => {
  const head = entries.slice(0, shown).join(joiner);
  return entries.length > shown ? `${head}${joiner === ", " ? " " : joiner}+${String(entries.length - shown)}` : head;
};

/** The words for a match with no list. */
const anyWords = (tool: ApprovalTool): MessageKey => {
  switch (tool) {
    case "edit":
      return "agentProfiles.rules.anyFile";
    case "execute":
      return "agentProfiles.rules.anyCommand";
    case "fetch":
      return "agentProfiles.rules.anyUrl";
    case "mcp":
      return "agentProfiles.rules.anyServer";
    default:
      return tool satisfies never;
  }
};

/** A match in words: either a message to look up or the literal list. */
export type MatchWords = { readonly kind: "message"; readonly key: MessageKey; readonly params?: Readonly<Record<string, string | number>> } | { readonly kind: "text"; readonly text: string };

/** The match in short, for the list's panel: `**\/migrations/** · **\/*.sql · +2`, `9 allowed commands`. */
export const shortMatch = (draft: RuleDraft): MatchWords => {
  const entries = entriesOf(draft.text);
  switch (draft.matchKind) {
    case "path-glob":
      return { kind: "text", text: firstOf(entries, 2, " · ") };
    case "command-prefix":
      return { kind: "text", text: firstOf(entries, 2, ", ") };
    case "command-outside":
      return entries.length === 1
        ? { kind: "message", key: "agentProfiles.rules.allowedOne" }
        : { kind: "message", key: "agentProfiles.rules.allowedMany", params: { n: entries.length } };
    case "any":
      return { kind: "message", key: anyWords(draft.tool) };
    case "mcp-not-read-only":
      return { kind: "message", key: "agentProfiles.rules.notReadOnly" };
    default:
      return draft.matchKind satisfies never;
  }
};

/** The match in full, for the editor's rule row: every glob; `outside 9 allowed: ls, cat …`. */
export const longMatch = (draft: RuleDraft): MatchWords => {
  const entries = entriesOf(draft.text);
  switch (draft.matchKind) {
    case "path-glob":
      return { kind: "text", text: entries.join(", ") };
    case "command-prefix":
      return { kind: "text", text: firstOf(entries, 2, ", ") };
    case "command-outside":
      return {
        kind: "message",
        key: "agentProfiles.rules.outside",
        params: { n: entries.length, list: `${entries.slice(0, 5).join(", ")}${entries.length > 5 ? " …" : ""}` },
      };
    case "any":
      return { kind: "message", key: anyWords(draft.tool) };
    case "mcp-not-read-only":
      return { kind: "message", key: "agentProfiles.rules.notReadOnly" };
    default:
      return draft.matchKind satisfies never;
  }
};

/** The tool's words before the match: `Edit files ·`. */
export const toolKey = (tool: ApprovalTool): MessageKey => {
  switch (tool) {
    case "edit":
      return "agentProfiles.rules.tool.edit";
    case "execute":
      return "agentProfiles.rules.tool.execute";
    case "fetch":
      return "agentProfiles.rules.tool.fetch";
    case "mcp":
      return "agentProfiles.rules.tool.mcp";
    default:
      return tool satisfies never;
  }
};

/** The match picker's words. */
export const matchKey = (kind: ApprovalRuleMatchKind): MessageKey => {
  switch (kind) {
    case "path-glob":
      return "agentProfiles.rules.match.pathGlob";
    case "command-prefix":
      return "agentProfiles.rules.match.commandPrefix";
    case "command-outside":
      return "agentProfiles.rules.match.commandOutside";
    case "any":
      return "agentProfiles.rules.match.any";
    case "mcp-not-read-only":
      return "agentProfiles.rules.match.notReadOnly";
    default:
      return kind satisfies never;
  }
};

/** The words of "any" for a tool's picker: `Any file`, `Any command`, `Any URL`, `Any server`. */
export const anyMatchKey = (tool: ApprovalTool): MessageKey => {
  switch (tool) {
    case "edit":
      return "agentProfiles.rules.match.anyFile";
    case "execute":
      return "agentProfiles.rules.match.anyCommand";
    case "fetch":
      return "agentProfiles.rules.match.anyUrl";
    case "mcp":
      return "agentProfiles.rules.match.anyServer";
    default:
      return tool satisfies never;
  }
};

/** A new custom rule, open for editing: edit files, path matches (agent-profile.md). */
export const emptyRule = (key: string): RuleDraft => ({ key, ruleIds: [], name: "", tool: "edit", matchKind: "path-glob", text: "", preset: null });
