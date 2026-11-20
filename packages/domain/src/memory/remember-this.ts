import type { DiffCommentId, FindingId, MemberId, MemoryKind, MemoryScope, ProjectId, TaskId } from "@ostra/protocol";
import { runnerLimits, utf8ByteLength } from "@ostra/protocol";

// "Remember this" (F-111, ADR 0044 amended, Q205): a member turns a diff comment, an accepted
// `@ostra` PR comment, or (milestone 6, F-100) an AI review's finding, into a proposal. The member edits it before it's proposed; this is the
// starting text, which then goes through the secret scan like any other proposal. Pure.

export type RememberThisSource =
  | {
      readonly kind: "diff_comment";
      readonly commentId: DiffCommentId;
      readonly path: string;
      readonly line: number;
      /** The comment's text. Never logged. */
      readonly body: string;
    }
  | {
      readonly kind: "pr_comment";
      /** The comment's URL on the code host. */
      readonly url: string;
      /** The comment's text. Never logged. */
      readonly body: string;
    }
  | {
      /** Milestone 6 (F-111, ticket 17): a finding of the task's AI review. */
      readonly kind: "ai_finding";
      readonly findingId: FindingId;
      /** The finding's text. Never logged. */
      readonly body: string;
    };

/** What a proposal names as its source: the diff comment's ID, the PR comment's URL, or the finding's ID. */
export const rememberThisSourceRef = (source: RememberThisSource): string => {
  switch (source.kind) {
    case "diff_comment":
      return source.commentId;
    case "pr_comment":
      return source.url;
    case "ai_finding":
      return source.findingId;
    default:
      return source satisfies never;
  }
};

export type RememberThisDraft = {
  readonly title: string;
  readonly body: string;
  readonly kind: MemoryKind;
  readonly scope: MemoryScope;
  readonly projectId: ProjectId;
  readonly sourceKind: RememberThisSource["kind"];
  /** The diff comment's ID, the PR comment's URL, or the finding's ID. */
  readonly sourceRef: string;
  readonly taskId: TaskId;
  readonly proposedByMemberId: MemberId;
};

const firstLine = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[#>*\-\s]+/, "").trim())
    .find((line) => line !== "") ?? "";

/** Cuts text to `max` characters, with `…` at the end when it was cut. */
const cutChars = (text: string, max: number): string => {
  const chars: string[] = [];
  for (const char of text) {
    chars.push(char);
  }
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
};

/** Cuts text to `max` UTF-8 bytes on a character boundary. */
const cutBytes = (text: string, max: number): string => {
  if (utf8ByteLength(text) <= max) {
    return text;
  }
  let out = "";
  for (const char of text) {
    if (utf8ByteLength(`${out}${char}…`) > max) {
      break;
    }
    out += char;
  }
  return `${out}…`;
};

/**
 * The proposal a comment starts: a project note, kind `convention`, its title the comment's first
 * line and its body the comment, within the note's limits, with the comment as its source.
 */
export const rememberThis = (input: {
  readonly source: RememberThisSource;
  readonly projectId: ProjectId;
  readonly taskId: TaskId;
  readonly memberId: MemberId;
}): RememberThisDraft | { readonly error: "empty" } => {
  const body = input.source.body.trim();
  const title = firstLine(body);
  if (title === "") {
    return { error: "empty" };
  }
  return {
    title: cutChars(title, runnerLimits.memoryNoteTitleMaxChars),
    body: cutBytes(body, runnerLimits.memoryNoteBodyMaxBytes),
    kind: "convention",
    scope: "project",
    projectId: input.projectId,
    sourceKind: input.source.kind,
    sourceRef: rememberThisSourceRef(input.source),
    taskId: input.taskId,
    proposedByMemberId: input.memberId,
  };
};
