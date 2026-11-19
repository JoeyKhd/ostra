import type { Db } from "@ostra/db";
import { hostCacheKeyFor, serviceVariablesFromDb } from "@ostra/domain";
import { projectIdSchema, runnerLimits } from "@ostra/protocol";

// The task spec's minor-2 environment sections (milestone 3): the checks (F-054, ticket 23), the
// services (F-094, ticket 27) and what the box starts from (F-051, ticket 26). The spec holds each
// service's plain variables only; its secrets go through the credentials endpoint after the lease
// check (`issueTaskCredentials`), never here.

/** The environment's services as the spec carries them, by name. Plain data: `taskSpecSchema` checks it. */
export const specServices = async (db: Db, task: { readonly projectId: string; readonly organizationId: string }): Promise<Record<string, unknown>[]> => {
  const rows = await db.service.findMany({ where: { projectId: task.projectId, organizationId: task.organizationId }, orderBy: { name: "asc" } });
  return rows.map((row) => ({
    name: row.name,
    image: row.image,
    port: row.port,
    variables: serviceVariablesFromDb(row.variables).flatMap((variable) => (variable.kind === "plain" ? [{ name: variable.name, value: variable.value }] : [])),
    healthCheck: row.healthCheck,
  }));
};

/**
 * The environment's checks as the spec carries them, in their order (F-054, ADR 0052): each with
 * its timeout (at most the protocol's), and the repo it runs in, or `null` for the workspace root
 * (Q188). A check naming a repo the task doesn't have is left out: it has nothing to run in.
 */
export const specChecks = async (
  db: Db,
  task: { readonly projectId: string; readonly organizationId: string },
  repoIds: readonly string[],
): Promise<Record<string, unknown>[]> => {
  const rows = await db.check.findMany({ where: { projectId: task.projectId, organizationId: task.organizationId }, orderBy: [{ position: "asc" }, { name: "asc" }] });
  return rows
    .filter((row) => row.repoId === null || repoIds.includes(row.repoId))
    .slice(0, runnerLimits.checksMax)
    .map((row) => ({
      checkId: row.id,
      name: row.name,
      command: row.command,
      repoId: row.repoId,
      timeoutSeconds: Math.min(Math.max(1, row.timeoutSeconds), runnerLimits.checkTimeoutMaxSeconds),
    }));
};

/**
 * The spec's `snapshot` (ADR 0038 as amended): on `docker`, the project's ready snapshot when the
 * chosen runner holds it, and nothing when it doesn't (the box runs the full setup; no runner is
 * passed over for lacking it); on `host`, the key of the project's repo mirrors and dependency
 * cache. Plain data, or `undefined` for none.
 */
export const specSnapshot = async (
  db: Db,
  task: { readonly projectId: string; readonly organizationId: string },
  lease: { readonly runnerId: string; readonly boxId: string },
): Promise<Record<string, unknown> | undefined> => {
  const box = await db.box.findFirst({ where: { id: lease.boxId, organizationId: task.organizationId }, select: { executor: true } });
  const executor = box?.executor ?? null;
  switch (executor) {
    case "host":
      return { kind: "host-cache", cacheKey: hostCacheKeyFor(projectIdSchema.parse(task.projectId)) };
    case "docker": {
      const ready = await db.snapshot.findFirst({
        where: { projectId: task.projectId, organizationId: task.organizationId, state: "ready" },
        orderBy: { readyAt: "desc" },
        select: { id: true, runnerId: true, imageRef: true, digest: true },
      });
      if (ready?.runnerId !== lease.runnerId || ready.imageRef === null || ready.digest === null) {
        return undefined;
      }
      return { kind: "image", snapshotId: ready.id, imageRef: ready.imageRef, digest: ready.digest };
    }
    case "kubernetes":
    case null:
      return undefined;
    default:
      return executor satisfies never;
  }
};
