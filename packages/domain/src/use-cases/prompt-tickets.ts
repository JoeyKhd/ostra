import type { Db, Tx } from "@ostra/db";
import { boardIdSchema, projectIdSchema } from "@ostra/protocol";
import type { BoardId, ProjectId } from "@ostra/protocol";
import { z } from "zod";

import { requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import type { Ports } from "../ports.ts";
import type { UseCaseResult } from "./common.ts";

// F-097 (Q31): a prompt task makes no ticket unless the project's setting for that is on, or a
// member uses "Create ticket" on the task once. The setting, "Make a ticket for every prompt task",
// is off by default and names the board the tickets go to: one of the project's attached boards,
// whose connection is active. While it's on, each code task a member starts from a prompt gets its
// ticket written as it starts, in the start's transaction, as "Create ticket" writes one. It's a
// project admin's to change, audited; detaching its board turns it off.

export const setPromptTicketsInputSchema = z.strictObject({
  projectId: projectIdSchema,
  /** The board each prompt task's ticket is made on, or `null` to turn the setting off. */
  boardId: boardIdSchema.nullable(),
});
export type SetPromptTicketsInput = z.infer<typeof setPromptTicketsInputSchema>;

export type SetPromptTicketsResult = UseCaseResult<{ readonly boardId: BoardId | null }, "not-found" | "forbidden" | "no-such-board">;

/** The board the project's prompt tasks get their tickets on, or `null` while the setting is off. */
export const promptTicketBoardInTx = async (tx: Pick<Tx, "board">, organizationId: string, projectId: ProjectId): Promise<BoardId | null> => {
  const board = await tx.board.findFirst({
    where: { organizationId, projectId, ticketsForPromptTasks: true, detachedAt: null, connection: { state: "active" } },
    select: { id: true },
  });
  return board === null ? null : boardIdSchema.parse(board.id);
};

/** Turns "Make a ticket for every prompt task" on with its board, or off: a project admin's, audited. */
export const setPromptTickets = (
  deps: { readonly db: Db } & Pick<Ports, "audit" | "notices">,
  scope: MemberScope,
  input: SetPromptTicketsInput,
): Promise<SetPromptTicketsResult> =>
  deps.db.$transaction(async (tx): Promise<SetPromptTicketsResult> => {
    // The project's row lock: two admins changing it take turns, so the one-board index holds.
    await tx.$queryRaw`SELECT 1 FROM "project" WHERE "id" = ${input.projectId} AND "organizationId" = ${scope.organizationId} FOR UPDATE`;
    const project = await tx.project.findFirst({ where: { id: input.projectId, organizationId: scope.organizationId }, select: { id: true, access: true } });
    if (project === null) {
      return { ok: false, error: "not-found", message: "No such project" };
    }
    const projectId = projectIdSchema.parse(project.id);
    const access = requireProjectAccess(scope, { id: projectId, organizationId: scope.organizationId, access: project.access }, "admin");
    if (!access.ok) {
      return access.code === "not-found"
        ? { ok: false, error: "not-found", message: "No such project" }
        : { ok: false, error: "forbidden", message: "Only a project admin changes which prompt tasks get a ticket" };
    }
    if (input.boardId !== null) {
      const board = await tx.board.findFirst({
        where: { id: input.boardId, organizationId: scope.organizationId, projectId, detachedAt: null, connection: { state: "active" } },
        select: { id: true },
      });
      if (board === null) {
        return { ok: false, error: "no-such-board", message: "That isn't one of this project's boards, or its tracker connection isn't active" };
      }
    }
    const current = await tx.board.findFirst({ where: { organizationId: scope.organizationId, projectId, ticketsForPromptTasks: true }, select: { id: true } });
    if ((current?.id ?? null) === input.boardId) {
      return { ok: true, boardId: input.boardId };
    }
    await tx.board.updateMany({ where: { organizationId: scope.organizationId, projectId, ticketsForPromptTasks: true }, data: { ticketsForPromptTasks: false } });
    if (input.boardId !== null) {
      await tx.board.update({ where: { id: input.boardId }, data: { ticketsForPromptTasks: true } });
    }
    await deps.audit.recordInTx(tx, {
      organizationId: scope.organizationId,
      projectId,
      actor: { kind: "member", id: scope.memberId },
      action: "project.prompt-tickets-set",
      entity: "project",
      entityId: projectId,
      data: { boardId: input.boardId },
    });
    await deps.notices.emitInTx(tx, { organizationId: scope.organizationId, projectId, entity: "project", entityId: projectId });
    return { ok: true, boardId: input.boardId };
  });
