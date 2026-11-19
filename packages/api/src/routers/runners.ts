import { processContainmentFromDb } from "@ostra/db";
import type { Db } from "@ostra/db";
import { approveRunner, rejectRunner, revokeRunner, revokeRunnerInputSchema } from "@ostra/domain";
import { memberIdSchema, poolIdSchema, runnerIdSchema } from "@ostra/protocol";
import type { RunnerId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { adminProcedure, memberProcedure, router, unwrap } from "../trpc/init.ts";

// F-013, F-014, F-091 (first slice), ticket 33: runners, runner pools and their join tokens. A
// personal runner shows as "personal, not isolated" in the panel (ADR 0029). Join tokens are shown
// once, when they are made, and are stored hashed: no procedure returns one again.

const osSchema = z.object({ platform: z.string(), arch: z.string(), release: z.string() }).nullable();

const parseOs = (value: unknown) => {
  const parsed = osSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const runnerRowSelect = {
  id: true,
  kind: true,
  name: true,
  executor: true,
  processContainment: true,
  capacity: true,
  labels: true,
  version: true,
  os: true,
  state: true,
  lastSeenAt: true,
  createdAt: true,
  /** Boxes in use: the runner's active leases (F-092). */
  _count: { select: { leases: { where: { state: "active" } } } },
} as const;

/**
 * An approve or a reject of a runner that isn't joining any more: its state as it is, unchanged.
 * Another organization's runner, or none, is `NOT_FOUND`.
 */
const decidedAlready = async (db: Db, organizationId: string, runnerId: RunnerId, error: "not-found" | "not-joining") => {
  const row = error === "not-found" ? null : await db.runner.findFirst({ where: { id: runnerId, organizationId }, select: { state: true } });
  if (row === null) {
    throw new TRPCError({ code: "NOT_FOUND", message: "No such runner" });
  }
  return { runnerId, state: row.state, changed: false };
};

export const runnersRouter = router({
  /** The member's own personal runners: the "run on" picker and the checklist's "runner online" step. */
  mine: memberProcedure.query(async ({ ctx }) => {
    const rows = await ctx.deps.db.runner.findMany({
      where: { organizationId: ctx.scope.organizationId, kind: "personal", ownerMemberId: ctx.scope.memberId, state: { not: "revoked" } },
      orderBy: { createdAt: "asc" },
      select: runnerRowSelect,
    });
    return rows.map((row) => ({
      id: runnerIdSchema.parse(row.id),
      name: row.name,
      kind: row.kind,
      executor: row.executor,
      /** A `host` runner runs the agent as a process on the machine: "personal, not isolated". */
      isolated: row.executor !== "host",
      /** How it ends a task's processes, as its status said (ticket 42); `null` before it said. */
      processContainment: row.processContainment === null ? null : processContainmentFromDb[row.processContainment],
      state: row.state,
      capacity: row.capacity,
      labels: row.labels,
      version: row.version,
      os: parseOs(row.os),
      lastSeenAt: row.lastSeenAt === null ? null : row.lastSeenAt.getTime(),
      busy: row._count.leases,
    }));
  }),

  /** Every runner of the organization, for admins: pool and personal. */
  list: adminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.deps.db.runner.findMany({
      where: { organizationId: ctx.scope.organizationId },
      orderBy: [{ kind: "asc" }, { createdAt: "asc" }],
      select: {
        ...runnerRowSelect,
        pool: { select: { id: true, name: true } },
        owner: { select: { id: true, user: { select: { name: true } } } },
      },
    });
    return rows.map((row) => ({
      id: runnerIdSchema.parse(row.id),
      name: row.name,
      kind: row.kind,
      executor: row.executor,
      isolated: row.executor !== "host",
      processContainment: row.processContainment === null ? null : processContainmentFromDb[row.processContainment],
      state: row.state,
      capacity: row.capacity,
      labels: row.labels,
      version: row.version,
      os: parseOs(row.os),
      lastSeenAt: row.lastSeenAt === null ? null : row.lastSeenAt.getTime(),
      busy: row._count.leases,
      pool: row.pool === null ? null : { id: poolIdSchema.parse(row.pool.id), name: row.pool.name },
      owner: row.owner === null ? null : { memberId: memberIdSchema.parse(row.owner.id), name: row.owner.user.name },
    }));
  }),

  /**
   * An admin approves a runner that joined a pool requiring approval (F-091, Q130): online at once
   * when it's connected, else at its next connection. A runner already approved or revoked answers
   * the same, with `changed: false`, and nothing changes.
   */
  approve: adminProcedure.input(z.strictObject({ runnerId: runnerIdSchema })).mutation(async ({ ctx, input }) => {
    const { db, ports } = ctx.deps;
    const result = await db.$transaction((tx) =>
      approveRunner(
        { tx, notices: ports.notices, audit: ports.audit, clock: ports.clock },
        { organizationId: ctx.scope.organizationId, runnerId: input.runnerId, memberId: ctx.scope.memberId },
      ),
    );
    if (!result.ok) {
      return decidedAlready(ctx.deps.db, ctx.scope.organizationId, input.runnerId, result.error);
    }
    ctx.deps.logger.info("runner.approved", { runnerId: input.runnerId, state: result.state });
    return { runnerId: input.runnerId, state: result.state, changed: true };
  }),

  /**
   * An admin rejects a joining runner: revoked, and disconnected with 4403 when it's connected
   * (F-091, Q130). A runner already approved or revoked answers the same, and nothing changes.
   */
  reject: adminProcedure.input(z.strictObject({ runnerId: runnerIdSchema })).mutation(async ({ ctx, input }) => {
    const { db, ports } = ctx.deps;
    const result = await db.$transaction((tx) =>
      rejectRunner(
        { tx, notices: ports.notices, audit: ports.audit, clock: ports.clock },
        { organizationId: ctx.scope.organizationId, runnerId: input.runnerId, memberId: ctx.scope.memberId },
      ),
    );
    if (!result.ok) {
      return decidedAlready(ctx.deps.db, ctx.scope.organizationId, input.runnerId, result.error);
    }
    ctx.deps.logger.info("runner.rejected", { runnerId: input.runnerId, connected: result.wasConnected });
    return { runnerId: input.runnerId, state: result.state, changed: true };
  }),

  /**
   * Revokes a runner at once (Q131, ticket 41): an organization admin, any runner of it; a member,
   * a personal runner they own. Its connection closes with 4403, its leases end, and each task it
   * held stops as `runner_lost`, ready to reopen elsewhere. A runner already revoked answers the
   * same and changes nothing. The row's `busy` count is how many tasks the confirm says it stops.
   */
  revoke: memberProcedure.input(revokeRunnerInputSchema).mutation(async ({ ctx, input }) => {
    const { db, ports } = ctx.deps;
    const result = await db.$transaction((tx) => revokeRunner({ tx, scope: ctx.scope, notices: ports.notices, audit: ports.audit, clock: ports.clock, jobs: ports.jobs }, input), {
      timeout: 30_000,
    });
    const revoked = unwrap(result, { "not-found": "NOT_FOUND", forbidden: "FORBIDDEN" });
    return { runnerId: revoked.runnerId, alreadyRevoked: revoked.alreadyRevoked, stoppedTasks: revoked.stoppedTaskIds.length };
  }),
});
