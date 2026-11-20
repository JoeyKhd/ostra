// What the reasoning effort spec needs (F-137, ticket 63): a provider row listing GPT-5.5 and
// Claude Haiku 5 with their catalog reasoning controls (the bundled catalog's: GPT-5.5 takes
// none to xhigh, Haiku 5 doesn't reason), a member who isn't the driver, and a running task on
// GPT-5.5 driven by the admin, its first turn running at High. The throwaway e2e database only.
// Run as `node e2e/seed-effort.ts '<json>'`; prints one JSON line: the task and the member.

import { randomUUID } from "node:crypto";

import { hashPassword } from "better-auth/crypto";

import { createDb, notifyChannels } from "@ostra/db";
import { seedMember } from "@ostra/domain";
import { taskEventSchema } from "@ostra/protocol";
import { z } from "zod";

const argsSchema = z.strictObject({ databaseUrl: z.string(), password: z.string(), member: z.string() });
const args = argsSchema.parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

const seeded = await seedMember({ db, hashPassword, env: { NODE_ENV: "test" } }, { username: args.member, email: `${args.member}@example.com`, password: args.password, role: "member" });
if (!seeded.ok && seeded.error !== "taken") throw new Error(`seeding ${args.member} failed: ${seeded.error}`);

const admin = await db.member.findFirstOrThrow({ where: { role: "admin" }, orderBy: { createdAt: "asc" } });
const organizationId = admin.organizationId;

// A provider row only: no endpoint is called, and the token ref names no stored secret.
const provider = await db.modelProvider.upsert({
  where: { organizationId_name: { organizationId, name: "e2e-effort" } },
  create: { organizationId, name: "e2e-effort", baseUrl: "http://127.0.0.1:9/v1", apiFormat: "openai_compatible", authScheme: "bearer", tokenSecretRef: "builtin:e2e-effort" },
  update: {},
});
const model = (endpointModelId: string, displayName: string, catalogId: string, catalogReasoning: object) =>
  db.model.upsert({
    where: { providerId_endpointModelId: { providerId: provider.id, endpointModelId } },
    create: { organizationId, providerId: provider.id, endpointModelId, displayName, catalogId, catalogReasoning, contextWindow: 1_050_000, maxOutputTokens: 128_000 },
    update: { catalogReasoning },
  });
const gpt = await model("gpt-5.5", "GPT-5.5", "openai/gpt-5.5", { supported: true, effort: ["none", "low", "medium", "high", "xhigh"] });
await model("claude-haiku-5", "Claude Haiku 5", "anthropic/claude-haiku-5", { supported: false });

// F-135 (ADR 0065 amended 2026-11-20): the profile runs on its provider, whose models its picker offers.
const profile = await db.agentProfile.create({ data: { organizationId, name: `Careful ${randomUUID().slice(0, 6)}`, adapter: "opencode", modelId: gpt.id, modelCatalogId: "openai/gpt-5.5", providerId: provider.id, effort: "high" } });
const project =
  (await db.project.findFirst({ where: { organizationId, slug: "effort" } })) ??
  (await db.project.create({ data: { organizationId, name: "effort", slug: "effort", access: "open" } }));
const task = await db.task.create({
  data: {
    organizationId,
    projectId: project.id,
    kind: "code",
    source: "prompt",
    title: "Think hard about the parser",
    prompt: "Think hard about the parser",
    branchName: `ostra/${randomUUID().slice(0, 8)}-effort`,
    state: "running",
    effort: "high",
    driverMemberId: admin.id,
    creatorMemberId: admin.id,
  },
});
const session = await db.session.create({
  data: { organizationId, projectId: project.id, taskId: task.id, origin: "new", state: "running", agentProfileId: profile.id, providerId: provider.id, modelId: gpt.id },
});
const turnId = randomUUID();
const events = [
  { kind: "user.message", memberId: admin.id, clientMessageId: randomUUID(), text: task.title, delivery: "immediate" },
  { kind: "turn.started", turnId, effort: "high" },
  { kind: "agent.message", turnId, segmentId: "seg-effort", text: "Reading the parser before changing it." },
].map((event) => taskEventSchema.parse(event));
await db.event.createMany({
  data: events.map((event, i) => ({
    organizationId,
    projectId: project.id,
    taskId: task.id,
    seq: i + 1,
    sessionId: session.id,
    sessionSeq: i + 1,
    leaseEpoch: null,
    kind: event.kind,
    payload: event,
    occurredAt: new Date(Date.now() - (events.length - i) * 50),
  })),
});
await db.turn.create({ data: { organizationId, projectId: project.id, taskId: task.id, sessionId: session.id, startSeq: 2, ordinal: 1, effort: "high" } });
await db.task.update({ where: { id: task.id }, data: { eventSeq: events.length } });
await db.session.update({ where: { id: session.id }, data: { ingestedSeq: events.length } });
await db.$executeRaw`SELECT pg_notify(${notifyChannels.taskEvents}, ${JSON.stringify({ taskId: task.id, seq: events.length })})`;

process.stdout.write(`${JSON.stringify({ taskId: task.id, profileId: profile.id })}\n`);
await db.$disconnect();
