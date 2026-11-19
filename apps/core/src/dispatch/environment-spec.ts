import type { Db } from "@ostra/db";
import { serviceVariablesFromDb } from "@ostra/domain";
import { runnerLimits } from "@ostra/protocol";

// The task spec's minor-2 environment sections (milestone 3): the checks (F-054, ticket 23) and the
// services (F-094, ticket 27). The
// spec holds each service's plain variables only; its secrets go through the credentials endpoint
// after the lease check (`issueTaskCredentials`), never here.

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
