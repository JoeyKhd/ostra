// What the agent profiles spec needs that the earlier specs may not have left (ticket 42): members
// to list and leave out (milestone 3, Q165: invites are milestone 4), seeded through the domain's
// `seedMember` with better-auth's hash so they can sign in; and a listed model on the built-in
// profile, so a new profile starts with one. The throwaway e2e database only. Run as
// `node e2e/seed-profile-world.ts '<json>'`; prints one JSON line: the members and the project to use.

import { hashPassword } from "better-auth/crypto";

import { createDb } from "@ostra/db";
import { seedMember } from "@ostra/domain";
import { z } from "zod";

const argsSchema = z.strictObject({
  databaseUrl: z.string(),
  password: z.string(),
  usernames: z.array(z.string()).min(1),
});

const args = argsSchema.parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

const members: { username: string; memberId: string }[] = [];
for (const username of args.usernames) {
  const result = await seedMember({ db, hashPassword, env: { NODE_ENV: "test" } }, { username, email: `${username}@example.com`, password: args.password, role: "member" });
  if (result.ok) {
    members.push({ username, memberId: result.seeded.memberId });
    continue;
  }
  if (result.error !== "taken") throw new Error(`seeding ${username} failed: ${result.error}`);
  const user = await db.user.findFirstOrThrow({ where: { username }, select: { members: { select: { id: true } } } });
  members.push({ username, memberId: user.members[0]?.id ?? "" });
}

const organization = await db.organization.findFirstOrThrow({ orderBy: { createdAt: "asc" }, select: { id: true } });
const organizationId = organization.id;
const builtIn = await db.agentProfile.findFirstOrThrow({ where: { organizationId, builtIn: true }, select: { id: true, modelId: true } });
if (builtIn.modelId === null) {
  // A provider row only: no endpoint is called, and the token ref names no stored secret.
  const provider = await db.modelProvider.upsert({
    where: { organizationId_name: { organizationId, name: "e2e-profiles" } },
    create: { organizationId, name: "e2e-profiles", baseUrl: "http://127.0.0.1:9/v1", apiFormat: "anthropic_messages", authScheme: "x_api_key", tokenSecretRef: "builtin:e2e-profiles" },
    update: {},
  });
  // Milestone 4 (F-135): a project serves a model only from a provider on its list; the first is on the default.
  if ((await db.providerListEntry.count({ where: { organizationId, projectId: null } })) === 0) {
    await db.providerListEntry.create({ data: { organizationId, projectId: null, providerId: provider.id } });
  }
  const model = await db.model.upsert({
    where: { providerId_endpointModelId: { providerId: provider.id, endpointModelId: "claude-sonnet-4-5" } },
    create: { organizationId, providerId: provider.id, endpointModelId: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5" },
    update: {},
  });
  // F-135 (ADR 0065 amended 2026-11-20): as the first-run model does, it names the model and its provider.
  await db.agentProfile.update({ where: { id: builtIn.id }, data: { modelId: model.id, providerId: provider.id, modelCustomName: "claude-sonnet-4-5" } });
}

// The project the earlier specs made, if they ran: only the specs that start a task need it.
const project = await db.project.findFirst({ where: { organizationId }, orderBy: { createdAt: "asc" }, select: { name: true } });
process.stdout.write(`${JSON.stringify({ members, projectName: project?.name ?? null })}\n`);
await db.$disconnect();
