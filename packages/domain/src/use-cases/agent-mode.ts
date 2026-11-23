import { Prisma } from "@ostra/db";
import { boardIdSchema, connectionIdSchema, projectIdSchema } from "@ostra/protocol";

import { requireOrganizationAdmin, requireProjectAccess } from "../access.ts";
import { isBoardAttached } from "../lifecycles/m11-trackers.ts";
import { missingAgentModeScopes } from "./linear-connection.ts";
import type { EnableAgentMode, SetBoardAgentMode } from "./m6-signatures.ts";

// Linear agent mode's switches (F-012, ADR 0013, ADR 0057; milestone 6's ticket 13). The install is
// re-authorized with agent mode's scopes by `createLinearAuthorizeUrl(..., { agentMode: true })` and
// its callback (`authorizeLinear`), which keeps the granted scopes and sets `agentModeAt`, or refuses
// a token without them. `enableAgentMode` is the same check on what is stored, for a connection
// whose token already has them. Both read the scopes from the tracker's own declaration
// (`agentSessions` and `agentScopes`), never a list of their own. "Start from Linear" is then a
// board's: one board per team in the organization (the partial unique index), so a delegation in a
// team has one project to start in.

/** Agent mode on for the connection: its stored token was granted agent mode's scopes. An organization admin's. */
export const enableAgentMode: EnableAgentMode = (deps, scope, input) =>
  deps.db.$transaction(async (tx) => {
    const admin = requireOrganizationAdmin(scope, scope.organizationId);
    if (!admin.ok) {
      return {
        ok: false,
        error: "forbidden",
        message: "Only an organization admin turns on agent mode",
      };
    }
    const connection = await tx.connection.findFirst({
      where: {
        id: input.connectionId,
        organizationId: scope.organizationId,
        kind: "linear",
        state: { not: "revoked" },
      },
      select: { id: true, scopes: true, agentModeAt: true },
    });
    if (connection === null) {
      return { ok: false, error: "not-found", message: "No such Linear connection" };
    }
    const missing = missingAgentModeScopes(deps.tracker, connection.scopes);
    if (missing === null) {
      return { ok: false, error: "unsupported", message: "This tracker has no agent sessions" };
    }
    if (missing.length > 0) {
      return {
        ok: false,
        error: "missing-scopes",
        message: "The app's token lacks agent mode's scopes: authorize it again with them",
      };
    }
    if (connection.agentModeAt !== null) {
      return { ok: true, agentModeAt: connection.agentModeAt.getTime() };
    }
    const now = deps.clock.now();
    await tx.connection.update({
      where: { id: connection.id },
      data: { agentModeAt: new Date(now) },
    });
    const connectionId = connectionIdSchema.parse(connection.id);
    await deps.audit.recordInTx(tx, {
      organizationId: scope.organizationId,
      projectId: null,
      actor: { kind: "member", id: scope.memberId },
      action: "linear.agent-mode-enabled",
      entity: "connection",
      entityId: connectionId,
    });
    await deps.notices.emitInTx(tx, {
      organizationId: scope.organizationId,
      projectId: null,
      entity: "connection",
      entityId: connectionId,
    });
    return { ok: true, agentModeAt: now };
  });

/** Whether an error is the one-agent-mode-board-per-team index refusing a second board. */
const isTeamTaken = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

/** "Start from Linear" on a board: its project's admin's switch, one board per team. */
export const setBoardAgentMode: SetBoardAgentMode = async (deps, scope, input) => {
  try {
    return await deps.db.$transaction(async (tx) => {
      const board = await tx.board.findFirst({
        where: { id: input.boardId, organizationId: scope.organizationId },
        select: {
          id: true,
          projectId: true,
          connectionId: true,
          externalId: true,
          agentMode: true,
          detachedAt: true,
          project: { select: { access: true } },
          connection: { select: { kind: true, agentModeAt: true, state: true } },
        },
      });
      if (board === null) {
        return { ok: false, error: "not-found", message: "No such board" };
      }
      const projectId = projectIdSchema.parse(board.projectId);
      const access = requireProjectAccess(
        scope,
        { id: projectId, organizationId: scope.organizationId, access: board.project.access },
        "admin",
      );
      if (!access.ok) {
        return access.code === "not-found"
          ? { ok: false, error: "not-found", message: "No such board" }
          : { ok: false, error: "forbidden", message: "Only a project admin changes this" };
      }
      if (
        input.on &&
        (board.connection.kind !== "linear" ||
          board.connection.agentModeAt === null ||
          !isBoardAttached(board, board.connection))
      ) {
        return {
          ok: false,
          error: "agent-mode-off",
          message: "Agent mode isn't on for this board's Linear connection",
        };
      }
      if (input.on) {
        const taken = await tx.board.findFirst({
          where: {
            organizationId: scope.organizationId,
            connectionId: board.connectionId,
            externalId: board.externalId,
            agentMode: true,
            id: { not: board.id },
          },
          select: { project: { select: { name: true } } },
        });
        if (taken !== null) {
          return {
            ok: false,
            error: "team-taken",
            message: `This team already starts tasks in the project ${taken.project.name}`,
          };
        }
      }
      if (board.agentMode !== input.on) {
        await tx.board.update({ where: { id: board.id }, data: { agentMode: input.on } });
        await deps.audit.recordInTx(tx, {
          organizationId: scope.organizationId,
          projectId,
          actor: { kind: "member", id: scope.memberId },
          action: "board.agent-mode-changed",
          entity: "project",
          entityId: projectId,
          data: { boardId: boardIdSchema.parse(board.id), on: input.on },
        });
        await deps.notices.emitInTx(tx, {
          organizationId: scope.organizationId,
          projectId,
          entity: "project",
          entityId: projectId,
        });
      }
      return { ok: true, on: input.on };
    });
  } catch (error) {
    if (isTeamTaken(error)) {
      // Two admins switched on two boards of one team at once: the index kept one.
      return {
        ok: false,
        error: "team-taken",
        message: "This team already starts tasks in another project",
      };
    }
    throw error;
  }
};
