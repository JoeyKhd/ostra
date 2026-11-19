import type { SecretRef } from "@ostra/adapter-sdk";
import type { Db, Tx } from "@ostra/db";
import { runnerStartsServices, serviceVariablesFromDb, serviceVariablesSchema, snapshotFailureFromDb } from "@ostra/domain";
import type { MemberScope, Ports, ServiceVariable } from "@ostra/domain";
import {
  checkIdSchema,
  envNameSchema,
  environmentIdSchema,
  executorKindSchema,
  memberIdSchema,
  poolIdSchema,
  projectIdSchema,
  repoIdSchema,
  runnerLimits,
  serviceIdSchema,
  serviceNameSchema,
  snapshotFailureReasonSchema,
  snapshotIdSchema,
} from "@ostra/protocol";
import type { EnvironmentId, ExecutorKind, OrganizationId, PoolId, ProjectId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { projectProcedure, router } from "../trpc/init.ts";

// Milestone 3, ticket 40 (F-094, F-051, F-054; ADR 0038 as amended, ADR 0052): the environment's
// services, its checks and its snapshot. Reading is for anyone who can open the project (a
// service's secret by name only, never its value or reference); editing is for project admins.
// A service's change and Rebuild enqueue `snapshot.schedule`; a check's doesn't, since the image
// doesn't hold it. Each write is one transaction with its audit entry and change notice; secret
// values go to the secret store first, and the ones a write dropped are deleted after it commits.

const projectInput = z.strictObject({ projectId: projectIdSchema });

const notFound = (what: string): TRPCError => new TRPCError({ code: "NOT_FOUND", message: `No such ${what}` });
const badRequest = (message: string): TRPCError => new TRPCError({ code: "BAD_REQUEST", message });

const environmentOf = async (db: Db | Tx, organizationId: OrganizationId, projectId: ProjectId): Promise<EnvironmentId> => {
  const row = await db.environment.findFirst({ where: { projectId, organizationId }, select: { id: true } });
  if (row === null) {
    throw notFound("environment");
  }
  return environmentIdSchema.parse(row.id);
};

const onlineWhere = (now: number) => ({
  state: "online" as const,
  revokedAt: null,
  presence: { is: { disconnectedAt: null, lastSeenAt: { gt: new Date(now - runnerLimits.offlineMs) } } },
});

/** The project's pools, as the dispatch reads them: the ones it lists, or the organization's default pools. */
const projectPools = async (db: Db, organizationId: OrganizationId, projectId: ProjectId): Promise<readonly { readonly id: PoolId; readonly name: string }[]> => {
  const listed = await db.projectPool.findMany({ where: { projectId, organizationId }, select: { pool: { select: { id: true, name: true } } } });
  const pools = listed.length > 0 ? listed.map((row) => row.pool) : await db.runnerPool.findMany({ where: { organizationId, isDefault: true }, select: { id: true, name: true } });
  return [...pools].sort((a, b) => a.name.localeCompare(b.name)).map((pool) => ({ id: poolIdSchema.parse(pool.id), name: pool.name }));
};

export const whereTasksRunSchema = z.object({
  /** The project's pools, by name. */
  pools: z.array(z.object({ poolId: poolIdSchema, name: z.string() })),
  /** Online runners of those pools, and the member's own personal runners, whose executor starts services. */
  servicesRunnersOnline: z.number().int().nonnegative(),
  /** The executors of those runners that are online, without repeats. */
  executorsOnline: z.array(executorKindSchema),
  /** The executors of the pools' runners, online or not: only `host` means no snapshot image. */
  poolExecutors: z.array(executorKindSchema),
  /** How many services the environment has. */
  services: z.number().int().nonnegative(),
  /** It has services, and no runner that can start them is online: its tasks wait (F-094). */
  noServicesRunner: z.boolean(),
});
export type WhereTasksRun = z.infer<typeof whereTasksRunSchema>;

/** Where the project's tasks can run, for `environments.get`: the pools, who is online, and the services' rule. */
export const whereTasksRun = async (db: Db, scope: MemberScope, projectId: ProjectId, now: number): Promise<WhereTasksRun> => {
  const organizationId = scope.organizationId;
  const pools = await projectPools(db, organizationId, projectId);
  const poolIds = pools.map((pool) => pool.id);
  const select = { executor: true, presence: { select: { minor: true } } } as const;
  const online = [
    ...(poolIds.length === 0 ? [] : await db.runner.findMany({ where: { organizationId, kind: "pool", poolId: { in: poolIds }, ...onlineWhere(now) }, select })),
    ...(await db.runner.findMany({ where: { organizationId, kind: "personal", ownerMemberId: scope.memberId, ...onlineWhere(now) }, select })),
  ];
  const poolRunners =
    poolIds.length === 0
      ? []
      : await db.runner.findMany({ where: { organizationId, kind: "pool", poolId: { in: poolIds }, revokedAt: null }, select: { executor: true }, distinct: ["executor"] });
  const services = await db.service.count({ where: { projectId, organizationId } });
  const servicesRunnersOnline = online.filter((runner) => runnerStartsServices({ executor: runner.executor, minor: runner.presence?.minor ?? 0 })).length;
  const order: readonly ExecutorKind[] = ["docker", "kubernetes", "host"];
  const executorsOnline = order.filter((executor) => online.some((runner) => runner.executor === executor));
  return {
    pools: pools.map((pool) => ({ poolId: pool.id, name: pool.name })),
    servicesRunnersOnline,
    executorsOnline,
    poolExecutors: order.filter((executor) => poolRunners.some((runner) => runner.executor === executor)),
    services,
    noServicesRunner: services > 0 && servicesRunnersOnline === 0,
  };
};

// ---------- services ----------

const serviceVariableInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("plain"), name: envNameSchema, value: z.string().max(65_536) }),
  /** A secret saved without a value keeps the one it has. */
  z.strictObject({ kind: z.literal("secret"), name: envNameSchema, value: z.string().min(1).max(65_536).optional() }),
]);

/** An image reference as `docker pull` takes it: `postgres:17`, `ghcr.io/acme/db@sha256:…`. */
const imageSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9._-]{1,128})?(?:@sha256:[0-9a-f]{64})?$/, "An image like postgres:17.");

export const saveServiceInputSchema = z.strictObject({
  projectId: projectIdSchema,
  /** The service to change; absent for a new one. */
  serviceId: serviceIdSchema.optional(),
  name: serviceNameSchema,
  image: imageSchema,
  port: z.number().int().min(1).max(65_535).nullable(),
  variables: z.array(serviceVariableInputSchema).max(200),
  healthCheck: z.string().trim().min(1).max(2048).nullable(),
});
export type SaveServiceInput = z.infer<typeof saveServiceInputSchema>;

const serviceVariableViewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plain"), name: z.string(), value: z.string() }),
  /** A secret is shown by name only: never its value, never its reference. */
  z.object({ kind: z.literal("secret"), name: z.string(), set: z.literal(true) }),
]);

/** A service's health on the last box that ran it, from `service.healthy` and `service.failed` (spec 5.3). */
const lastBoxSchema = z.object({
  /** `started`: healthy with no health check of its own, so the box only waited for its port. */
  state: z.enum(["healthy", "failed", "started"]),
  /** Epoch ms. */
  at: z.number().int(),
  runnerName: z.string().nullable(),
  afterMs: z.number().int().nullable(),
  /** A failed service's reason, as the runner said it. */
  reason: z.string().nullable(),
});

const serviceViewSchema = z.object({
  serviceId: serviceIdSchema,
  name: z.string(),
  image: z.string(),
  port: z.number().int().nullable(),
  variables: z.array(serviceVariableViewSchema),
  healthCheck: z.string().nullable(),
  lastBox: lastBoxSchema.nullable(),
});
export type ServiceView = z.infer<typeof serviceViewSchema>;

const healthEventSchema = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("service.healthy"), name: z.string(), afterMs: z.number().int() }),
  z.looseObject({ kind: z.literal("service.failed"), name: z.string(), reason: z.string() }),
]);

const lastBoxOf = async (db: Db, organizationId: OrganizationId, projectId: ProjectId, service: { readonly name: string; readonly healthCheck: string | null }) => {
  const event = await db.event.findFirst({
    where: { organizationId, projectId, kind: { in: ["service.healthy", "service.failed"] }, payload: { path: ["name"], equals: service.name } },
    orderBy: [{ occurredAt: "desc" }, { seq: "desc" }],
    select: { payload: true, occurredAt: true, session: { select: { box: { select: { runner: { select: { name: true } } } } } } },
  });
  const parsed = healthEventSchema.safeParse(event?.payload);
  if (event === null || !parsed.success) {
    return null;
  }
  const runnerName = event.session.box?.runner?.name ?? null;
  const at = event.occurredAt.getTime();
  return parsed.data.kind === "service.failed"
    ? { state: "failed" as const, at, runnerName, afterMs: null, reason: parsed.data.reason }
    : { state: service.healthCheck === null ? ("started" as const) : ("healthy" as const), at, runnerName, afterMs: parsed.data.afterMs, reason: null };
};

const variableViews = (variables: readonly ServiceVariable[]) =>
  variables.map((variable) => (variable.kind === "plain" ? { kind: "plain" as const, name: variable.name, value: variable.value } : { kind: "secret" as const, name: variable.name, set: true as const }));

/** The secret references a service's variables hold. */
const refsOf = (variables: readonly ServiceVariable[]): readonly SecretRef[] => variables.flatMap((variable) => (variable.kind === "secret" ? [variable.secretRef] : []));

const enqueueSnapshot = (ports: Ports, tx: Tx, organizationId: OrganizationId, projectId: ProjectId) =>
  ports.jobs.enqueueInTx(tx, "snapshot.schedule", { organizationId, projectId, reason: "environment-changed" });

const servicesRouter = router({
  /** The environment's services, by name, each with its health on the last box that ran it. */
  list: projectProcedure("read", projectInput)
    .output(z.array(serviceViewSchema))
    .query(async ({ ctx, input }) => {
      const { db } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      await environmentOf(db, organizationId, input.projectId);
      const rows = await db.service.findMany({ where: { projectId: input.projectId, organizationId }, orderBy: { name: "asc" } });
      const out: ServiceView[] = [];
      for (const row of rows) {
        out.push({
          serviceId: serviceIdSchema.parse(row.id),
          name: row.name,
          image: row.image,
          port: row.port,
          variables: variableViews(serviceVariablesFromDb(row.variables)),
          healthCheck: row.healthCheck,
          lastBox: await lastBoxOf(db, organizationId, input.projectId, row),
        });
      }
      return out;
    }),

  /** Adds or changes one service; its secrets' values go to the secret store. Queues a snapshot build. */
  save: projectProcedure("admin", saveServiceInputSchema)
    .output(z.object({ serviceId: serviceIdSchema }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const environmentId = await environmentOf(db, organizationId, input.projectId);
      const existing =
        input.serviceId === undefined ? null : await db.service.findFirst({ where: { id: input.serviceId, projectId: input.projectId, organizationId } });
      if (input.serviceId !== undefined && existing === null) {
        throw notFound("service");
      }
      const names = new Set<string>();
      for (const variable of input.variables) {
        if (names.has(variable.name)) {
          throw badRequest(`${variable.name} appears twice`);
        }
        names.add(variable.name);
      }
      const kept = new Map<string, SecretRef>(
        serviceVariablesFromDb(existing?.variables).flatMap((variable) => (variable.kind === "secret" ? [[variable.name, variable.secretRef] as const] : [])),
      );
      const created: SecretRef[] = [];
      const forget = () => Promise.allSettled(created.map((ref) => ports.adapters.secretStore.delete(organizationId, ref)));
      const variables: ServiceVariable[] = [];
      for (const variable of input.variables) {
        if (variable.kind === "plain") {
          variables.push(variable);
          continue;
        }
        let ref = kept.get(variable.name);
        if (variable.value !== undefined) {
          const put = await ports.adapters.secretStore.put({ organizationId, purpose: "environment.secret" }, variable.value);
          if (!put.ok) {
            await forget();
            throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The secret store didn't keep the service's secret" });
          }
          created.push(put.value);
          ref = put.value;
        }
        if (ref === undefined) {
          await forget();
          throw badRequest(`The secret ${variable.name} has no value yet: give it one`);
        }
        variables.push({ kind: "secret", name: variable.name, secretRef: ref });
      }
      const stored = serviceVariablesSchema.parse(variables);
      let serviceId: z.infer<typeof serviceIdSchema>;
      try {
        serviceId = await db.$transaction(async (tx) => {
          const clash = await tx.service.findFirst({
            where: { environmentId, name: input.name, ...(existing === null ? {} : { id: { not: existing.id } }) },
            select: { id: true },
          });
          if (clash !== null) {
            throw new TRPCError({ code: "CONFLICT", message: "A service with that name exists." });
          }
          if (existing === null && (await tx.service.count({ where: { environmentId } })) >= runnerLimits.servicesMax) {
            throw badRequest(`An environment holds at most ${String(runnerLimits.servicesMax)} services`);
          }
          const data = { name: input.name, image: input.image, port: input.port, variables: stored, healthCheck: input.healthCheck };
          const row =
            existing === null
              ? await tx.service.create({ data: { organizationId, projectId: input.projectId, environmentId, ...data }, select: { id: true } })
              : await tx.service.update({ where: { id: existing.id }, data, select: { id: true } });
          const id = serviceIdSchema.parse(row.id);
          await enqueueSnapshot(ports, tx, organizationId, input.projectId);
          await ports.audit.recordInTx(tx, {
            organizationId,
            projectId: input.projectId,
            actor: { kind: "member", id: ctx.scope.memberId },
            action: existing === null ? "environment.service-added" : "environment.service-changed",
            entity: "environment",
            entityId: environmentId,
            data: { serviceId: id, variables: stored.length, secrets: refsOf(stored).length },
          });
          await ports.notices.emitInTx(tx, { organizationId, projectId: input.projectId, entity: "environment", entityId: environmentId });
          return id;
        });
      } catch (error) {
        await forget();
        throw error;
      }
      // The secrets this save replaced or dropped, once the row no longer names them.
      const now = new Set(refsOf(stored));
      await Promise.allSettled(refsOf(serviceVariablesFromDb(existing?.variables)).filter((ref) => !now.has(ref)).map((ref) => ports.adapters.secretStore.delete(organizationId, ref)));
      return { serviceId };
    }),

  /** Removes a service and its secrets. New boxes start without it; the snapshot rebuilds. */
  delete: projectProcedure("admin", z.strictObject({ projectId: projectIdSchema, serviceId: serviceIdSchema }))
    .output(z.object({ deleted: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const environmentId = await environmentOf(db, organizationId, input.projectId);
      const removed = await db.$transaction(async (tx) => {
        const row = await tx.service.findFirst({ where: { id: input.serviceId, projectId: input.projectId, organizationId } });
        if (row === null) {
          throw notFound("service");
        }
        await tx.service.delete({ where: { id: row.id } });
        await enqueueSnapshot(ports, tx, organizationId, input.projectId);
        await ports.audit.recordInTx(tx, {
          organizationId,
          projectId: input.projectId,
          actor: { kind: "member", id: ctx.scope.memberId },
          action: "environment.service-removed",
          entity: "environment",
          entityId: environmentId,
          data: { serviceId: input.serviceId },
        });
        await ports.notices.emitInTx(tx, { organizationId, projectId: input.projectId, entity: "environment", entityId: environmentId });
        return row;
      });
      await Promise.allSettled(refsOf(serviceVariablesFromDb(removed.variables)).map((ref) => ports.adapters.secretStore.delete(organizationId, ref)));
      return { deleted: true as const };
    }),
});

// ---------- checks ----------

export const saveCheckInputSchema = z.strictObject({
  projectId: projectIdSchema,
  /** The check to change; absent for a new one, which goes last. */
  checkId: checkIdSchema.optional(),
  name: z.string().trim().min(1).max(200),
  command: z.string().trim().min(1).max(8192),
  /** The repo it runs in, on turns that changed it; `null` runs once at the workspace root (Q188). */
  repoId: repoIdSchema.nullable(),
  timeoutSeconds: z.number().int().min(1).max(runnerLimits.checkTimeoutMaxSeconds),
});

const checkViewSchema = z.object({
  checkId: checkIdSchema,
  name: z.string(),
  command: z.string(),
  repoId: repoIdSchema.nullable(),
  /** The repo's `owner/name`, or `null` for the workspace root. */
  repoFullName: z.string().nullable(),
  timeoutSeconds: z.number().int(),
  /** Its place in the order, from 1. */
  position: z.number().int(),
});
export type CheckView = z.infer<typeof checkViewSchema>;

const checksOf = async (db: Db | Tx, organizationId: OrganizationId, projectId: ProjectId): Promise<CheckView[]> => {
  const rows = await db.check.findMany({ where: { projectId, organizationId }, orderBy: [{ position: "asc" }, { createdAt: "asc" }] });
  const repos = await db.repo.findMany({ where: { projectId, organizationId }, select: { id: true, fullName: true } });
  return rows.map((row, index) => ({
    checkId: checkIdSchema.parse(row.id),
    name: row.name,
    command: row.command,
    repoId: row.repoId === null ? null : repoIdSchema.parse(row.repoId),
    repoFullName: row.repoId === null ? null : (repos.find((repo) => repo.id === row.repoId)?.fullName ?? null),
    timeoutSeconds: row.timeoutSeconds,
    position: index + 1,
  }));
};

const checkWritten = async (ports: Ports, tx: Tx, scope: MemberScope, projectId: ProjectId, environmentId: EnvironmentId, action: string, data: Readonly<Record<string, string | number>>) => {
  await ports.audit.recordInTx(tx, {
    organizationId: scope.organizationId,
    projectId,
    actor: { kind: "member", id: scope.memberId },
    action,
    entity: "environment",
    entityId: environmentId,
    data,
  });
  await ports.notices.emitInTx(tx, { organizationId: scope.organizationId, projectId, entity: "environment", entityId: environmentId });
};

const checksRouter = router({
  /** The environment's checks, in the order they run after a turn with changes. */
  list: projectProcedure("read", projectInput)
    .output(z.array(checkViewSchema))
    .query(async ({ ctx, input }) => {
      await environmentOf(ctx.deps.db, ctx.scope.organizationId, input.projectId);
      return checksOf(ctx.deps.db, ctx.scope.organizationId, input.projectId);
    }),

  /** Adds or changes one check. A new one runs last. */
  save: projectProcedure("admin", saveCheckInputSchema)
    .output(z.object({ checkId: checkIdSchema }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const environmentId = await environmentOf(db, organizationId, input.projectId);
      return db.$transaction(async (tx) => {
        const existing = input.checkId === undefined ? null : await tx.check.findFirst({ where: { id: input.checkId, projectId: input.projectId, organizationId } });
        if (input.checkId !== undefined && existing === null) {
          throw notFound("check");
        }
        if (input.repoId !== null && (await tx.repo.count({ where: { id: input.repoId, projectId: input.projectId, organizationId } })) === 0) {
          throw badRequest("The check names a repo that isn't in this project");
        }
        const clash = await tx.check.findFirst({ where: { environmentId, name: input.name, ...(existing === null ? {} : { id: { not: existing.id } }) }, select: { id: true } });
        if (clash !== null) {
          throw new TRPCError({ code: "CONFLICT", message: "A check with that name exists." });
        }
        const data = { name: input.name, command: input.command, repoId: input.repoId, timeoutSeconds: input.timeoutSeconds };
        let id: z.infer<typeof checkIdSchema>;
        if (existing === null) {
          if ((await tx.check.count({ where: { environmentId } })) >= runnerLimits.checksMax) {
            throw badRequest(`An environment holds at most ${String(runnerLimits.checksMax)} checks`);
          }
          const last = await tx.check.findFirst({ where: { environmentId }, orderBy: { position: "desc" }, select: { position: true } });
          const row = await tx.check.create({
            data: { organizationId, projectId: input.projectId, environmentId, ...data, position: (last?.position ?? -1) + 1 },
            select: { id: true },
          });
          id = checkIdSchema.parse(row.id);
        } else {
          await tx.check.update({ where: { id: existing.id }, data });
          id = checkIdSchema.parse(existing.id);
        }
        await checkWritten(ports, tx, ctx.scope, input.projectId, environmentId, existing === null ? "environment.check-added" : "environment.check-changed", { checkId: id });
        return { checkId: id };
      });
    }),

  /** Puts the checks in a new order: every check of the environment, once. */
  reorder: projectProcedure("admin", z.strictObject({ projectId: projectIdSchema, checkIds: z.array(checkIdSchema).max(runnerLimits.checksMax) }))
    .output(z.array(checkViewSchema))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const environmentId = await environmentOf(db, organizationId, input.projectId);
      return db.$transaction(async (tx) => {
        const rows = await tx.check.findMany({ where: { environmentId }, select: { id: true } });
        const ids = new Set(rows.map((row) => row.id));
        if (input.checkIds.length !== ids.size || new Set(input.checkIds).size !== ids.size || input.checkIds.some((id) => !ids.has(id))) {
          throw badRequest("The order must name every check of the environment once");
        }
        for (const [position, id] of input.checkIds.entries()) {
          await tx.check.update({ where: { id }, data: { position } });
        }
        await checkWritten(ports, tx, ctx.scope, input.projectId, environmentId, "environment.checks-reordered", { checks: ids.size });
        return checksOf(tx, organizationId, input.projectId);
      });
    }),

  /** Removes a check: it stops running after the next turn. */
  delete: projectProcedure("admin", z.strictObject({ projectId: projectIdSchema, checkId: checkIdSchema }))
    .output(z.object({ deleted: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const environmentId = await environmentOf(db, organizationId, input.projectId);
      await db.$transaction(async (tx) => {
        const removed = await tx.check.deleteMany({ where: { id: input.checkId, environmentId, organizationId } });
        if (removed.count === 0) {
          throw notFound("check");
        }
        await checkWritten(ports, tx, ctx.scope, input.projectId, environmentId, "environment.check-removed", { checkId: input.checkId });
      });
      return { deleted: true as const };
    }),
});

// ---------- the snapshot ----------

const snapshotReasonSchema = z.enum(["environment-changed", "lockfile-changed", "nightly", "rebuild"]);

const snapshotViewSchema = z.object({
  /** `host-cache` when every runner of the project's pools uses `host`: no image, a worktree and a dependency cache. */
  kind: z.enum(["image", "host-cache"]),
  /** What `host` runners use instead of an image (ADR 0038 amended). */
  hostInstead: z.literal("worktree-and-dependency-cache"),
  /** The snapshot new boxes on its runner start from. */
  ready: z
    .object({
      snapshotId: snapshotIdSchema,
      /** Epoch ms. */
      builtAt: z.number().int(),
      durationMs: z.number().int().nullable(),
      runnerName: z.string().nullable(),
      digest: z.string().nullable(),
      reason: snapshotReasonSchema,
      requestedBy: z.string().nullable(),
      secretScan: z.enum(["passed", "failed"]).nullable(),
    })
    .nullable(),
  /** A build queued or under way. */
  pending: z
    .object({
      snapshotId: snapshotIdSchema,
      state: z.enum(["queued", "building"]),
      /** Epoch ms: when it was queued. */
      since: z.number().int(),
      runnerName: z.string().nullable(),
      reason: snapshotReasonSchema,
      requestedBy: z.string().nullable(),
    })
    .nullable(),
  /** The newest failed build since the ready one, with its reason. */
  lastFailure: z
    .object({
      snapshotId: snapshotIdSchema,
      /** Epoch ms. */
      at: z.number().int(),
      reason: snapshotFailureReasonSchema,
      detail: z.string(),
      runnerName: z.string().nullable(),
    })
    .nullable(),
  /** A build is queued and no `docker` runner of the project's pools is online to take it. */
  waitingForDockerRunner: z.boolean(),
});
export type SnapshotView = z.infer<typeof snapshotViewSchema>;

const reasonOf = (value: string): z.infer<typeof snapshotReasonSchema> => {
  const parsed = snapshotReasonSchema.safeParse(value);
  return parsed.success ? parsed.data : "environment-changed";
};

const REBUILD_ACTION = "environment.snapshot-rebuild-requested";

/** Who pressed Rebuild for a build: the newest request at or before it was made. */
const requestedByOf = async (db: Db, organizationId: OrganizationId, projectId: ProjectId, row: { readonly reason: string; readonly createdAt: Date }): Promise<string | null> => {
  if (row.reason !== "rebuild") {
    return null;
  }
  const entry = await db.auditEntry.findFirst({
    where: { organizationId, projectId, action: REBUILD_ACTION, createdAt: { lte: row.createdAt } },
    orderBy: { createdAt: "desc" },
    select: { actorId: true },
  });
  const memberId = memberIdSchema.safeParse(entry?.actorId);
  if (!memberId.success) {
    return null;
  }
  const member = await db.member.findFirst({ where: { id: memberId.data, organizationId }, select: { user: { select: { name: true } } } });
  return member?.user.name ?? null;
};

const snapshotRouter = router({
  /** The ready snapshot, the build under way, the last failure, and what `host` uses instead. */
  get: projectProcedure("read", projectInput)
    .output(snapshotViewSchema)
    .query(async ({ ctx, input }) => {
      const { db } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      await environmentOf(db, organizationId, input.projectId);
      const scope = { projectId: input.projectId, organizationId };
      const include = { runner: { select: { name: true } } } as const;
      const ready = await db.snapshot.findFirst({ where: { ...scope, state: "ready" }, orderBy: { readyAt: "desc" }, include });
      const pending = await db.snapshot.findFirst({ where: { ...scope, state: { in: ["queued", "building"] } }, orderBy: { createdAt: "desc" }, include });
      const failed = await db.snapshot.findFirst({
        where: { ...scope, state: "failed", ...(ready === null ? {} : { createdAt: { gt: ready.createdAt } }) },
        orderBy: { updatedAt: "desc" },
        include,
      });
      const where = await whereTasksRun(db, ctx.scope, input.projectId, ctx.deps.ports.clock.now());
      const failure = failed === null ? null : snapshotFailureFromDb(failed.failedReason);
      const dockerOnline =
        pending?.state !== "queued"
          ? true
          : (await db.runner.count({
              where: { organizationId, kind: "pool", executor: "docker", poolId: { in: where.pools.map((pool) => pool.poolId) }, ...onlineWhere(ctx.deps.ports.clock.now()) },
            })) > 0;
      return {
        kind: where.poolExecutors.length > 0 && where.poolExecutors.every((executor) => executor === "host") ? "host-cache" : "image",
        hostInstead: "worktree-and-dependency-cache",
        ready:
          ready === null
            ? null
            : {
                snapshotId: snapshotIdSchema.parse(ready.id),
                builtAt: (ready.readyAt ?? ready.updatedAt).getTime(),
                durationMs: ready.buildDurationMs,
                runnerName: ready.runner?.name ?? null,
                digest: ready.digest,
                reason: reasonOf(ready.reason),
                requestedBy: await requestedByOf(db, organizationId, input.projectId, ready),
                secretScan: ready.secretScan,
              },
        pending:
          pending === null
            ? null
            : {
                snapshotId: snapshotIdSchema.parse(pending.id),
                state: pending.state === "building" ? "building" : "queued",
                since: pending.createdAt.getTime(),
                runnerName: pending.runner?.name ?? null,
                reason: reasonOf(pending.reason),
                requestedBy: await requestedByOf(db, organizationId, input.projectId, pending),
              },
        lastFailure:
          failed === null || failure === null
            ? null
            : { snapshotId: snapshotIdSchema.parse(failed.id), at: failed.updatedAt.getTime(), reason: failure.reason, detail: failure.detail, runnerName: failed.runner?.name ?? null },
        waitingForDockerRunner: !dockerOnline,
      };
    }),

  /** Queues a build of the project's snapshot (project admins). Joins one already queued. */
  rebuild: projectProcedure("admin", projectInput)
    .output(z.object({ queued: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      const { db, ports } = ctx.deps;
      const organizationId = ctx.scope.organizationId;
      const environmentId = await environmentOf(db, organizationId, input.projectId);
      await db.$transaction(async (tx) => {
        await ports.jobs.enqueueInTx(tx, "snapshot.schedule", { organizationId, projectId: input.projectId, reason: "rebuild" });
        await ports.audit.recordInTx(tx, {
          organizationId,
          projectId: input.projectId,
          actor: { kind: "member", id: ctx.scope.memberId },
          action: REBUILD_ACTION,
          entity: "environment",
          entityId: environmentId,
        });
        await ports.notices.emitInTx(tx, { organizationId, projectId: input.projectId, entity: "environment", entityId: environmentId });
      });
      return { queued: true as const };
    }),
});

export { checksRouter, servicesRouter, snapshotRouter };
