import { createHash } from "node:crypto";

import { processContainmentFromDb } from "@ostra/db";
import type { Db } from "@ostra/db";
import { approveRunner, drainRunner, fleetInTx, rejectRunner, requireOrganizationAdmin, resumeRunner, revokeRunner, revokeRunnerInputSchema, runnerRoom, slotHoldingBoxStates, DEFAULT_PERSONAL_RUNNER_SLOTS } from "@ostra/domain";
import { joinTokenIdSchema, memberIdSchema, poolIdSchema, projectIdSchema, runnerIdSchema, taskIdSchema } from "@ostra/protocol";
import type { RunnerId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { ApiDeps } from "../trpc/context.ts";
import { adminProcedure, memberProcedure, router, unwrap } from "../trpc/init.ts";
import { busyBoxesByRunner, fleetRunnerSelect, runnerViewOf } from "./fleet-view.ts";

// F-013, F-014, F-091, F-092 (milestone 2's ticket 33, milestone 5's tickets 25 and 26): runners.
// A personal runner shows as "personal, not isolated" in the panel (ADR 0029). Pools and their join
// tokens are in `pools.ts`.

const osSchema = z.object({ platform: z.string(), arch: z.string(), release: z.string() }).nullable();

const parseOs = (value: unknown) => {
  const parsed = osSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/**
 * A runner's key as an admin checks it (F-091, ticket 31): `SHA256:` and the unpadded base64 of the
 * SHA-256 of the stored public key, as `ssh-keygen -l` prints one. Never the key itself.
 */
export const keyFingerprint = (publicKey: string): string => `SHA256:${createHash("sha256").update(publicKey).digest("base64").replace(/=+$/, "")}`;

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

/** How many audit entries a runner's page shows. */
const RUNNER_AUDIT_ENTRIES = 20;

/** What the fleet view's lines and slots read from the settings. */
const viewSettings = (deps: ApiDeps) => ({ sameUser: deps.settings.devHostPoolSameUser, personalSlots: DEFAULT_PERSONAL_RUNNER_SLOTS });

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

  /**
   * Every runner of the organization, for admins: pool and personal (F-092). Each with its state
   * and connection, carrier, executor, containment, install, version state, slots and resources,
   * labels, busy boxes (its `Box` rows that hold a slot) and the lines its capabilities call for.
   */
  list: adminProcedure.query(async ({ ctx }) => {
    const organizationId = ctx.scope.organizationId;
    const rows = await ctx.deps.db.runner.findMany({
      where: { organizationId },
      orderBy: [{ kind: "asc" }, { createdAt: "asc" }],
      select: { ...fleetRunnerSelect, os: true, owner: { select: { id: true, user: { select: { name: true } } } } },
    });
    const busy = await busyBoxesByRunner(ctx.deps.db, organizationId, rows.map((row) => row.id));
    const settings = viewSettings(ctx.deps);
    return rows.map((row) => ({
      ...runnerViewOf(row, busy.get(row.id) ?? 0, settings),
      capacity: row.capacity,
      os: parseOs(row.os),
      pool: row.pool === null ? null : { id: poolIdSchema.parse(row.pool.id), name: row.pool.name },
      owner: row.owner === null ? null : { memberId: memberIdSchema.parse(row.owner.id), name: row.owner.user.name },
    }));
  }),

  /**
   * A runner's page (F-092): the fleet view's row, the token it joined with, who approved it, its
   * boxes now and its last 20 audit entries. An admin reads any runner of the organization; a
   * member only their own personal runner, and any other is `NOT_FOUND`.
   */
  get: memberProcedure.input(z.strictObject({ runnerId: runnerIdSchema })).query(async ({ ctx, input }) => {
    const organizationId = ctx.scope.organizationId;
    const admin = requireOrganizationAdmin(ctx.scope, organizationId).ok;
    const row = await ctx.deps.db.runner.findFirst({
      where: { id: input.runnerId, organizationId, ...(admin ? {} : { kind: "personal" as const, ownerMemberId: ctx.scope.memberId }) },
      select: {
        ...fleetRunnerSelect,
        os: true,
        approvedByMemberId: true,
        drainedByMemberId: true,
        publicKey: true,
        joinToken: { select: { id: true, label: true, revokedAt: true, createdByMemberId: true } },
        owner: { select: { id: true, user: { select: { name: true } } } },
      },
    });
    if (row === null) {
      throw new TRPCError({ code: "NOT_FOUND", message: "No such runner" });
    }
    const runnerId = runnerIdSchema.parse(row.id);
    const [boxes, audit, deciders, fleet] = await Promise.all([
      ctx.deps.db.box.findMany({
        where: { organizationId, runnerId: row.id, state: { in: [...slotHoldingBoxStates] } },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          state: true,
          size: true,
          cpuMillis: true,
          memoryMiB: true,
          createdAt: true,
          waitingReason: true,
          task: { select: { id: true, title: true, ticketKey: true, project: { select: { id: true, name: true } } } },
        },
      }),
      ctx.deps.db.auditEntry.findMany({
        where: { organizationId, entity: "runner", entityId: row.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: RUNNER_AUDIT_ENTRIES,
        select: { id: true, action: true, actorKind: true, actorName: true, createdAt: true },
      }),
      ctx.deps.db.member.findMany({
        where: { organizationId, id: { in: [row.approvedByMemberId, row.drainedByMemberId, row.joinToken?.createdByMemberId ?? null].filter((id): id is string => id !== null) } },
        select: { id: true, user: { select: { name: true } } },
      }),
      fleetInTx(ctx.deps.db, organizationId, { runnerIds: [runnerId] }, { now: ctx.deps.ports.clock.now(), personalSlots: DEFAULT_PERSONAL_RUNNER_SLOTS }),
    ]);
    // The CPU and memory its slot-holding boxes take (ticket 05's `runnerRoom`), against what it
    // offers: `null` where sizes don't apply (`host`, a minor-3 runner).
    const fleetRunner = fleet.runners.find((one) => one.id === runnerId);
    const offered = fleetRunner?.resources ?? null;
    const free = fleetRunner === undefined ? null : runnerRoom(fleetRunner, fleet.boxes).resources;
    const used = offered === null || free === null ? null : { cpuMillis: offered.cpuMillis - free.cpuMillis, memoryMiB: offered.memoryMiB - free.memoryMiB };
    const who = (id: string | null) => {
      const member = id === null ? undefined : deciders.find((one) => one.id === id);
      return id === null ? null : { memberId: memberIdSchema.parse(id), name: member?.user.name ?? null };
    };
    return {
      ...runnerViewOf(row, boxes.length, viewSettings(ctx.deps)),
      capacity: row.capacity,
      os: parseOs(row.os),
      pool: row.pool === null ? null : { id: poolIdSchema.parse(row.pool.id), name: row.pool.name },
      owner: row.owner === null ? null : { memberId: memberIdSchema.parse(row.owner.id), name: row.owner.user.name },
      /** The join token it joined with, by label: never the token. */
      joinToken:
        row.joinToken === null
          ? null
          : { id: joinTokenIdSchema.parse(row.joinToken.id), label: row.joinToken.label, revoked: row.joinToken.revokedAt !== null, createdBy: who(row.joinToken.createdByMemberId) },
      /** Its key's fingerprint, for the admin who approves it (ticket 31): never the key. */
      keyFingerprint: keyFingerprint(row.publicKey),
      approvedAt: row.approvedAt?.getTime() ?? null,
      approvedBy: who(row.approvedByMemberId),
      drainedBy: who(row.drainedByMemberId),
      createdAt: row.createdAt.getTime(),
      used,
      boxes: boxes.map((box) => ({
        id: box.id,
        state: box.state,
        size: box.size,
        /** The size's limits when the box was made; `null` where sizes don't apply. */
        cpuMillis: box.cpuMillis,
        memoryMiB: box.memoryMiB,
        waitingReason: box.waitingReason,
        createdAt: box.createdAt.getTime(),
        task: { id: taskIdSchema.parse(box.task.id), key: box.task.ticketKey, title: box.task.title, project: { id: projectIdSchema.parse(box.task.project.id), name: box.task.project.name } },
      })),
      audit: audit.map((entry) => ({ id: entry.id, action: entry.action, actorKind: entry.actorKind, actorName: entry.actorName, at: entry.createdAt.getTime() })),
    };
  }),

  /**
   * An admin drains a runner (F-092): it takes no new task, and the ones it runs finish. The answer
   * counts the tasks it still runs, which the confirm showed.
   */
  drain: adminProcedure.input(z.strictObject({ runnerId: runnerIdSchema })).mutation(async ({ ctx, input }) => {
    const drained = unwrap(await drainRunner({ db: ctx.deps.db, ...ctx.deps.ports }, ctx.scope, input), {
      forbidden: "FORBIDDEN",
      "not-found": "NOT_FOUND",
      "not-allowed-in-state": "CONFLICT",
    });
    const busy = await busyBoxesByRunner(ctx.deps.db, ctx.scope.organizationId, [input.runnerId]);
    return { runnerId: input.runnerId, state: drained.state, runningTasks: busy.get(input.runnerId) ?? 0 };
  }),

  /**
   * An admin lifts a drain (F-092): online when it's connected, offline otherwise. A runner below
   * minor 4 gets no `resume` command (`commandSent: false`), and takes tasks after it restarts.
   */
  resume: adminProcedure.input(z.strictObject({ runnerId: runnerIdSchema })).mutation(async ({ ctx, input }) => {
    const resumed = unwrap(await resumeRunner({ db: ctx.deps.db, ...ctx.deps.ports }, ctx.scope, input), {
      forbidden: "FORBIDDEN",
      "not-found": "NOT_FOUND",
      "not-draining": "CONFLICT",
    });
    return { runnerId: input.runnerId, state: resumed.state, commandSent: resumed.commandSent };
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
