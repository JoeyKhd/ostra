import type { Db } from "@ostra/db";
import { serviceVariablesFromDb } from "@ostra/domain";

// The task spec's minor-2 environment sections (milestone 3): the services (F-094, ticket 27). The
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
