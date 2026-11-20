import type { Db } from "@ostra/db";
import { agentProfileIdSchema, boxSizeNameSchema, isReservedLabel, poolIdSchema, projectIdSchema, runnerLabelSchema } from "@ostra/protocol";
import type { PoolId } from "@ostra/protocol";

import { requireOrganizationAdmin, requireProjectAccess } from "../access.ts";
import type { MemberScope } from "../access.ts";
import type { Resources } from "../fleet/capacity.ts";
import type { Ports } from "../ports.ts";
import { enqueueAdmissionInTx } from "./admission.ts";
import { projectPoolsInTx } from "./fleet-rows.ts";
import type { SetBoxSizes, SetProfileLabels, SetProjectPools } from "./m5-signatures.ts";
import { ensureBoxSizes } from "./pools.ts";

// Box sizes, a project's pools and a profile's runner labels (F-095, F-086, F-069, ADR 0059;
// milestone 5's ticket 27). Each write is one transaction with its audit entry and its change
// notice; a change that can let a queued task start asks the pools' admission again
// (`queue.admit`), in the same transaction (ADR 0011, ADR 0037).

/** What these use cases take: the signatures' `M5Deps`, of which they use these. */
export type FleetSettingsDeps = { readonly db: Db } & Pick<Ports, "audit" | "notices" | "clock" | "jobs">;

/** The least a size may be (*working values*): half a vCPU and 1 GiB. */
export const BOX_SIZE_MIN: Resources = { cpuMillis: 500, memoryMiB: 1024 };

/** The most a size may be: 256 vCPUs and 2 TiB, beyond any machine a box runs on. */
export const BOX_SIZE_MAX: Resources = { cpuMillis: 256_000, memoryMiB: 2_097_152 };

/** The most labels a profile may ask for: as many as a runner may carry (`OSTRA_RUNNER_LABELS`). */
export const PROFILE_LABELS_MAX = 64;

/** The most pools a project may list. */
export const PROJECT_POOLS_MAX = 64;

const validSize = (size: Resources): boolean =>
  Number.isInteger(size.cpuMillis) &&
  Number.isInteger(size.memoryMiB) &&
  size.cpuMillis >= BOX_SIZE_MIN.cpuMillis &&
  size.memoryMiB >= BOX_SIZE_MIN.memoryMiB &&
  size.cpuMillis <= BOX_SIZE_MAX.cpuMillis &&
  size.memoryMiB <= BOX_SIZE_MAX.memoryMiB;

/**
 * Why a profile's labels are refused, or `null`: each must match the protocol's label schema, and
 * none may use a built-in prefix (`executor:`, `os:`, `arch:`), which only ostra sets on a runner.
 */
export const profileLabelsRefusal = (labels: readonly string[]): string | null => {
  if (labels.length > PROFILE_LABELS_MAX) {
    return `A profile asks for at most ${String(PROFILE_LABELS_MAX)} labels`;
  }
  for (const label of labels) {
    if (!runnerLabelSchema.safeParse(label).success) {
      return "A label is lowercase letters, digits, dot, dash, underscore, colon or slash, at most 64";
    }
    if (isReservedLabel(label)) {
      return "Labels starting with executor:, os: or arch: are set by ostra on each runner";
    }
  }
  return null;
};

/** An organization admin changes some of its three box sizes; each change is one audit entry. */
export const setBoxSizes = (async (deps: FleetSettingsDeps, scope: MemberScope, input: Parameters<SetBoxSizes>[2]): ReturnType<SetBoxSizes> => {
  if (!requireOrganizationAdmin(scope, scope.organizationId).ok) {
    return { ok: false, error: "forbidden", message: "Only an admin changes the box sizes" };
  }
  const changes = boxSizeNameSchema.options.flatMap((name) => {
    const size = input.sizes[name];
    return size === undefined ? [] : [{ name, size }];
  });
  if (changes.length === 0 || changes.some((change) => !validSize(change.size))) {
    return { ok: false, error: "invalid-input", message: "A size is at least 0.5 vCPU and 1 GiB" };
  }
  const now = deps.clock.now();
  return deps.db.$transaction(async (tx) => {
    const organizationId = scope.organizationId;
    // An organization from before the sizes existed gets its three first, so the update finds its row.
    await ensureBoxSizes(tx, organizationId);
    for (const { name, size } of changes) {
      const before = await tx.boxSize.findFirst({ where: { organizationId, name }, select: { id: true, cpuMillis: true, memoryMiB: true } });
      if (before === null || (before.cpuMillis === size.cpuMillis && before.memoryMiB === size.memoryMiB)) {
        continue;
      }
      await tx.boxSize.update({ where: { id: before.id }, data: { cpuMillis: size.cpuMillis, memoryMiB: size.memoryMiB, updatedByMemberId: scope.memberId } });
      await deps.audit.recordInTx(tx, {
        organizationId,
        projectId: null,
        actor: { kind: "member", id: scope.memberId },
        action: "box-size.updated",
        entity: "organization",
        entityId: organizationId,
        data: { size: name, cpuMillis: size.cpuMillis, memoryMiB: size.memoryMiB, cpuMillisBefore: before.cpuMillis, memoryMiBBefore: before.memoryMiB },
      });
    }
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "organization", entityId: organizationId });
    // A larger size can fit fewer boxes and a smaller one more: every pool's admission looks again.
    const pools = await tx.runnerPool.findMany({ where: { organizationId }, select: { id: true } });
    await enqueueAdmissionInTx(
      deps,
      tx,
      organizationId,
      pools.map((pool) => poolIdSchema.parse(pool.id)),
    );
    return { ok: true as const, changedAt: now };
  });
}) satisfies SetBoxSizes;

/**
 * A project's pools in order, each with its share, and its default size: the project's admins and
 * the organization's. A pool of another organization, or one listed twice, is refused, and nothing
 * changes. The pools it had and has both look at their queues again.
 */
export const setProjectPools = (async (deps: FleetSettingsDeps, scope: MemberScope, input: Parameters<SetProjectPools>[2]): ReturnType<SetProjectPools> => {
  const pools = input.pools;
  if (pools !== undefined) {
    const shares = pools.every((entry) => entry.maxBoxes === null || (Number.isInteger(entry.maxBoxes) && entry.maxBoxes > 0 && entry.maxBoxes <= 100_000));
    if (pools.length === 0 || pools.length > PROJECT_POOLS_MAX || new Set(pools.map((entry) => entry.poolId)).size !== pools.length || !shares) {
      return { ok: false, error: "invalid-input", message: "A project lists at least one pool, each once, with a share of at least one box or none" };
    }
  }
  const now = deps.clock.now();
  return deps.db.$transaction(async (tx) => {
    const organizationId = scope.organizationId;
    const project = await tx.project.findFirst({ where: { id: input.projectId, organizationId }, select: { id: true, access: true, defaultBoxSize: true } });
    if (project === null) {
      return { ok: false as const, error: "not-found" as const, message: "No such project" };
    }
    const projectId = projectIdSchema.parse(project.id);
    const access = requireProjectAccess(scope, { id: projectId, organizationId, access: project.access }, "admin");
    if (!access.ok) {
      return access.code === "not-found"
        ? { ok: false as const, error: "not-found" as const, message: "No such project" }
        : { ok: false as const, error: "forbidden" as const, message: "Only the project's admins change its runners" };
    }
    const before = await projectPoolsInTx(tx, organizationId, projectId);
    const touched: PoolId[] = before.map((entry) => entry.poolId);
    if (pools !== undefined) {
      const found = await tx.runnerPool.count({ where: { organizationId, id: { in: pools.map((entry) => entry.poolId) } } });
      if (found !== pools.length) {
        return { ok: false as const, error: "invalid-input" as const, message: "A pool the project lists isn't one of this organization's" };
      }
      await tx.projectPool.deleteMany({ where: { organizationId, projectId } });
      await tx.projectPool.createMany({
        data: pools.map((entry, position) => ({ organizationId, projectId, poolId: entry.poolId, maxBoxes: entry.maxBoxes, position })),
      });
      touched.push(...pools.map((entry) => entry.poolId));
      await deps.audit.recordInTx(tx, {
        organizationId,
        projectId,
        actor: { kind: "member", id: scope.memberId },
        action: "project.pools-set",
        entity: "project",
        entityId: projectId,
        // Each pool with its share, in order: "<pool>:<boxes or none>,...".
        data: { pools: pools.map((entry) => `${entry.poolId}:${entry.maxBoxes === null ? "none" : String(entry.maxBoxes)}`).join(",") },
      });
    }
    if (input.defaultBoxSize !== undefined && input.defaultBoxSize !== project.defaultBoxSize) {
      await tx.project.update({ where: { id: projectId }, data: { defaultBoxSize: input.defaultBoxSize } });
      await deps.audit.recordInTx(tx, {
        organizationId,
        projectId,
        actor: { kind: "member", id: scope.memberId },
        action: "project.default-box-size-set",
        entity: "project",
        entityId: projectId,
        data: { defaultBoxSize: input.defaultBoxSize },
      });
    }
    await deps.notices.emitInTx(tx, { organizationId, projectId, entity: "project", entityId: projectId });
    await enqueueAdmissionInTx(deps, tx, organizationId, touched);
    return { ok: true as const, changedAt: now };
  });
}) satisfies SetProjectPools;

/** The labels a profile's tasks need on a runner (F-069): organization admins, who edit profiles. */
export const setProfileLabels = (async (deps: FleetSettingsDeps, scope: MemberScope, input: Parameters<SetProfileLabels>[2]): ReturnType<SetProfileLabels> => {
  if (!requireOrganizationAdmin(scope, scope.organizationId).ok) {
    return { ok: false, error: "forbidden", message: "Only an admin changes an agent profile" };
  }
  const refusal = profileLabelsRefusal(input.labels);
  if (refusal !== null) {
    return { ok: false, error: "invalid-input", message: refusal };
  }
  const profileId = agentProfileIdSchema.safeParse(input.profileId);
  if (!profileId.success) {
    return { ok: false, error: "not-found", message: "No such agent profile" };
  }
  const labels = [...new Set(input.labels)].sort();
  const now = deps.clock.now();
  return deps.db.$transaction(async (tx) => {
    const organizationId = scope.organizationId;
    const profile = await tx.agentProfile.findFirst({ where: { id: profileId.data, organizationId, archivedAt: null }, select: { id: true, runnerLabels: true } });
    if (profile === null) {
      return { ok: false as const, error: "not-found" as const, message: "No such agent profile" };
    }
    if (profile.runnerLabels.length === labels.length && profile.runnerLabels.every((label, index) => label === labels[index])) {
      return { ok: true as const, changedAt: now };
    }
    await tx.agentProfile.update({ where: { id: profile.id }, data: { runnerLabels: labels } });
    await deps.audit.recordInTx(tx, {
      organizationId,
      projectId: null,
      actor: { kind: "member", id: scope.memberId },
      action: "agent-profile.updated",
      entity: "agent-profile",
      entityId: profileId.data,
      data: { runnerLabels: labels.join(",") },
    });
    await deps.notices.emitInTx(tx, { organizationId, projectId: null, entity: "agent-profile", entityId: profileId.data });
    return { ok: true as const, changedAt: now };
  });
}) satisfies SetProfileLabels;
