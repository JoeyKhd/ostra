import type { DbEnum } from "@ostra/db";
import type { FileLeftOutReason, MessageFileKind, SessionId, TaskId } from "@ostra/protocol";

import { moveTo, refuse } from "./transition.ts";
import type { Transition } from "./transition.ts";

// Milestone 9's file lifecycles (spec section 5.4, ticket 05; ADR 0070; domain-model.md, "Files for
// the agent"). Each is a discriminated union with its transitions, and every switch is exhaustive.
// The state names come from the schema's enums (milestone 9's migration).

// ---------- a member's file ----------

/**
 * A member's upload: `uploaded` (the member's, in a project, no task's) until a message takes it,
 * `sent` (its task's, at its place in the box), or `expired` when no message took it within a day
 * (`files.sweep-unsent`, which deletes its blobs), or at once when its member removes it before
 * sending (`discardUpload`, ticket 14: the sweep's next pass deletes its blobs).
 */
export type MemberFileLifecycle =
  | { readonly state: Extract<DbEnum.MessageFileState, "uploaded"> }
  | {
      readonly state: Extract<DbEnum.MessageFileState, "sent">;
      readonly taskId: TaskId;
      readonly sessionId: SessionId;
      /** The `user.message`'s number in the task's log: its folder, `attachments/<n>/`. */
      readonly eventSeq: number;
      readonly position: number;
      readonly boxPath: string;
      readonly asImage: boolean;
      readonly at: number;
    }
  | { readonly state: Extract<DbEnum.MessageFileState, "expired">; readonly at: number };

export type MemberFileInput =
  /** A message took it (`bindMessageFilesInTx`). */
  | {
      readonly type: "send";
      readonly taskId: TaskId;
      readonly sessionId: SessionId;
      readonly eventSeq: number;
      readonly position: number;
      readonly boxPath: string;
      readonly asImage: boolean;
      readonly at: number;
    }
  /** The sweep found it unsent past its day, or its member removed it before sending (`discardUpload`). */
  | { readonly type: "expire"; readonly at: number };

export const transitionMemberFile = (file: MemberFileLifecycle, input: MemberFileInput): Transition<MemberFileLifecycle> => {
  switch (file.state) {
    case "uploaded":
      switch (input.type) {
        case "send":
          return moveTo({
            state: "sent",
            taskId: input.taskId,
            sessionId: input.sessionId,
            eventSeq: input.eventSeq,
            position: input.position,
            boxPath: input.boxPath,
            asImage: input.asImage,
            at: input.at,
          });
        case "expire":
          return moveTo({ state: "expired", at: input.at });
        default:
          return input satisfies never;
      }
    case "sent":
    case "expired":
      return refuse(input, file.state);
    default:
      return file satisfies never;
  }
};

// ---------- a ticket's file ----------

/** Why a ticket's file failed: its download, or its bytes once they came. */
export type TicketFileFailure = Extract<FileLeftOutReason, "download-failed" | "unreadable">;

/** Why a ticket's file was left out: over the ticket's limits, or not fetched by the tracker's capability. */
export type TicketFileLeftOut = Extract<FileLeftOutReason, "too-big" | "too-many" | "total-too-big" | "not-fetched">;

/**
 * A ticket's file, as one read of the ticket made it: `sent` (fetched, in the box at
 * `ticket/<name>`), `left_out` (over a limit, or not fetched) or `failed` (its download failed).
 * A `failed` one's Retry makes a new file (`retryOfId`), once: the failed one keeps its record.
 */
export type TicketFileLifecycle =
  | { readonly state: Extract<DbEnum.MessageFileState, "sent">; readonly boxPath: string; readonly asImage: boolean }
  | { readonly state: Extract<DbEnum.MessageFileState, "left_out">; readonly reason: TicketFileLeftOut }
  | { readonly state: Extract<DbEnum.MessageFileState, "failed">; readonly reason: TicketFileFailure; readonly retried: boolean };

export type TicketFileInput =
  /** A member pressed Retry: a new file fetches it again, and this one is retried. */
  { readonly type: "retry" };

export const transitionTicketFile = (file: TicketFileLifecycle, input: TicketFileInput): Transition<TicketFileLifecycle> => {
  switch (file.state) {
    case "failed":
      // `retry`, the one input: once.
      return file.retried ? refuse(input, "failed, retried") : moveTo({ ...file, retried: true });
    case "sent":
    case "left_out":
      return refuse(input, file.state);
    default:
      return file satisfies never;
  }
};

/** What a fetch of a ticket's file came to: its bytes in the box, left out, or failed. */
export type TicketFileOutcome =
  | { readonly type: "fetched"; readonly boxPath: string; readonly asImage: boolean }
  | { readonly type: "left-out"; readonly reason: TicketFileLeftOut }
  | { readonly type: "failed"; readonly reason: TicketFileFailure };

/** A ticket's file as its fetch made it. */
export const ticketFileOf = (outcome: TicketFileOutcome): TicketFileLifecycle => {
  switch (outcome.type) {
    case "fetched":
      return { state: "sent", boxPath: outcome.boxPath, asImage: outcome.asImage };
    case "left-out":
      return { state: "left_out", reason: outcome.reason };
    case "failed":
      return { state: "failed", reason: outcome.reason, retried: false };
    default:
      return outcome satisfies never;
  }
};

// ---------- a file's text (F-150) ----------

/**
 * A file's text: `ready` (read by core, beside the file as `<name>.md`), `none` (a kind with no
 * text to read: an image, a text file, any other file), `failed` (a document core couldn't read,
 * with the reader's code; the file is still attached) or `off` (the install reads no text,
 * `OSTRA_FILE_TEXT_EXTRACTION=false`). Set once, when the file comes in.
 */
export type FileTextLifecycle =
  | { readonly state: Extract<DbEnum.FileTextState, "none"> }
  | { readonly state: Extract<DbEnum.FileTextState, "off"> }
  | { readonly state: Extract<DbEnum.FileTextState, "ready">; readonly words: number; readonly truncated: boolean }
  | { readonly state: Extract<DbEnum.FileTextState, "failed">; readonly reason: string };

/** What core's reader made of a document (ticket 07's `extractText`): its text, or why none. */
export type TextReading = { readonly state: "ready"; readonly words: number; readonly truncated: boolean } | { readonly state: "failed"; readonly reason: string };

/**
 * A file's text state, from its kind, the install's switch and, for a document read, the reader's
 * answer. Only a `document` has text to read; with reading off, a document's is `off` and the
 * reader is never asked (`reading` is ignored).
 */
export const fileTextOf = (input: { readonly kind: MessageFileKind; readonly extraction: boolean; readonly reading: TextReading | null }): FileTextLifecycle => {
  switch (input.kind) {
    case "image":
    case "text":
    case "file":
      return { state: "none" };
    case "document":
      if (!input.extraction) {
        return { state: "off" };
      }
      if (input.reading === null) {
        return { state: "failed", reason: "not-read" };
      }
      return input.reading.state === "ready"
        ? { state: "ready", words: input.reading.words, truncated: input.reading.truncated }
        : { state: "failed", reason: input.reading.reason };
    default:
      return input.kind satisfies never;
  }
};

/** Whether core reads a file's text when it comes in: a document, on an install that reads text. */
export const readsTextOf = (kind: MessageFileKind, extraction: boolean): boolean => kind === "document" && extraction;
