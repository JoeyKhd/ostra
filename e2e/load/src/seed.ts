import type { Db } from "@ostra/db";
import { ensureBuiltInAgentProfile } from "@ostra/domain";
import { organizationIdSchema, projectIdSchema } from "@ostra/protocol";
import type { OrganizationId, ProjectId } from "@ostra/protocol";

// What the load test needs before its first task, written straight to the database (ticket 34):
// a project on one repo of a GitHub connection, and a model on the built-in profile. None of it is
// measured, and none of it is called: the simulated runners never fetch a task's spec, so no App
// key, no endpoint and no token is needed. Everything the test measures (the pool, its join token,
// approvals, tasks and steers) goes through `packages/api`.

export type LoadWorld = { readonly organizationId: OrganizationId; readonly projectId: ProjectId };

export const seedLoadWorld = async (db: Db): Promise<LoadWorld> => {
  const organization = await db.organization.findFirstOrThrow({ orderBy: { createdAt: "asc" }, select: { id: true } });
  const organizationId = organizationIdSchema.parse(organization.id);
  const connection = await db.connection.upsert({
    where: { organizationId_kind_appId: { organizationId, kind: "github", appId: "load-test" } },
    create: { organizationId, kind: "github", appId: "load-test", slug: "load-test" },
    update: {},
  });
  await db.codeHostInstallation.upsert({
    where: { connectionId_installationId: { connectionId: connection.id, installationId: "1" } },
    create: { organizationId, connectionId: connection.id, installationId: "1", accountLogin: "ostra-test", accountKind: "organization" },
    update: {},
  });
  const project = await db.project.upsert({
    where: { organizationId_slug: { organizationId, slug: "load" } },
    create: { organizationId, name: "load", slug: "load", access: "open" },
    update: {},
  });
  const projectId = projectIdSchema.parse(project.id);
  if ((await db.repo.count({ where: { projectId } })) === 0) {
    await db.repo.create({
      data: { organizationId, projectId, connectionId: connection.id, installationId: "1", hostRepoId: "1", fullName: "ostra-test/load", defaultBranch: "main", checkoutDir: "load" },
    });
  }
  const builtInId = await db.$transaction((tx) => ensureBuiltInAgentProfile(tx, organizationId));
  // A provider row only: nothing calls it, and its token reference names no stored secret.
  const provider = await db.modelProvider.upsert({
    where: { organizationId_name: { organizationId, name: "load" } },
    create: { organizationId, name: "load", baseUrl: "http://127.0.0.1:9/v1", apiFormat: "anthropic_messages", authScheme: "x_api_key", tokenSecretRef: "builtin:load" },
    update: {},
  });
  if ((await db.providerListEntry.count({ where: { organizationId, projectId: null, providerId: provider.id } })) === 0) {
    await db.providerListEntry.create({ data: { organizationId, projectId: null, providerId: provider.id } });
  }
  const model = await db.model.upsert({
    where: { providerId_endpointModelId: { providerId: provider.id, endpointModelId: "load-model" } },
    create: { organizationId, providerId: provider.id, endpointModelId: "load-model", displayName: "Load model" },
    update: {},
  });
  await db.agentProfile.update({ where: { id: builtInId }, data: { modelId: model.id } });
  return { organizationId, projectId };
};
