import { poolIdSchema, snapshotIdSchema } from "@ostra/protocol";
import { z } from "zod";

import { adminProcedure, router } from "../trpc/init.ts";

// F-120 (milestone 5's ticket 33): what the Registry page shows beside ticket 28's `registry.get`.
// Who set each credential and when (from the audit log, never a value), the `docker` pools that use
// the registry when it's set, where each pushed snapshot was built, and today's credential
// issuances by kind. Admins only, as the registry itself.

const setBySchema = z.object({ name: z.string().nullable(), at: z.number().int() }).nullable();

export const registryUseSchema = z.object({
  credentials: z.object({ push: setBySchema, pull: setBySchema }),
  /** Pools with a `docker` runner: they push and pull there when a registry is set. */
  dockerPools: z.array(z.object({ poolId: poolIdSchema, name: z.string() })),
  /** Where each pushed snapshot was built. */
  builtOn: z.array(z.object({ snapshotId: snapshotIdSchema, runnerName: z.string().nullable(), builder: z.enum(["docker", "buildkit"]).nullable() })),
  /** The day's `registry.credential-issued` entries by kind, since midnight UTC. */
  issuedToday: z.object({ pull: z.number().int(), push: z.number().int() }),
});
export type RegistryUse = z.infer<typeof registryUseSchema>;

const setDataSchema = z.object({ pushChanged: z.boolean().optional(), pullChanged: z.boolean().optional() });
const issuedDataSchema = z.object({ kind: z.enum(["push", "pull"]) });

/** How many `registry.set` entries are read back for who set each credential. */
const SET_ENTRIES_MAX = 200;

export const registryUseRouter = router({
  get: adminProcedure.output(registryUseSchema).query(async ({ ctx }) => {
    const db = ctx.deps.db;
    const organizationId = ctx.scope.organizationId;
    const now = ctx.deps.ports.clock.now();
    const midnight = new Date(now - (now % 86_400_000));
    const [sets, issued, runners, snapshots] = await Promise.all([
      db.auditEntry.findMany({ where: { organizationId, action: "registry.set" }, orderBy: { createdAt: "desc" }, take: SET_ENTRIES_MAX, select: { actorId: true, createdAt: true, data: true } }),
      db.auditEntry.findMany({ where: { organizationId, action: "registry.credential-issued", createdAt: { gte: midnight } }, select: { data: true } }),
      db.runner.findMany({
        where: { organizationId, kind: "pool", executor: "docker", revokedAt: null, state: { not: "revoked" }, poolId: { not: null } },
        distinct: ["poolId"],
        select: { poolId: true, pool: { select: { name: true } } },
      }),
      db.snapshot.findMany({
        where: { organizationId, pushedAt: { not: null }, registryId: { not: null } },
        orderBy: [{ pushedAt: "desc" }, { id: "desc" }],
        take: 200,
        select: { id: true, builder: true, runner: { select: { name: true } } },
      }),
    ]);
    const latest = (field: "pushChanged" | "pullChanged") => sets.find((entry) => setDataSchema.safeParse(entry.data).data?.[field] === true);
    const push = latest("pushChanged");
    const pull = latest("pullChanged");
    const actorIds = [...new Set([push?.actorId, pull?.actorId].filter((id): id is string => typeof id === "string"))];
    const members = await db.member.findMany({ where: { organizationId, id: { in: actorIds } }, select: { id: true, user: { select: { name: true } } } });
    const nameOf = (id: string | null | undefined): string | null => members.find((member) => member.id === id)?.user.name ?? null;
    const kinds = issued.map((entry) => issuedDataSchema.safeParse(entry.data).data?.kind);
    return {
      credentials: {
        push: push === undefined ? null : { name: nameOf(push.actorId), at: push.createdAt.getTime() },
        pull: pull === undefined ? null : { name: nameOf(pull.actorId), at: pull.createdAt.getTime() },
      },
      dockerPools: runners
        .flatMap((runner) => (runner.poolId === null || runner.pool === null ? [] : [{ poolId: poolIdSchema.parse(runner.poolId), name: runner.pool.name }]))
        .sort((a, b) => a.name.localeCompare(b.name)),
      builtOn: snapshots.map((snapshot) => ({ snapshotId: snapshotIdSchema.parse(snapshot.id), runnerName: snapshot.runner?.name ?? null, builder: snapshot.builder })),
      issuedToday: { pull: kinds.filter((kind) => kind === "pull").length, push: kinds.filter((kind) => kind === "push").length },
    };
  }),
});
