// Memory's words (F-109, F-111; app-targets/m4/memory.md, memory-note.md, memory-proposals.md): the
// kinds, where a note came from, a scope's routes, and the two refusals a save can meet, worded from
// the API's message (a secret's kind, never its value; who saved first).

import type { MemoryKind, ProjectId } from "@ostra/protocol";

import { t } from "@/lib/messages";
import type { MessageKey } from "@/lib/messages";

export const MEMORY_KINDS = ["convention", "command", "gotcha", "decision", "preference", "term"] as const satisfies readonly MemoryKind[];

const KIND_WORDS = {
  convention: "memory.kind.convention",
  command: "memory.kind.command",
  gotcha: "memory.kind.gotcha",
  decision: "memory.kind.decision",
  preference: "memory.kind.preference",
  term: "memory.kind.term",
} as const satisfies Record<MemoryKind, MessageKey>;

export const kindWord = (kind: MemoryKind): string => t(KIND_WORDS[kind]);

export type NoteSourceKind = "member" | "task" | "proposal" | "diff_comment" | "pr_comment" | "ai_finding";
export type SourceFilter = "member" | "agent" | "diff_comment" | "pr_comment";
export const SOURCE_FILTERS = ["member", "agent", "diff_comment", "pr_comment"] as const satisfies readonly SourceFilter[];

/** The Source filter a note falls under: an agent's proposal is `task` or `proposal`. */
export const sourceFilterOf = (kind: NoteSourceKind): SourceFilter => {
  switch (kind) {
    case "member":
      return "member";
    case "task":
    case "proposal":
    // Milestone 6 (F-111): a finding of the AI review, remembered by a member, is the agent's.
    case "ai_finding":
      return "agent";
    case "diff_comment":
      return "diff_comment";
    case "pr_comment":
      return "pr_comment";
    default:
      return kind satisfies never;
  }
};

const SOURCE_WORDS = {
  member: "memory.source.member",
  agent: "memory.source.agent",
  diff_comment: "memory.source.diffComment",
  pr_comment: "memory.source.prComment",
} as const satisfies Record<SourceFilter, MessageKey>;

export const sourceWord = (source: SourceFilter): string => t(SOURCE_WORDS[source]);

/** Where a scope's Memory pages live. */
export type MemoryScopeRef = { readonly scope: "organization" } | { readonly scope: "project"; readonly projectId: ProjectId };

export const memoryBase = (ref: MemoryScopeRef): string => (ref.scope === "organization" ? "/organization/memory" : `/projects/${ref.projectId}/memory`);

/**
 * The secret refusal's kinds, from the API's message ("This note holds a GitHub token, so it wasn't
 * saved…"); `null` when the message isn't one.
 */
export const secretFoundOf = (message: string | null | undefined): string | null => {
  const found = /^(?:This note|The proposal) holds (.+?)(?:, so it wasn't saved|\.)/.exec(message ?? "");
  return found?.[1] ?? null;
};

/** Who saved first and which version, from a `CONFLICT`'s message; `null` when it isn't one. */
export const conflictOf = (message: string | null | undefined): { readonly version: number; readonly name: string } | null => {
  const found = /^Version (\d+) was saved by (.+) since you opened this note\.$/.exec(message ?? "");
  return found?.[1] === undefined || found[2] === undefined ? null : { version: Number(found[1]), name: found[2] };
};

/** A note's body as UTF-8 bytes, against the 4 KiB limit: "214 B of 4 KiB", "1.2 KiB of 4 KiB". */
export const NOTE_BODY_MAX_BYTES = 4096;
export const bodySize = (body: string): { readonly bytes: number; readonly text: string } => {
  const bytes = new TextEncoder().encode(body).length;
  const shown = bytes < 1024 ? `${String(bytes)} B` : `${(bytes / 1024).toFixed(1)} KiB`;
  return { bytes, text: t("memory.note.size", { size: shown }) };
};
