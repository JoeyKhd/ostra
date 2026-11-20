// What the environment proposal's spec needs (F-113, milestone 6's ticket 36), in a project the
// spec made through New project on the fake GitHub's `test1` and whose onboarding task it started
// with "Test this environment": the proposing fake's proposal (adapter-sdk's `sampleProposal`),
// stored as core's `environment-proposal` endpoint stores it (the domain's `proposeEnvironment`,
// with milestone 4's secret scan, on the server's own secret store), and the `AGENTS.md` PR and the
// filtered commit the runner reports. The throwaway e2e database only.
// Run as `node e2e/seed-onboarding-world.ts '<json>'`; prints one JSON line.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { silentLogger, systemClock as adapterClock } from "@ostra/adapter-sdk";
import type { SecretRowStore } from "@ostra/adapter-sdk";
import { sampleProposal } from "@ostra/adapter-sdk/testing";
import { BuiltinSecretStore, parseSecretsKey } from "@ostra/adapter-secret-store-builtin";
import { createDb } from "@ostra/db";
import { postgresChangeNotices, proposeEnvironment, systemClock } from "@ostra/domain";
import { organizationIdSchema, repoFullNameSchema, repoIdSchema, taskIdSchema } from "@ostra/protocol";
import { z } from "zod";

const args = z
  .strictObject({
    databaseUrl: z.string(),
    dataDir: z.string(),
    projectId: z.string(),
    /** `model`: before the start, give the project's code profile a model its list serves (the stack has none); `propose`: the proposal. */
    step: z.enum(["model", "propose"]),
  })
  .parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

const secretRows: SecretRowStore = {
  insert: async (row) => {
    await db.secret.create({ data: { id: row.id, organizationId: row.organizationId, purpose: row.purpose, ciphertext: Uint8Array.from(row.ciphertext), nonce: Uint8Array.from(row.nonce), keyVersion: row.keyVersion } });
  },
  get: async (id) => {
    const row = await db.secret.findUnique({ where: { id } });
    return row === null ? undefined : { id: row.id, organizationId: organizationIdSchema.parse(row.organizationId), purpose: row.purpose, ciphertext: row.ciphertext, nonce: row.nonce, keyVersion: row.keyVersion };
  },
  delete: async (id) => (await db.secret.deleteMany({ where: { id } })).count > 0,
};
const key = parseSecretsKey((await readFile(path.join(args.dataDir, "secrets-key"), "utf8")).trim());
if (!key.ok) throw new Error("the stack's secrets key didn't parse");
const secretStore = new BuiltinSecretStore({ rows: secretRows, key: key.value }, { logger: silentLogger, clock: adapterClock });

const project = await db.project.findUniqueOrThrow({ where: { id: args.projectId }, include: { repos: { orderBy: { position: "asc" } } } });
const organizationId = organizationIdSchema.parse(project.organizationId);
const repo = project.repos[0];
if (repo === undefined) throw new Error("the project has no repo");
if (args.step === "model") {
  // A provider on the organization's list, serving one model, pinned on the project's code profile.
  const provider = await db.modelProvider.upsert({
    where: { organizationId_name: { organizationId, name: "e2e-onboarding" } },
    create: { organizationId, name: "e2e-onboarding", baseUrl: "https://e2e-onboarding.example.test/v1", apiFormat: "anthropic_messages", authScheme: "x_api_key", tokenSecretRef: "builtin:e2e-onboarding" },
    update: {},
  });
  const model = await db.model.upsert({
    where: { providerId_endpointModelId: { providerId: provider.id, endpointModelId: "claude-sonnet-4-5" } },
    create: { organizationId, providerId: provider.id, endpointModelId: "claude-sonnet-4-5", catalogId: null, displayName: "Claude Sonnet 4.5" },
    update: {},
  });
  if ((await db.providerListEntry.count({ where: { organizationId, projectId: null, providerId: provider.id } })) === 0) {
    await db.providerListEntry.create({ data: { organizationId, projectId: null, providerId: provider.id } });
  }
  const profileId = project.defaultCodeProfileId ?? (await db.agentProfile.findFirstOrThrow({ where: { organizationId, builtIn: true }, select: { id: true } })).id;
  await db.agentProfile.update({ where: { id: profileId }, data: { modelId: model.id, modelCatalogId: null, modelCustomName: null, providerId: provider.id } });
  process.stdout.write(`${JSON.stringify({ profileId })}\n`);
  await db.$disconnect();
  process.exit(0);
}

const task = await db.task.findFirstOrThrow({ where: { projectId: project.id, onboarding: true }, orderBy: { createdAt: "desc" } });
const taskId = taskIdSchema.parse(task.id);

// The proposing fake's proposal, its repo named by the project's repo (core's endpoint maps a name to its ID).
const sample = sampleProposal(repoFullNameSchema.parse(repo.fullName));
const made = await proposeEnvironment(
  { db, jobs: { enqueueInTx: () => Promise.resolve() }, notices: postgresChangeNotices, clock: systemClock, adapters: { secretStore } },
  {
    organizationId,
    taskId,
    proposal: {
      repos: sample.repos.map((proposed) => ({ repoId: repoIdSchema.parse(repo.id), setupScript: proposed.setupScript, checks: proposed.checks, variableNames: proposed.variableNames })),
      services: sample.services,
      notes: "The tests need a database, so I added Postgres and its URL by name. pnpm install needs corepack first.",
    },
  },
);
if (!made.ok) throw new Error(`the proposal was refused: ${made.error}`);

// The runner's report: the AGENTS.md PR it opened, and the files its commit left out.
await db.task.update({ where: { id: taskId }, data: { state: "needs_you", needsYouReason: "environment_proposal" } });
const taskRepo = await db.taskRepo.findFirst({ where: { taskId } });
if (taskRepo !== null) {
  await db.taskRepo.update({ where: { id: taskRepo.id }, data: { state: "pr_open", headSha: "a".repeat(40), prNumber: 97, prUrl: `https://github.com/${repo.fullName}/pull/97`, prTitle: "Add AGENTS.md" } });
}
const session = await db.session.findFirst({ where: { taskId }, orderBy: { startedAt: "desc" } });
if (session !== null) {
  // The runner's own event, numbered as core's ingest numbers it.
  const seq = (await db.task.findUniqueOrThrow({ where: { id: taskId } })).eventSeq + 1;
  await db.event.create({
    data: { organizationId, projectId: project.id, taskId, seq, sessionId: session.id, kind: "commit.filtered", occurredAt: new Date(), payload: { kind: "commit.filtered", repoId: repo.id, kept: ["AGENTS.md"], dropped: ["package.json", ".npmrc"], droppedCount: 2 } },
  });
  await db.task.update({ where: { id: taskId }, data: { eventSeq: seq } });
}

process.stdout.write(`${JSON.stringify({ proposalId: made.proposalId, taskId })}\n`);
await db.$disconnect();
