import { generateJoinToken, hashJoinToken } from "@ostra/domain";
import { joinTokenIdSchema, memberIdSchema, poolIdSchema, runnerIdSchema } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { adminProcedure, memberProcedure, router } from "../trpc/init.ts";

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
});

const poolName = z.string().trim().min(1).max(64);

export const poolsRouter = router({
  /**
   * The organization's runner pools, with their runners and projects counted: the boxes in use and
   * the slots of the runners that take work (online or draining), the executors and versions its
   * runners run, and the first project that uses it, by name.
   */
  list: adminProcedure.query(async ({ ctx }) => {
    const organizationId = ctx.scope.organizationId;
    const pools = await ctx.deps.db.runnerPool.findMany({
      where: { organizationId },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
      include: {
        _count: { select: { projectPools: true } },
        runners: {
          where: { state: { not: "revoked" } },
          select: { state: true, capacity: true, executor: true, version: true, _count: { select: { leases: { where: { state: "active" } } } } },
        },
        joinTokens: { where: { revokedAt: null }, select: { id: true } },
        projectPools: { orderBy: { project: { name: "asc" } }, take: 1, select: { project: { select: { name: true } } } },
      },
    });
    return pools.map((pool) => {
      const working = pool.runners.filter((runner) => runner.state === "online" || runner.state === "draining");
      return {
        id: poolIdSchema.parse(pool.id),
        name: pool.name,
        isDefault: pool.isDefault,
        requiresApproval: pool.requiresApproval,
        maxBoxes: pool.maxBoxes,
        runnerCount: pool.runners.length,
        onlineCount: pool.runners.filter((runner) => runner.state === "online").length,
        projectCount: pool._count.projectPools,
        firstProjectName: pool.projectPools[0]?.project.name ?? null,
        activeJoinTokens: pool.joinTokens.length,
        /** Boxes in use on the runners that take work, and their summed capacity (F-092). */
        busy: working.reduce((sum, runner) => sum + runner._count.leases, 0),
        slots: working.reduce((sum, runner) => sum + runner.capacity, 0),
        executors: [...new Set(pool.runners.map((runner) => runner.executor))].sort((x, y) => x.localeCompare(y)),
        versions: [...new Set(pool.runners.map((runner) => runner.version))].sort((x, y) => x.localeCompare(y, "en", { numeric: true })),
      };
    });
  }),

  create: adminProcedure
    .input(z.strictObject({ name: poolName, requiresApproval: z.boolean().default(false), maxBoxes: z.number().int().positive().max(100_000).nullable().default(null) }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      return db.$transaction(async (tx) => {
        if ((await tx.runnerPool.count({ where: { organizationId, name: input.name } })) > 0) {
          throw new TRPCError({ code: "CONFLICT", message: "A pool with that name exists" });
        }
        const pool = await tx.runnerPool.create({
          data: { organizationId, name: input.name, requiresApproval: input.requiresApproval, maxBoxes: input.maxBoxes },
          select: { id: true },
        });
        const poolId = poolIdSchema.parse(pool.id);
        await ports.audit.recordInTx(tx, { organizationId, projectId: null, actor: { kind: "member", id: ctx.scope.memberId }, action: "pool.created", entity: "runner-pool", entityId: poolId });
        await ports.notices.emitInTx(tx, { organizationId, projectId: null, entity: "runner-pool", entityId: poolId });
        return { poolId };
      });
    }),

  update: adminProcedure
    .input(
      z.strictObject({
        poolId: poolIdSchema,
        name: poolName.optional(),
        requiresApproval: z.boolean().optional(),
        maxBoxes: z.number().int().positive().max(100_000).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      return db.$transaction(async (tx) => {
        const pool = await tx.runnerPool.findFirst({ where: { id: input.poolId, organizationId }, select: { id: true } });
        if (pool === null) {
          throw new TRPCError({ code: "NOT_FOUND", message: "No such pool" });
        }
        if (input.name !== undefined && (await tx.runnerPool.count({ where: { organizationId, name: input.name, NOT: { id: pool.id } } })) > 0) {
          throw new TRPCError({ code: "CONFLICT", message: "A pool with that name exists" });
        }
        await tx.runnerPool.update({
          where: { id: pool.id },
          data: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.requiresApproval === undefined ? {} : { requiresApproval: input.requiresApproval }),
            ...(input.maxBoxes === undefined ? {} : { maxBoxes: input.maxBoxes }),
          },
        });
        await ports.audit.recordInTx(tx, { organizationId, projectId: null, actor: { kind: "member", id: ctx.scope.memberId }, action: "pool.updated", entity: "runner-pool", entityId: input.poolId });
        await ports.notices.emitInTx(tx, { organizationId, projectId: null, entity: "runner-pool", entityId: input.poolId });
        return { poolId: input.poolId };
      });
    }),

  /** A pool's join tokens: when made and used, never the token or its hash. */
  joinTokens: adminProcedure.input(z.strictObject({ poolId: poolIdSchema })).query(async ({ ctx, input }) => {
    const organizationId = ctx.scope.organizationId;
    const pool = await ctx.deps.db.runnerPool.findFirst({ where: { id: input.poolId, organizationId }, select: { id: true } });
    if (pool === null) {
      throw new TRPCError({ code: "NOT_FOUND", message: "No such pool" });
    }
    const rows = await ctx.deps.db.joinToken.findMany({
      where: { poolId: pool.id, organizationId },
      orderBy: { createdAt: "desc" },
      select: { id: true, label: true, bootstrap: true, createdAt: true, expiresAt: true, revokedAt: true, lastUsedAt: true, createdByMemberId: true },
    });
    return rows.map((row) => ({
      id: joinTokenIdSchema.parse(row.id),
      label: row.label,
      bootstrap: row.bootstrap,
      createdAt: row.createdAt.getTime(),
      expiresAt: row.expiresAt === null ? null : row.expiresAt.getTime(),
      revokedAt: row.revokedAt === null ? null : row.revokedAt.getTime(),
      lastUsedAt: row.lastUsedAt === null ? null : row.lastUsedAt.getTime(),
    }));
  }),

  /** Makes a join token for a pool. The token is in this answer and nowhere else, ever again (Q48, Q94). */
  createJoinToken: adminProcedure
    .input(
      z.strictObject({
        poolId: poolIdSchema,
        label: z.string().trim().min(1).max(100).optional(),
        /** Days until it stops working; `null` for never. */
        expiresInDays: z.number().int().positive().max(3650).nullable().default(30),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const token = generateJoinToken();
      const expiresAt = input.expiresInDays === null ? null : new Date(ports.clock.now() + input.expiresInDays * 24 * 60 * 60 * 1000);
      const created = await db.$transaction(async (tx) => {
        const pool = await tx.runnerPool.findFirst({ where: { id: input.poolId, organizationId }, select: { id: true } });
        if (pool === null) {
          throw new TRPCError({ code: "NOT_FOUND", message: "No such pool" });
        }
        const row = await tx.joinToken.create({
          data: {
            organizationId,
            poolId: pool.id,
            tokenHash: hashJoinToken(token),
            label: input.label ?? null,
            createdByMemberId: ctx.scope.memberId,
            expiresAt,
          },
          select: { id: true },
        });
        await ports.audit.recordInTx(tx, { organizationId, projectId: null, actor: { kind: "member", id: ctx.scope.memberId }, action: "join-token.created", entity: "join-token", entityId: joinTokenIdSchema.parse(row.id), data: { poolId: pool.id } });
        await ports.notices.emitInTx(tx, { organizationId, projectId: null, entity: "runner-pool", entityId: input.poolId });
        return row;
      });
      return { joinTokenId: joinTokenIdSchema.parse(created.id), token, expiresAt: expiresAt === null ? null : expiresAt.getTime() };
    }),

  /** Revokes a join token: a runner can't join with it any more. Revoking one already revoked is a no-op. */
  revokeJoinToken: adminProcedure.input(z.strictObject({ joinTokenId: joinTokenIdSchema })).mutation(async ({ ctx, input }) => {
    const { db, ports } = ctx.deps;
    const organizationId = ctx.scope.organizationId;
    return db.$transaction(async (tx) => {
      const row = await tx.joinToken.findFirst({ where: { id: input.joinTokenId, organizationId }, select: { id: true, poolId: true, revokedAt: true } });
      if (row === null) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No such join token" });
      }
      if (row.revokedAt === null) {
        await tx.joinToken.update({ where: { id: row.id }, data: { revokedAt: new Date(ports.clock.now()) } });
        await ports.audit.recordInTx(tx, { organizationId, projectId: null, actor: { kind: "member", id: ctx.scope.memberId }, action: "join-token.revoked", entity: "join-token", entityId: input.joinTokenId, data: { poolId: row.poolId } });
        await ports.notices.emitInTx(tx, { organizationId, projectId: null, entity: "runner-pool", entityId: poolIdSchema.parse(row.poolId) });
      }
      return { joinTokenId: input.joinTokenId, revoked: true as const };
    });
  }),
});
