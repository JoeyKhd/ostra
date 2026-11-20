import {
  createJoinToken,
  createPool,
  dispatchWaitFromDb,
  joinTokenFromColumns,
  poolQueueInTx,
  revokeJoinToken,
  updatePool,
} from "@ostra/domain";
import type { PoolAdminDeps } from "@ostra/domain";
import type { JoinTokenId, PoolId } from "@ostra/protocol";
import {
  joinTokenIdSchema,
  memberIdSchema,
  poolIdSchema,
  projectIdSchema,
  runnerIdSchema,
} from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { ApiDeps } from "../trpc/context.ts";
import { adminProcedure, memberProcedure, router, unwrap } from "../trpc/init.ts";
import { poolFleetOf, poolIdsOf, QUEUE_VIEW_MAX } from "./fleet-view.ts";

// F-091 (milestone 5's ticket 25): runner pools and their join tokens, for organization admins.
// Every write goes through the domain's use cases (`createPool`, `updatePool`, `createJoinToken`,
// `revokeJoinToken`), one transaction each with its audit entry. A join token is in the answer that
// makes it and nowhere else: no list, no page, no error and no log line carries it or its hash.
// Another organization's pool or token is `NOT_FOUND`.

const poolName = z.string().trim().min(1).max(64);
const maxBoxes = z.number().int().positive().max(100_000).nullable();
/** A pool's token lifetime in days: `null` for the setting's (`OSTRA_JOIN_TOKEN_DAYS`), `0` for none. */
const joinTokenDays = z.number().int().min(0).max(3650).nullable();
/** An admin's token lifetime: days, or `null` for none; left out, the pool's. */
const tokenDays = z.number().int().positive().max(3650).nullable();
const tokenLabel = z.string().trim().min(1).max(100);

/** What the pool use cases take, from the API's deps. */
const poolDeps = (deps: ApiDeps): PoolAdminDeps => ({
  db: deps.db,
  audit: deps.ports.audit,
  notices: deps.ports.notices,
  clock: deps.ports.clock,
  jobs: deps.ports.jobs,
  joinTokenDays: deps.settings.joinTokenDays,
});

const tokenSelect = {
  id: true,
  label: true,
  bootstrap: true,
  createdAt: true,
  createdByMemberId: true,
  expiresAt: true,
  revokedAt: true,
  revokedByMemberId: true,
  lastUsedAt: true,
  useCount: true,
} as const;

type TokenRow = {
  readonly id: string;
  readonly label: string | null;
  readonly bootstrap: boolean;
  readonly createdAt: Date;
  readonly createdByMemberId: string | null;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly revokedByMemberId: string | null;
  readonly lastUsedAt: Date | null;
  readonly useCount: number;
};

/** A pool's join tokens as the panel lists them: who made them and how they're used, never the token or its hash. */
const listTokens = async (deps: ApiDeps, organizationId: string, poolId: PoolId) => {
  const rows: readonly TokenRow[] = await deps.db.joinToken.findMany({
    where: { poolId, organizationId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: tokenSelect,
  });
  const memberIds = [
    ...new Set(
      rows.flatMap((row) =>
        [row.createdByMemberId, row.revokedByMemberId].filter((id): id is string => id !== null),
      ),
    ),
  ];
  const members = await deps.db.member.findMany({
    where: { organizationId, id: { in: memberIds } },
    select: { id: true, user: { select: { name: true } } },
  });
  const nameOf = new Map(members.map((member) => [member.id, member.user.name] as const));
  const who = (id: string | null) =>
    id === null ? null : { memberId: memberIdSchema.parse(id), name: nameOf.get(id) ?? null };
  const now = deps.ports.clock.now();
  return rows.map((row) => ({
    id: joinTokenIdSchema.parse(row.id),
    label: row.label,
    bootstrap: row.bootstrap,
    /** `active`, `expired` or `revoked`, by the clock now. */
    state: joinTokenFromColumns(row, now).state,
    createdAt: row.createdAt.getTime(),
    createdBy: who(row.createdByMemberId),
    expiresAt: row.expiresAt === null ? null : row.expiresAt.getTime(),
    lastUsedAt: row.lastUsedAt === null ? null : row.lastUsedAt.getTime(),
    uses: row.useCount,
    revokedAt: row.revokedAt === null ? null : row.revokedAt.getTime(),
    revokedBy: who(row.revokedByMemberId),
  }));
};

/** The pool, in the caller's organization, or `NOT_FOUND`. */
const poolOrNotFound = async (deps: ApiDeps, organizationId: string, poolId: PoolId) => {
  const pool = await deps.db.runnerPool.findFirst({ where: { id: poolId, organizationId } });
  if (pool === null) {
    throw new TRPCError({ code: "NOT_FOUND", message: "No such pool" });
  }
  return pool;
};

const makeToken = async (
  deps: ApiDeps,
  scope: Parameters<typeof createJoinToken>[1],
  input: { readonly poolId: PoolId; readonly label: string | null; readonly days?: number | null },
) => {
  const made = unwrap(
    await createJoinToken(
      poolDeps(deps),
      scope,
      input.days === undefined ? { poolId: input.poolId, label: input.label } : input,
    ),
    {
      forbidden: "FORBIDDEN",
      "not-found": "NOT_FOUND",
    },
  );
  return { joinTokenId: made.joinTokenId, token: made.token, expiresAt: made.expiresAt };
};

/** Revokes a token; one already revoked answers the same and changes nothing. */
const revokeToken = async (
  deps: ApiDeps,
  scope: Parameters<typeof revokeJoinToken>[1],
  joinTokenId: JoinTokenId,
) => {
  const result = await revokeJoinToken(poolDeps(deps), scope, { joinTokenId });
  if (!result.ok && result.error === "already-revoked") {
    const row = await deps.db.joinToken.findFirst({
      where: { id: joinTokenId, organizationId: scope.organizationId },
      select: { revokedAt: true },
    });
    return {
      joinTokenId,
      revoked: true as const,
      revokedAt: row?.revokedAt?.getTime() ?? null,
      changed: false,
    };
  }
  const revoked = unwrap(result, {
    forbidden: "FORBIDDEN",
    "not-found": "NOT_FOUND",
    "already-revoked": "CONFLICT",
  });
  return { joinTokenId, revoked: true as const, revokedAt: revoked.revokedAt, changed: true };
};

export const poolsRouter = router({
  /**
   * The organization's runner pools, with their runners and projects counted (F-092): the boxes in
   * use (its runners' `Box` rows that hold a slot) against the slots of its runners that take or
   * finish work, its queue's length, the executors, versions (and their range) and labels of its
   * runners, the lines their capabilities call for, and the first project that uses it, by name.
   */
  list: adminProcedure.query(async ({ ctx }) => {
    const organizationId = ctx.scope.organizationId;
    const pools = await ctx.deps.db.runnerPool.findMany({
      where: { organizationId },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
      include: {
        _count: { select: { projectPools: true } },
        joinTokens: { where: { revokedAt: null }, select: { expiresAt: true } },
        projectPools: { orderBy: { project: { name: "asc" } }, take: 1, select: { project: { select: { name: true } } } },
      },
    });
    const fleet = await poolFleetOf(ctx.deps, organizationId, poolIdsOf(pools));
    const now = ctx.deps.ports.clock.now();
    return pools.map((pool) => {
      const poolId = poolIdSchema.parse(pool.id);
      const use = fleet.get(poolId);
      return {
        id: poolId,
        name: pool.name,
        isDefault: pool.isDefault,
        requiresApproval: pool.requiresApproval,
        maxBoxes: pool.maxBoxes,
        joinTokenDays: pool.joinTokenDays,
        runnerCount: use?.runnerCount ?? 0,
        onlineCount: use?.onlineCount ?? 0,
        /** Runners that joined and wait for an admin's approval (F-091). */
        awaitingApproval: use?.awaitingApproval ?? 0,
        projectCount: pool._count.projectPools,
        firstProjectName: pool.projectPools[0]?.project.name ?? null,
        /** Tokens neither revoked nor expired. */
        activeJoinTokens: pool.joinTokens.filter((token) => token.expiresAt === null || token.expiresAt.getTime() > now).length,
        busy: use?.busy ?? 0,
        slots: use?.slots ?? 0,
        /** How many tasks wait in its queue (F-067). */
        queueLength: use?.queueLength ?? 0,
        executors: use?.executors ?? [],
        versions: use?.versions ?? [],
        /** The oldest and newest version its runners run: equal when they agree, `null` with no runner. */
        versionRange: use?.versionRange ?? null,
        labels: use?.labels ?? [],
        lines: use?.lines ?? [],
      };
    });
  }),

  /** The pools' names, for every member: what a member sees of the fleet besides their own runner (F-092). */
  names: memberProcedure.query(async ({ ctx }) => {
    const rows = await ctx.deps.db.runnerPool.findMany({
      where: { organizationId: ctx.scope.organizationId },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
      select: { id: true, name: true, isDefault: true },
    });
    return rows.map((row) => ({ id: poolIdSchema.parse(row.id), name: row.name, isDefault: row.isDefault }));
  }),

  /**
   * A pool's queue (F-067, ADR 0059): the queued tasks the pool could run, in its order (ticket
   * priority, then when queued), each with its project, priority, queued time, why it waits and its
   * place. Admins only: a member sees their own task's place on the task (`tasks.get`).
   */
  queue: adminProcedure.input(z.strictObject({ poolId: poolIdSchema })).query(async ({ ctx, input }) => {
    const organizationId = ctx.scope.organizationId;
    await poolOrNotFound(ctx.deps, organizationId, input.poolId);
    const entries = await poolQueueInTx(ctx.deps.db, organizationId, input.poolId, QUEUE_VIEW_MAX);
    const rows = await ctx.deps.db.task.findMany({
      where: { organizationId, id: { in: entries.map((entry) => entry.taskId) } },
      select: {
        id: true,
        title: true,
        ticketKey: true,
        dispatchWait: true,
        creatorMemberId: true,
        project: { select: { id: true, name: true } },
      },
    });
    const byId = new Map(rows.map((row) => [row.id, row] as const));
    const creatorIds = [...new Set(rows.flatMap((row) => (row.creatorMemberId === null ? [] : [row.creatorMemberId])))];
    const creators = await ctx.deps.db.member.findMany({ where: { organizationId, id: { in: creatorIds } }, select: { id: true, user: { select: { name: true } } } });
    const nameOf = new Map(creators.map((member) => [member.id, member.user.name] as const));
    return entries.flatMap((entry, index) => {
      const row = byId.get(entry.taskId);
      return row === undefined
        ? []
        : [
            {
              place: index + 1,
              taskId: entry.taskId,
              title: row.title,
              ticketKey: row.ticketKey,
              project: { id: projectIdSchema.parse(row.project.id), name: row.project.name },
              /** 1 Urgent, 2 High, 3 Medium (and prompt tasks), 4 Low. */
              priority: entry.queuePriority,
              queuedAt: entry.queuedAt?.getTime() ?? null,
              /** Why it waits, as the admission last recorded it; `null` before its first pass. */
              waitReason: dispatchWaitFromDb(row.dispatchWait),
              createdBy: row.creatorMemberId === null ? null : { memberId: memberIdSchema.parse(row.creatorMemberId), name: nameOf.get(row.creatorMemberId) ?? null },
            },
          ];
    });
  }),

  /** One pool's page: its settings, runners, join tokens (never their values) and the projects that use it. */
  get: adminProcedure
    .input(z.strictObject({ poolId: poolIdSchema }))
    .query(async ({ ctx, input }) => {
      const organizationId = ctx.scope.organizationId;
      const pool = await poolOrNotFound(ctx.deps, organizationId, input.poolId);
      const [runners, tokens, projects] = await Promise.all([
        ctx.deps.db.runner.findMany({
          where: { organizationId, poolId: pool.id },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            name: true,
            state: true,
            executor: true,
            labels: true,
            version: true,
            approvedAt: true,
            revokedAt: true,
            joinTokenId: true,
            createdAt: true,
          },
        }),
        listTokens(ctx.deps, organizationId, input.poolId),
        ctx.deps.db.projectPool.findMany({
          where: { organizationId, poolId: pool.id },
          orderBy: { project: { name: "asc" } },
          select: { maxBoxes: true, position: true, project: { select: { id: true, name: true } } },
        }),
      ]);
      return {
        id: input.poolId,
        name: pool.name,
        isDefault: pool.isDefault,
        requiresApproval: pool.requiresApproval,
        maxBoxes: pool.maxBoxes,
        joinTokenDays: pool.joinTokenDays,
        createdAt: pool.createdAt.getTime(),
        runners: runners.map((runner) => ({
          id: runnerIdSchema.parse(runner.id),
          name: runner.name,
          state: runner.state,
          executor: runner.executor,
          labels: runner.labels,
          version: runner.version,
          /** Whether it waits for an admin's approval. */
          awaitingApproval:
            pool.requiresApproval &&
            runner.state === "joining" &&
            runner.approvedAt === null &&
            runner.revokedAt === null,
          joinTokenId:
            runner.joinTokenId === null ? null : joinTokenIdSchema.parse(runner.joinTokenId),
          joinedAt: runner.createdAt.getTime(),
        })),
        tokens,
        projects: projects.map((link) => ({
          projectId: projectIdSchema.parse(link.project.id),
          name: link.project.name,
          maxBoxes: link.maxBoxes,
          position: link.position,
        })),
      };
    }),

  /** Makes a pool and its first join token, which this answer carries and nothing else ever will. */
  create: adminProcedure
    .input(
      z.strictObject({
        name: poolName,
        requiresApproval: z.boolean().default(false),
        maxBoxes: maxBoxes.default(null),
        joinTokenDays: joinTokenDays.default(null),
        projectIds: z.array(projectIdSchema).max(500).default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const made = unwrap(await createPool(poolDeps(ctx.deps), ctx.scope, input), {
        forbidden: "FORBIDDEN",
        "name-taken": "CONFLICT",
        "invalid-input": "BAD_REQUEST",
      });
      ctx.deps.logger.info("pool.created", {
        poolId: made.poolId,
        joinTokenId: made.joinToken.joinTokenId,
      });
      return {
        poolId: made.poolId,
        pool: {
          id: made.poolId,
          name: input.name,
          requiresApproval: input.requiresApproval,
          maxBoxes: input.maxBoxes,
          joinTokenDays: input.joinTokenDays,
        },
        joinToken: made.joinToken,
      };
    }),

  update: adminProcedure
    .input(
      z.strictObject({
        poolId: poolIdSchema,
        name: poolName.optional(),
        requiresApproval: z.boolean().optional(),
        maxBoxes: maxBoxes.optional(),
        joinTokenDays: joinTokenDays.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const updated = unwrap(
        await updatePool(poolDeps(ctx.deps), ctx.scope, {
          poolId: input.poolId,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.requiresApproval === undefined
            ? {}
            : { requiresApproval: input.requiresApproval }),
          ...(input.maxBoxes === undefined ? {} : { maxBoxes: input.maxBoxes }),
          ...(input.joinTokenDays === undefined ? {} : { joinTokenDays: input.joinTokenDays }),
        }),
        {
          forbidden: "FORBIDDEN",
          "not-found": "NOT_FOUND",
          "name-taken": "CONFLICT",
          "invalid-input": "BAD_REQUEST",
        },
      );
      return { poolId: updated.poolId };
    }),

  // ---- milestone 2's names, kept for the panel until ticket 30 moves it onto `joinTokens.*` ----

  /** A pool's join tokens. Same as `joinTokens.list`. */
  joinTokens: adminProcedure
    .input(z.strictObject({ poolId: poolIdSchema }))
    .query(async ({ ctx, input }) => {
      await poolOrNotFound(ctx.deps, ctx.scope.organizationId, input.poolId);
      return listTokens(ctx.deps, ctx.scope.organizationId, input.poolId);
    }),

  /** Makes a join token. Same as `joinTokens.create`, with milestone 2's `expiresInDays`. */
  createJoinToken: adminProcedure
    .input(
      z.strictObject({
        poolId: poolIdSchema,
        label: tokenLabel.optional(),
        expiresInDays: tokenDays.optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      makeToken(ctx.deps, ctx.scope, {
        poolId: input.poolId,
        label: input.label ?? null,
        ...(input.expiresInDays === undefined ? {} : { days: input.expiresInDays }),
      }),
    ),

  /** Revokes a join token. Same as `joinTokens.revoke`. */
  revokeJoinToken: adminProcedure
    .input(z.strictObject({ joinTokenId: joinTokenIdSchema }))
    .mutation(({ ctx, input }) => revokeToken(ctx.deps, ctx.scope, input.joinTokenId)),
});

export const joinTokensRouter = router({
  /**
   * A new join token for a pool: `days` until it stops working, `null` for never, left out for the
   * pool's lifetime. The token is in this answer and nowhere else, ever again (Q48, Q94).
   */
  create: adminProcedure
    .input(
      z.strictObject({
        poolId: poolIdSchema,
        label: tokenLabel.nullable().default(null),
        days: tokenDays.optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      makeToken(ctx.deps, ctx.scope, {
        poolId: input.poolId,
        label: input.label,
        ...(input.days === undefined ? {} : { days: input.days }),
      }),
    ),

  /** Revokes a token: no runner joins with it again, and the runners that joined with it stay connected. */
  revoke: adminProcedure
    .input(z.strictObject({ tokenId: joinTokenIdSchema }))
    .mutation(({ ctx, input }) => revokeToken(ctx.deps, ctx.scope, input.tokenId)),

  /** A pool's tokens: label, who made it, its expiry, last use, uses and revocation. */
  list: adminProcedure
    .input(z.strictObject({ poolId: poolIdSchema }))
    .query(async ({ ctx, input }) => {
      await poolOrNotFound(ctx.deps, ctx.scope.organizationId, input.poolId);
      return listTokens(ctx.deps, ctx.scope.organizationId, input.poolId);
    }),
});
