import { requireOrganizationAdmin, requireProjectAccess } from "@ostra/domain";
import type { MemberScope, ProjectNeed, ProjectRole } from "@ostra/domain";
import type { DbOrTx } from "@ostra/db";
import { initTRPC, TRPCError } from "@trpc/server";
import type { TRPC_ERROR_CODE_KEY } from "@trpc/server";
import { projectIdSchema, taskIdSchema } from "@ostra/protocol";
import type { OrganizationId, ProjectId, TaskId } from "@ostra/protocol";
import type { z } from "zod";

import type { Context } from "./context.ts";

// tRPC 11 setup (ticket 30). Four procedure helpers, each one stricter than the one before:
//
// - `publicProcedure`: no session.
// - `memberProcedure`: a signed-in member of an organization. `ctx.scope` is their scope: every
//   query takes it, and no query takes an organization ID from the caller (ADR 0026). An account
//   that still has its seeded default password gets `FORBIDDEN` until it changes it (F-001),
//   unless the install allows the default password.
// - `adminProcedure`: an organization admin.
// - `projectProcedure(need, input)`: a member who may read or administer one project. Another
//   organization's project, and a restricted one the member isn't on, are `NOT_FOUND`: their
//   existence doesn't leak. A member without the project role gets `FORBIDDEN`.

const t = initTRPC.context<Context>().create({
  // A stack trace never goes to a browser.
  isDev: false,
  // ADR 0035: the stream sends a named ping every 15 s, and the client reconnects (from the last
  // committed seq) after 20 s without a frame of any kind.
  sse: {
    ping: { enabled: true, intervalMs: 15_000 },
    client: { reconnectAfterInactivityMs: 20_000 },
  },
});

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;
export const publicProcedure = t.procedure;

const requireSignedIn = t.middleware(({ ctx, next }) => {
  if (ctx.user === null) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in first" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const authedProcedure = publicProcedure.use(requireSignedIn);

/** The refusal an account with the default password gets from every member procedure (F-001). */
export const PASSWORD_CHANGE_REQUIRED = "Choose a new password first: this account still has the default one";

const requireMember = t.middleware(({ ctx, next }) => {
  if (ctx.user === null) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in first" });
  }
  if (ctx.member === null) {
    throw new TRPCError({ code: "FORBIDDEN", message: "This account belongs to no organization" });
  }
  if (ctx.user.mustChangePassword && !ctx.deps.settings.allowDefaultPassword) {
    throw new TRPCError({ code: "FORBIDDEN", message: PASSWORD_CHANGE_REQUIRED });
  }
  return next({ ctx: { ...ctx, user: ctx.user, scope: ctx.member.scope } });
});

/** A signed-in member of an organization: `ctx.scope` is their scope. */
export const memberProcedure = publicProcedure.use(requireMember);

/** An organization admin. */
export const adminProcedure = memberProcedure.use(({ ctx, next }) => {
  const checked = requireOrganizationAdmin(ctx.scope, ctx.scope.organizationId);
  if (!checked.ok) {
    throw denied(checked.code, "organization");
  }
  return next();
});

/**
 * The instance admin (Q102), apart from an organization admin: the install's own settings, such as
 * its retention and its storage, are theirs. The first admin is both (F-001).
 */
export const instanceAdminProcedure = memberProcedure.use(({ ctx, next }) => {
  if (!ctx.user.instanceAdmin) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only an instance admin may do this" });
  }
  return next();
});

/** An `AccessDenied` code as the tRPC error a caller sees. */
export const denied = (code: "not-found" | "forbidden", what: string): TRPCError =>
  code === "not-found"
    ? new TRPCError({ code: "NOT_FOUND", message: `No such ${what}` })
    : new TRPCError({ code: "FORBIDDEN", message: `You may not do this in this ${what}` });

/** What a project procedure's handler gets beside the scope. */
export type ProjectAccess = {
  readonly projectId: ProjectId;
  readonly organizationId: OrganizationId;
  readonly role: ProjectRole;
};

/**
 * A procedure on one project: `schema`'s input must hold `projectId`. The project is read inside
 * the member's organization only, then checked with the domain's access rules.
 */
export const projectProcedure = <S extends z.ZodType<{ readonly projectId: ProjectId }>>(need: ProjectNeed, schema: S) =>
  memberProcedure.input(schema).use(async ({ ctx, input, next }) => {
    const access = await loadProjectAccess(ctx.deps.db, ctx.scope, input.projectId, need);
    return next({ ctx: { ...ctx, project: access } });
  });

/** Loads a project inside the scope's organization and applies `requireProjectAccess`. */
export const loadProjectAccess = async (
  db: DbOrTx,
  scope: MemberScope,
  projectId: ProjectId,
  need: ProjectNeed,
): Promise<ProjectAccess> => {
  const row = await db.project.findFirst({
    where: { id: projectId, organizationId: scope.organizationId },
    select: { id: true, access: true },
  });
  if (row === null) {
    throw denied("not-found", "project");
  }
  const checked = requireProjectAccess(
    scope,
    { id: projectIdSchema.parse(row.id), organizationId: scope.organizationId, access: row.access },
    need,
  );
  if (!checked.ok) {
    throw denied(checked.code, "project");
  }
  return { projectId: checked.value.project.id, organizationId: scope.organizationId, role: checked.value.role };
};

/** What a task procedure's handler gets: the task, inside a project the member may use. */
export type TaskAccess = { readonly taskId: TaskId; readonly projectId: ProjectId };

/**
 * A procedure on one task: the input schema must hold `taskId`. The task is read inside the
 * member's organization only, then its project is checked like `projectProcedure` does. Another
 * organization's task, and one in a restricted project the member isn't on, are `NOT_FOUND`.
 */
export const taskProcedure = <S extends z.ZodType<{ readonly taskId: TaskId }>>(need: ProjectNeed, schema: S) =>
  memberProcedure.input(schema).use(async ({ ctx, input, next }) => {
    const row = await ctx.deps.db.task.findFirst({
      where: { id: input.taskId, organizationId: ctx.scope.organizationId },
      select: { id: true, projectId: true },
    });
    if (row === null) {
      throw denied("not-found", "task");
    }
    let access: ProjectAccess;
    try {
      access = await loadProjectAccess(ctx.deps.db, ctx.scope, projectIdSchema.parse(row.projectId), need);
    } catch (error) {
      // The caller asked about a task, not a project: say so.
      if (error instanceof TRPCError && error.code === "NOT_FOUND") {
        throw denied("not-found", "task");
      }
      throw error;
    }
    return next({ ctx: { ...ctx, project: access, task: { taskId: taskIdSchema.parse(row.id), projectId: access.projectId } } });
  });

type Failure<E extends string> = { readonly ok: false; readonly error: E; readonly message: string };

/**
 * Unwraps a use case's result: the value, or the tRPC error its failure maps to. Each router gives
 * a total map of its use case's errors, so a new error is a type error here until it is mapped.
 */
export const unwrap = <S extends { readonly ok: true }, E extends string>(
  result: S | Failure<E>,
  codes: Readonly<Record<E, TRPC_ERROR_CODE_KEY>>,
): S => {
  if (result.ok) {
    return result;
  }
  throw new TRPCError({ code: codes[result.error], message: result.message });
};
