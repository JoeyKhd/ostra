import { blobIdSchema, modelIdSchema } from "@ostra/protocol";
import type { AgentProfileId, MemberId } from "@ostra/protocol";

import type { MessageKey } from "@/lib/messages";
import type { RouterInputs } from "@/lib/trpc";

import type { ProfileDetail } from "./profile-types";
import { draftsToRules, groupRules, ruleProblem } from "./rule-drafts";
import type { RuleDraft } from "./rule-drafts";

// The profile editor's draft (agent-profile.md): what the admin is changing before "Save profile".
// UI state only; the save turns it into the router's input. Pure, so it's tested alone.

/** A skill file: its path in the skill's folder, its size, and the blob that holds its bytes (uploaded when it was picked). */
export type SkillFileDraft = {
  readonly path: string;
  readonly size: number;
  readonly blobId: string;
};

export type SkillDraft = {
  readonly key: string;
  readonly name: string;
  readonly body: string;
  readonly files: readonly SkillFileDraft[];
};

/** A header of an HTTP server: its value is write-only. `stored` says one is kept; an empty `value` keeps it. */
export type HeaderDraft = { readonly key: string; readonly name: string; readonly value: string; readonly stored: boolean };
export type EnvDraft = { readonly key: string; readonly name: string; readonly value: string };

export type ServerDraft =
  | { readonly key: string; readonly transport: "http"; readonly name: string; readonly url: string; readonly headers: readonly HeaderDraft[]; readonly readOnly: boolean }
  | { readonly key: string; readonly transport: "stdio"; readonly name: string; readonly command: string; readonly args: string; readonly env: readonly EnvDraft[]; readonly readOnly: boolean };

export type ProfileDraft = {
  readonly name: string;
  readonly adapter: string;
  readonly modelId: string | null;
  readonly instructions: string;
  readonly planFirst: boolean;
  readonly access: "everyone" | "listed";
  readonly members: readonly MemberId[];
  readonly rules: readonly RuleDraft[];
  readonly skills: readonly SkillDraft[];
  readonly servers: readonly ServerDraft[];
};

let counter = 0;
/** A key for a row React keeps across edits. */
export const nextKey = (prefix = "k"): string => {
  counter += 1;
  return `${prefix}-${String(counter)}`;
};

/** The draft as it would save: trimmed, members in order. React's row keys are left out by `isDirty`. */
const comparable = (draft: ProfileDraft): ProfileDraft => ({
  ...draft,
  name: draft.name.trim(),
  instructions: draft.instructions.trim(),
  members: [...draft.members].sort(),
});

/** Leaves out the `key` React keeps on each row, so two drafts compare by what they'd save. */
const withoutKeys = (name: string, value: unknown): unknown => (name === "key" ? undefined : value);

/** Whether the draft differs from what was loaded. */
export const isDirty = (draft: ProfileDraft, saved: ProfileDraft): boolean =>
  JSON.stringify(comparable(draft), withoutKeys) !== JSON.stringify(comparable(saved), withoutKeys);

/** A skill's or server's name: lowercase letters, digits and dashes (ticket 34's slug). */
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** What stops "Save profile", in the order the page shows it, or `null`. */
export const draftProblem = (draft: ProfileDraft): MessageKey | null => {
  if (draft.name.trim() === "") return "agentProfiles.editor.name";
  if (draft.modelId === null) return "agentProfiles.editor.pickModelPlaceholder";
  if (draft.access === "listed" && draft.members.length === 0) return "agentProfiles.props.nobodyListed";
  for (const rule of draft.rules) {
    const problem = ruleProblem(rule);
    if (problem !== null) return problem.key;
  }
  return null;
};

/** The first lines of SKILL.md's front matter `description`, else its first non-empty line. */
export const skillDescription = (body: string): string => {
  const lines = body.split(/\r?\n/);
  if (lines[0]?.trim() === "---") {
    const end = lines.indexOf("---", 1);
    const front = end === -1 ? [] : lines.slice(1, end);
    for (const line of front) {
      const match = /^description:\s*(.*)$/.exec(line.trim());
      if (match?.[1] !== undefined) return match[1].replace(/^["']|["']$/g, "").trim();
    }
    const rest = end === -1 ? lines.slice(1) : lines.slice(end + 1);
    return rest.map((line) => line.replace(/^#+\s*/, "").trim()).find((line) => line !== "") ?? "";
  }
  return lines.map((line) => line.replace(/^#+\s*/, "").trim()).find((line) => line !== "") ?? "";
};

/** At most 20 files of at most 1 MiB each (agent-profile.md, the skill Sheet). */
export const SKILL_FILES_MAX = 20;
export const SKILL_FILE_MAX_BYTES = 1024 * 1024;

export type SkillProblem = { readonly field: "name" | "body" | "files"; readonly key: MessageKey; readonly path?: string };

/** What stops a skill's Sheet from closing, or `null`. */
export const skillProblem = (skill: SkillDraft, others: readonly SkillDraft[]): SkillProblem | null => {
  if (!SLUG.test(skill.name)) return { field: "name", key: "agentProfiles.skill.errorName" };
  if (others.some((other) => other.key !== skill.key && other.name === skill.name)) return { field: "name", key: "agentProfiles.skill.errorTaken" };
  if (skill.body.trim() === "") return { field: "body", key: "agentProfiles.skill.errorBody" };
  if (skill.files.length > SKILL_FILES_MAX) return { field: "files", key: "agentProfiles.skill.errorCount" };
  const big = skill.files.find((file) => file.size > SKILL_FILE_MAX_BYTES);
  if (big !== undefined) return { field: "files", key: "agentProfiles.skill.errorSize", path: big.path };
  return null;
};

/**
 * What stops a file picked in the skill's Sheet from being added, or `null`. A file with the path of
 * one already in the skill replaces it, so it never counts against the limit twice.
 */
export const pickedFileProblem = (files: readonly SkillFileDraft[], picked: { readonly name: string; readonly size: number }): SkillProblem | null => {
  if (picked.name === "SKILL.md" || picked.name.length > 512) return { field: "files", key: "agentProfiles.skill.errorReserved", path: picked.name };
  if (picked.size === 0) return { field: "files", key: "agentProfiles.skill.errorEmpty", path: picked.name };
  if (picked.size > SKILL_FILE_MAX_BYTES) return { field: "files", key: "agentProfiles.skill.errorSize", path: picked.name };
  if (files.length >= SKILL_FILES_MAX && !files.some((file) => file.path === picked.name)) return { field: "files", key: "agentProfiles.skill.errorCount" };
  return null;
};

/** The files with `file` added, or in the place of the one that has its path. */
export const withFile = (files: readonly SkillFileDraft[], file: SkillFileDraft): readonly SkillFileDraft[] =>
  files.some((entry) => entry.path === file.path) ? files.map((entry) => (entry.path === file.path ? file : entry)) : [...files, file];

export type ServerProblem = { readonly field: "name" | "url" | "command"; readonly key: MessageKey };

const httpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

/** What stops a server's Sheet from closing, or `null`. */
export const serverProblem = (server: ServerDraft, others: readonly ServerDraft[]): ServerProblem | null => {
  if (!SLUG.test(server.name)) return { field: "name", key: "agentProfiles.server.errorName" };
  if (others.some((other) => other.key !== server.key && other.name === server.name)) return { field: "name", key: "agentProfiles.server.errorTaken" };
  if (server.transport === "http" && !httpUrl(server.url.trim())) return { field: "url", key: "agentProfiles.server.errorUrl" };
  if (server.transport === "stdio" && server.command.trim() === "") return { field: "command", key: "agentProfiles.server.errorCommand" };
  return null;
};

/** `mcp-ripgrep --root .`: a stdio server's command and its arguments, one line. */
export const commandLine = (server: Extract<ServerDraft, { transport: "stdio" }>): string =>
  [server.command.trim(), ...server.args.split(/\r?\n/).map((arg) => arg.trim()).filter((arg) => arg !== "")].join(" ");

// ---------- to and from the router ----------

/** The draft of a profile as loaded. */
export const draftFromDetail = (detail: ProfileDetail): ProfileDraft => ({
  name: detail.name,
  adapter: detail.adapter,
  modelId: detail.model?.id ?? null,
  instructions: detail.instructions ?? "",
  planFirst: detail.planFirst,
  access: detail.access.kind,
  members: detail.access.kind === "listed" ? detail.access.members.map((member) => member.memberId) : [],
  rules: groupRules(detail.rules),
  skills: detail.skills.map((skill) => ({
    key: nextKey("skill"),
    name: skill.name,
    body: skill.body,
    files: skill.files.map((file) => ({ path: file.path, size: file.size ?? 0, blobId: file.blobId })),
  })),
  servers: detail.mcpServers.map((server): ServerDraft =>
    server.transport === "http"
      ? {
          key: nextKey("server"),
          transport: "http",
          name: server.name,
          url: server.url,
          readOnly: server.readOnly,
          headers: server.headers.map((header) => ({ key: nextKey("h"), name: header.name, value: "", stored: true })),
        }
      : {
          key: nextKey("server"),
          transport: "stdio",
          name: server.name,
          command: server.command,
          args: server.args.join("\n"),
          env: Object.entries(server.env).map(([name, value]) => ({ key: nextKey("e"), name, value })),
          readOnly: server.readOnly,
        },
  ),
});

/** A new profile's draft: the agent, the built-in profile's model, nothing else (agent-profile.md, "New profile"). */
export const newDraft = (adapter: string, modelId: string | null): ProfileDraft => ({
  name: "",
  adapter,
  modelId,
  instructions: "",
  planFirst: false,
  access: "everyone",
  members: [],
  rules: [],
  skills: [],
  servers: [],
});

type SaveInput = RouterInputs["agentProfiles"]["save"];

/** The router's input for the draft. A header with no new value keeps the stored one (`null`). */
export const saveInputOf = (draft: ProfileDraft, profileId: AgentProfileId | null, newId: () => string): SaveInput => ({
  ...(profileId === null ? {} : { profileId }),
  name: draft.name.trim(),
  adapter: draft.adapter,
  modelId: draft.modelId === null ? null : modelIdSchema.parse(draft.modelId),
  instructions: draft.instructions.trim() === "" ? null : draft.instructions,
  approvalRules: [...draftsToRules(draft.rules, newId)],
  planFirst: draft.planFirst,
  access: draft.access === "everyone" ? { kind: "everyone" } : { kind: "listed", members: [...draft.members] },
  mcpServers: draft.servers.map((server) =>
    server.transport === "http"
      ? {
          name: server.name,
          transport: "http" as const,
          url: server.url.trim(),
          readOnly: server.readOnly,
          headers: server.headers
            .filter((header) => header.name.trim() !== "")
            .map((header) => ({ name: header.name.trim(), value: header.value === "" && header.stored ? null : header.value })),
        }
      : {
          name: server.name,
          transport: "stdio" as const,
          command: server.command.trim(),
          args: server.args.split(/\r?\n/).map((arg) => arg.trim()).filter((arg) => arg !== ""),
          env: Object.fromEntries(server.env.filter((row) => row.name.trim() !== "").map((row) => [row.name.trim(), row.value])),
          readOnly: server.readOnly,
        },
  ),
  skills: draft.skills.map((skill) => ({
    name: skill.name,
    body: skill.body,
    files: skill.files.map((file) => ({ path: file.path, blobId: blobIdSchema.parse(file.blobId) })),
  })),
});
