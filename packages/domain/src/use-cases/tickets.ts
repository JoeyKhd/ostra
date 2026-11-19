import type { Ticket as TrackerTicket, TrackerWebhookHint } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import { agentProfileIdSchema, boardIdSchema, projectIdSchema, runnerIdSchema, taskIdSchema, ticketIdSchema } from "@ostra/protocol";
import type { BoardId, ExternalTicketId, SessionId, TaskId, TicketId, TicketWriteId } from "@ostra/protocol";
import { z } from "zod";

import type { MemberScope } from "../access.ts";
import type { Ports } from "../ports.ts";
import { notYet } from "./common.ts";
import type { UseCaseResult } from "./common.ts";
import type { ConnectionTracker } from "./linear-connection.ts";

// Tickets in (F-010, F-042, F-064, F-097, spec section 4, "A ticket change" and "A ticket becomes a
// task"). A ticket's text is untrusted throughout: it's data in the cache and the prompt, never a
// log line, never a shell argument.

// ---------- ingest (ticket 14) ----------

/** What `ingestTicketHint` was handed: a webhook's hint, or a poll's ticket. */
export type TicketChange =
  | { readonly source: "webhook"; readonly hint: TrackerWebhookHint }
  | { readonly source: "poll"; readonly boardId: BoardId; readonly ticket: TrackerTicket };

export type IngestTicketHintResult = UseCaseResult<
  {
    readonly outcome:
      | "upserted"
      /** The connection's own app user made the change: recorded, not acted on. */
      | "own-echo"
      /** The ticket is on no board of this organization. */
      | "not-on-a-board"
      /** The tracker says the ticket is gone, or left the board: `removedAt` set. */
      | "removed";
    readonly ticketIds: readonly TicketId[];
    readonly externalId: ExternalTicketId | null;
  },
  "tracker-failed" | "rate-limited"
>;

export type IngestTicketHintDeps = Pick<Ports, "notices" | "clock"> & {
  readonly db: Db;
  readonly tracker: ConnectionTracker;
};

/**
 * Reads the ticket a hint names through the adapter (the hint is never trusted for content), and
 * upserts its cache row on every board of the connection that holds it, by the board and the
 * stable ID, never by the key.
 */
export type IngestTicketHint = (deps: IngestTicketHintDeps, change: TicketChange) => Promise<IngestTicketHintResult>;

export const ingestTicketHint: IngestTicketHint = () => notYet("14");

// ---------- start a task from a ticket (ticket 29) ----------

export const startTicketTaskInputSchema = z.strictObject({
  projectId: projectIdSchema,
  ticketId: ticketIdSchema,
  /** Defaults to `code`. */
  kind: z.enum(["code"]).optional(),
  /** Defaults to the project's default profile for the kind. */
  agentProfileId: agentProfileIdSchema.optional(),
  /** The member's own personal runner, or unset to pick from the project's pools. */
  runnerId: runnerIdSchema.optional(),
});
export type StartTicketTaskInput = z.infer<typeof startTicketTaskInputSchema>;

export type StartTicketTaskResult =
  | UseCaseResult<
      { readonly taskId: TaskId; readonly sessionId: SessionId; readonly branchName: string },
      | "not-found"
      | "forbidden"
      | "no-agent-profile"
      | "no-repo"
      | "runner-not-yours"
      | "provider-not-allowed-on-personal-runners"
      /** A repo's default branch requires signed commits (F-055). */
      | "repo-unsupported"
    >
  /** One active code task per ticket per project: the one there is (spec section 11, item 12). */
  | { readonly ok: false; readonly error: "ticket-has-task"; readonly message: string; readonly taskId: TaskId };

export type StartTicketTaskDeps = Pick<Ports, "jobs" | "notices" | "audit" | "clock"> & {
  readonly tx: Tx;
  readonly scope: MemberScope;
};

/**
 * Creates the task (source `ticket`, the ticket's ID and key, the branch with the key) under the
 * partial unique index, writes the ticket's "started" writes to the outbox, and enqueues
 * `ticket.fetch-context`, which renders the prompt and dispatches.
 */
export type StartTicketTask = (deps: StartTicketTaskDeps, input: StartTicketTaskInput) => Promise<StartTicketTaskResult>;

export const startTicketTask: StartTicketTask = () => notYet("29");

// ---------- "Create ticket" (F-097, ticket 29) ----------

export const createTicketForTaskInputSchema = z.strictObject({
  taskId: taskIdSchema,
  boardId: boardIdSchema,
  /** Defaults to the task's title. */
  title: z.string().trim().min(1).max(512).optional(),
  /** Defaults to the task's prompt. Untrusted text, never logged. */
  description: z.string().max(262_144).optional(),
});
export type CreateTicketForTaskInput = z.infer<typeof createTicketForTaskInputSchema>;

export type CreateTicketForTaskResult = UseCaseResult<
  { readonly ticketWriteId: TicketWriteId },
  "not-found" | "forbidden" | "already-has-ticket" | "not-a-prompt-task"
>;

/** Writes a `create` ticket write; `ticket.sync` makes the ticket and links the task to it. */
export type CreateTicketForTask = (deps: StartTicketTaskDeps, input: CreateTicketForTaskInput) => Promise<CreateTicketForTaskResult>;

export const createTicketForTask: CreateTicketForTask = () => notYet("29");
