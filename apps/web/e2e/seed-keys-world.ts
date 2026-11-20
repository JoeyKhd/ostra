// What the keys-per-project spec needs (F-135, ticket 53): two keys that list one model by its
// catalog ID, a project on each key's own list and one whose list serves nothing, a profile that
// names the model by name, a member and a project admin, a task whose session ran on its key and a
// task queued with no key, with its needs-you item for organization admins. Provider rows only: no
// endpoint is called, and the token refs name no stored secret. The throwaway e2e database only.
// Run as `node e2e/seed-keys-world.ts '<json>'`; prints one JSON line with the IDs the spec opens.

import { randomUUID } from "node:crypto";

import { hashPassword } from "better-auth/crypto";

import { createDb } from "@ostra/db";
import { seedMember } from "@ostra/domain";
import { z } from "zod";

const argsSchema = z.strictObject({ databaseUrl: z.string(), password: z.string() });
const args = argsSchema.parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

const CATALOG_ID = "anthropic/claude-sonnet-4-5";

const member = async (username: string): Promise<string> => {
  const result = await seedMember({ db, hashPassword, env: { NODE_ENV: "test" } }, { username, email: `${username}@example.com`, password: args.password, role: "member" });
  if (result.ok) return result.seeded.memberId;
  if (result.error !== "taken") throw new Error(`seeding ${username} failed: ${result.error}`);
  const user = await db.user.findFirstOrThrow({ where: { username }, select: { members: { select: { id: true } } } });
  return user.members[0]?.id ?? "";
};

const admin = await db.member.findFirstOrThrow({ where: { role: "admin" }, orderBy: { createdAt: "asc" } });
const organizationId = admin.organizationId;
const memberId = await member("keys-member");
const projectAdminId = await member("keys-padmin");

const provider = async (name: string, models: readonly { readonly endpointModelId: string; readonly catalogId: string | null; readonly displayName: string | null }[]) => {
  const row = await db.modelProvider.upsert({
    where: { organizationId_name: { organizationId, name } },
    create: { organizationId, name, baseUrl: `https://${name}.example.test/v1`, apiFormat: "anthropic_messages", authScheme: "x_api_key", tokenSecretRef: `builtin:${name}` },
    update: {},
  });
  const ids: string[] = [];
  for (const model of models) {
    const saved = await db.model.upsert({
      where: { providerId_endpointModelId: { providerId: row.id, endpointModelId: model.endpointModelId } },
      create: { organizationId, providerId: row.id, ...model },
      update: {},
    });
    ids.push(saved.id);
  }
  return { providerId: row.id, modelIds: ids };
};

const sonnet = { endpointModelId: "claude-sonnet-4-5", catalogId: CATALOG_ID, displayName: "Claude Sonnet 4.5" };
const clientA = await provider("client-a", [sonnet]);
// client-b's custom model has a name of its own: 02-setup makes the stub's custom model,
// `local-coder-7b`, the built-in profile's, and a key that listed it would move it in every preview.
const clientB = await provider("client-b", [sonnet, { endpointModelId: "client-b-coder", catalogId: null, displayName: null }]);
const modelOnA = clientA.modelIds[0] ?? "";

// The profile names the model by its catalog ID, saved before the profile's provider (ADR 0065
// amended 2026-11-20): it names no provider, so each project's own key serves it. A later seed puts
// it back after the picker's case gave it one.
const found = await db.agentProfile.findFirst({ where: { organizationId, name: "Builder" } });
const builder =
  found === null
    ? await db.agentProfile.create({ data: { organizationId, name: "Builder", adapter: "opencode", modelId: modelOnA, modelCatalogId: CATALOG_ID } })
    : await db.agentProfile.update({ where: { id: found.id }, data: { modelId: modelOnA, modelCatalogId: CATALOG_ID, modelCustomName: null, providerId: null } });

const project = async (name: string, providerIds: readonly string[]) => {
  const row =
    (await db.project.findFirst({ where: { organizationId, slug: name } })) ??
    (await db.project.create({ data: { organizationId, name, slug: name, access: "open", ownProviders: true, defaultCodeProfileId: builder.id } }));
  await db.providerListEntry.deleteMany({ where: { organizationId, projectId: row.id } });
  for (const providerId of providerIds) {
    await db.providerListEntry.create({ data: { organizationId, projectId: row.id, providerId } });
  }
  return row.id;
};

const calculator = await project("calculator", [clientA.providerId]);
const portal = await project("portal", [clientB.providerId]);
const vault = await project("nokey", []);
await db.projectMember.upsert({
  where: { projectId_memberId: { projectId: calculator, memberId: projectAdminId } },
  create: { organizationId, projectId: calculator, memberId: projectAdminId, role: "admin" },
  update: { role: "admin" },
});

const task = async (projectId: string, title: string, state: "needs_you" | "queued") =>
  db.task.create({
    data: {
      organizationId,
      projectId,
      kind: "code",
      source: "prompt",
      title,
      prompt: title,
      branchName: `ostra/${randomUUID().slice(0, 8)}-keys`,
      state,
      agentProfileId: builder.id,
      ...(state === "needs_you" ? { needsYouReason: "no_changes" as const } : { dispatchWait: { code: "no-provider-for-model", modelName: CATALOG_ID } }),
      driverMemberId: admin.id,
      creatorMemberId: admin.id,
    },
  });

// A task whose session ran on client-a's key: its page names the key.
const ran = await task(calculator, "Add docs/client.md saying this app belongs to client A", "needs_you");
await db.session.create({
  data: { organizationId, projectId: calculator, taskId: ran.id, origin: "new", state: "ended", outcome: "without_changes", endedAt: new Date(), agentProfileId: builder.id, providerId: clientA.providerId, modelId: modelOnA },
});
// A task queued with no key, and the organization admins' needs-you item it raised.
const queued = await task(vault, "Write notes.txt", "queued");
await db.needsYouItem.create({ data: { organizationId, projectId: vault, taskId: queued.id, reason: "no_provider_for_model", audience: "organization_admins" } });

// Home shows needs-you only once setup is done (F-076). Run alone, this spec finishes the setup the
// setup specs would have: a GitHub connection, Linear skipped and a runner online. A full run has
// the first two already. The runner is this spec's own, online whatever else is: setup's runner
// step counts the runners online now, and another spec's seeded runner that is online at this
// seed can be closed by core's presence sweep seconds later, which brings the checklist back.
if ((await db.connection.count({ where: { organizationId, kind: "github" } })) === 0) {
  await db.connection.create({ data: { organizationId, kind: "github", appId: "e2e-keys", slug: "e2e-keys" } });
}
await db.organizationSetting.upsert({ where: { organizationId }, create: { organizationId, linearSkippedAt: new Date() }, update: {} });
const keysRunner = await db.runner.findFirst({ where: { organizationId, name: "e2e-keys-runner" }, select: { id: true } });
if (keysRunner === null) {
  await db.runner.create({
    data: { organizationId, kind: "personal", ownerMemberId: admin.id, name: "e2e-keys-runner", publicKey: `e2e-keys-${randomUUID()}`, executor: "host", capacity: 1, version: "0.0.0", state: "online", lastSeenAt: new Date() },
  });
} else {
  await db.runner.update({ where: { id: keysRunner.id }, data: { state: "online", lastSeenAt: new Date() } });
}

process.stdout.write(
  `${JSON.stringify({ memberId, projectAdminId, calculator, portal, noKey: vault, ranTaskId: ran.id, queuedTaskId: queued.id, builderId: builder.id, clientA: clientA.providerId, clientB: clientB.providerId })}\n`,
);
await db.$disconnect();
