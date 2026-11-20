// What the spend-and-budgets spec needs (F-037, ticket 36): a project with its own key and a priced
// model, $50.00 of spend this month in the rollup (`SpendDaily`), a profile that is the project's
// default, and a task whose session is idle on a runner, so a message to it is a turn start the
// budget gate can hold. No endpoint is called. The throwaway e2e database only.
// Run as `node e2e/seed-budget-world.ts '<json>'`; prints one JSON line with the IDs the spec opens.

import { randomUUID } from "node:crypto";

import { createDb } from "@ostra/db";
import { z } from "zod";

const argsSchema = z.strictObject({ databaseUrl: z.string() });
const args = argsSchema.parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

const CATALOG_ID = "anthropic/claude-sonnet-4-5";
const PROJECT = "budgets";

const admin = await db.member.findFirstOrThrow({ where: { role: "admin" }, orderBy: { createdAt: "asc" } });
const organizationId = admin.organizationId;

const provider = await db.modelProvider.upsert({
  where: { organizationId_name: { organizationId, name: "budget-key" } },
  create: { organizationId, name: "budget-key", baseUrl: "https://budget-key.example.test/v1", apiFormat: "anthropic_messages", authScheme: "x_api_key", tokenSecretRef: "builtin:budget-key", allowOnPersonalRunners: true },
  update: { allowOnPersonalRunners: true },
});
const model = await db.model.upsert({
  where: { providerId_endpointModelId: { providerId: provider.id, endpointModelId: "claude-sonnet-4-5" } },
  create: { organizationId, providerId: provider.id, endpointModelId: "claude-sonnet-4-5", catalogId: CATALOG_ID, displayName: "Claude Sonnet 4.5", inputPricePerMTok: 3, outputPricePerMTok: 15, priceSource: "catalog" },
  update: {},
});
const profile =
  (await db.agentProfile.findFirst({ where: { organizationId, name: "Budgeter" } })) ??
  (await db.agentProfile.create({ data: { organizationId, name: "Budgeter", adapter: "opencode", modelId: model.id, modelCatalogId: CATALOG_ID } }));

// A fresh project each run, so a budget an earlier run set doesn't carry over.
const old = await db.project.findFirst({ where: { organizationId, slug: PROJECT } });
if (old !== null) {
  await db.budget.deleteMany({ where: { organizationId, projectId: old.id } });
  await db.project.delete({ where: { id: old.id } });
}
const project = await db.project.create({ data: { organizationId, name: PROJECT, slug: PROJECT, access: "open", ownProviders: true, defaultCodeProfileId: profile.id } });
await db.providerListEntry.create({ data: { organizationId, projectId: project.id, providerId: provider.id } });
// A repo, through a linked installation of the GitHub connection (a full run has one already).
const connection =
  (await db.connection.findFirst({ where: { organizationId, kind: "github" } })) ??
  (await db.connection.create({ data: { organizationId, kind: "github", appId: "e2e-budget", slug: "e2e-budget" } }));
await db.codeHostInstallation.upsert({
  where: { connectionId_installationId: { connectionId: connection.id, installationId: "e2e-budget-installation" } },
  create: { organizationId, connectionId: connection.id, installationId: "e2e-budget-installation", accountLogin: "ostra-test", accountKind: "organization" },
  update: {},
});
await db.repo.create({
  data: { organizationId, projectId: project.id, connectionId: connection.id, installationId: "e2e-budget-installation", hostRepoId: `e2e-budget-${randomUUID().slice(0, 8)}`, fullName: "ostra-test/budgets", defaultBranch: "main", checkoutDir: "budgets" },
});

// $50.00 spent today, in the rollup every figure reads.
const now = new Date();
const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
await db.spendDaily.create({ data: { organizationId, projectId: project.id, day, modelId: model.id, inputTokens: 4_000_000n, outputTokens: 2_533_333n, spentMicroUsd: 50_000_000n } });

// A runner, and a task whose session is idle on it: the composer's message starts a turn.
const runner = await db.runner.create({
  data: { organizationId, kind: "personal", ownerMemberId: admin.id, name: `e2e-budget-${randomUUID().slice(0, 6)}`, publicKey: `e2e-budget-${randomUUID()}`, executor: "host", capacity: 1, version: "0.0.0", state: "online", lastSeenAt: new Date() },
});
const task = await db.task.create({
  data: {
    organizationId,
    projectId: project.id,
    kind: "code",
    source: "prompt",
    title: "Add a CONTRIBUTING.md with three short rules",
    prompt: "Add a CONTRIBUTING.md with three short rules",
    branchName: `ostra/${randomUUID().slice(0, 8)}-contributing`,
    state: "running",
    agentProfileId: profile.id,
    driverMemberId: admin.id,
    creatorMemberId: admin.id,
    runnerId: runner.id,
    leaseEpoch: 1,
  },
});
await db.session.create({ data: { organizationId, projectId: project.id, taskId: task.id, origin: "new", state: "idle", agentProfileId: profile.id, providerId: provider.id, modelId: model.id } });
const box = await db.box.create({ data: { organizationId, projectId: project.id, taskId: task.id, runnerId: runner.id, executor: "host", state: "ready" } });
await db.lease.create({ data: { organizationId, projectId: project.id, taskId: task.id, epoch: 1, runnerId: runner.id, boxId: box.id, state: "active", acceptedAt: new Date() } });

process.stdout.write(`${JSON.stringify({ projectId: project.id, idleTaskId: task.id, modelId: model.id })}\n`);
await db.$disconnect();
