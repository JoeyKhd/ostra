// What the preview pane's spec needs (milestone 8, ticket 21, F-141, F-142): a project whose
// environment declares one app process, `web` on 5173 (the primary preview), a `host` runner at
// protocol minor 7 that reports the browser view (the spec's fake box speaks for it on core's
// preview connection, `preview-box.ts`), and three tasks on it: one whose box runs (idle, so the
// warm rule holds it), one whose box is gone (`Start the app`), and one whose runner speaks minor 6.
// The throwaway e2e database only. Run as `node e2e/seed-preview-world.ts '<json>'`:
// - `{ "databaseUrl", "mode": "seed", "tag" }` prints the world's IDs;
// - `{ "databaseUrl", "mode": "accept", "taskId" }` takes the task's newest lease as its runner
//   would (accepted, the box ready), for "Start the app", and prints its epoch;
// - `{ "databaseUrl", "mode": "read", "taskId" }` prints the box's `previewWatchedAt` and the views;
// - `{ "databaseUrl", "mode": "expire", "taskId" }` moves the task's expiring links' ends an hour back.
// Ticket 26 (F-144): `"tunnel": true` on `seed` gives the runner the tunnel too (the native preview);
// `read` names each view's mode and counts the task's native one-time codes; and
// `{ "databaseUrl", "mode": "clear-check" }` forgets the preview domain's last check, so the specs
// after the native preview's see the browser view again.

import { randomUUID } from "node:crypto";

import { createDb, Prisma } from "@ostra/db";
import { postgresChangeNotices } from "@ostra/domain";
import { organizationIdSchema, projectIdSchema, taskIdSchema } from "@ostra/protocol";
import { z } from "zod";

const argsSchema = z.discriminatedUnion("mode", [
  z.strictObject({ databaseUrl: z.string(), mode: z.literal("seed"), tag: z.string().regex(/^[a-z0-9-]{1,24}$/), tunnel: z.boolean().optional() }),
  z.strictObject({ databaseUrl: z.string(), mode: z.literal("accept"), taskId: z.string() }),
  z.strictObject({ databaseUrl: z.string(), mode: z.literal("read"), taskId: z.string() }),
  z.strictObject({ databaseUrl: z.string(), mode: z.literal("expire"), taskId: z.string() }),
  z.strictObject({ databaseUrl: z.string(), mode: z.literal("clear-check") }),
]);
const args = argsSchema.parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

const DbNull = Prisma.DbNull;

/** A presence and a runner seen "now" for good: core's sweeps never take them for gone. */
const FOREVER = new Date("2099-01-01T00:00:00Z");

/** The task's change notice, so an open page refetches what it shows of it. */
const notifyTask = async (organizationId: string, projectId: string, taskId: string): Promise<void> => {
  await db.$transaction((tx) => postgresChangeNotices.emitInTx(tx, { organizationId: organizationIdSchema.parse(organizationId), projectId: projectIdSchema.parse(projectId), entity: "task", entityId: taskIdSchema.parse(taskId) }));
};

const seed = async (tag: string, tunnel: boolean): Promise<Record<string, string>> => {
  const admin = await db.member.findFirstOrThrow({ where: { role: "admin" }, orderBy: { createdAt: "asc" }, include: { organization: true } });
  const organizationId = admin.organizationId;

  const provider = await db.modelProvider.upsert({
    where: { organizationId_name: { organizationId, name: "preview-key" } },
    create: { organizationId, name: "preview-key", baseUrl: "https://preview-key.example.test/v1", apiFormat: "anthropic_messages", authScheme: "x_api_key", tokenSecretRef: "builtin:preview-key", allowOnPersonalRunners: true },
    update: { allowOnPersonalRunners: true },
  });
  const model = await db.model.upsert({
    where: { providerId_endpointModelId: { providerId: provider.id, endpointModelId: "claude-sonnet-4-5" } },
    create: { organizationId, providerId: provider.id, endpointModelId: "claude-sonnet-4-5", catalogId: "anthropic/claude-sonnet-4-5", displayName: "Claude Sonnet 4.5", inputPricePerMTok: 3, outputPricePerMTok: 15, priceSource: "catalog" },
    update: {},
  });
  const profile =
    (await db.agentProfile.findFirst({ where: { organizationId, name: "Previewer" } })) ??
    (await db.agentProfile.create({ data: { organizationId, name: "Previewer", adapter: "opencode", modelId: model.id, modelCatalogId: "anthropic/claude-sonnet-4-5" } }));

  const slug = `preview-${tag}`;
  const project = await db.project.create({ data: { organizationId, name: slug, slug, access: "open", ownProviders: true, defaultCodeProfileId: profile.id } });
  await db.providerListEntry.create({ data: { organizationId, projectId: project.id, providerId: provider.id } });
  const connection = await db.connection.findFirstOrThrow({ where: { organizationId, kind: "github" }, orderBy: { createdAt: "asc" } });
  const installation = await db.codeHostInstallation.findFirstOrThrow({ where: { organizationId, connectionId: connection.id }, orderBy: { createdAt: "asc" } });
  const repo = await db.repo.create({
    data: { organizationId, projectId: project.id, connectionId: connection.id, installationId: installation.installationId, hostRepoId: `e2e-preview-${randomUUID().slice(0, 8)}`, fullName: `ostra-test/${slug}`, defaultBranch: "main", checkoutDir: "calculator-web" },
  });
  const environment =
    (await db.environment.findUnique({ where: { projectId: project.id } })) ??
    (await db.environment.create({ data: { organizationId, projectId: project.id, status: "saved" } }));
  await db.appProcess.create({
    data: { organizationId, projectId: project.id, environmentId: environment.id, repoId: repo.id, name: "web", command: "pnpm dev", port: 5173, readyKind: "port", label: "web", primary: true },
  });

  // The fake box's runner: `host`, minor 7, the browser view and no tunnel, online for good.
  const runnerOf = async (name: string, minor: number) => {
    const runner = await db.runner.create({
      data: {
        organizationId,
        kind: "personal",
        ownerMemberId: admin.id,
        name,
        publicKey: `e2e-preview-${randomUUID()}`,
        executor: "host",
        capacity: 4,
        slots: 4,
        version: "0.8.0",
        minor,
        ...(minor >= 7 ? { preview: { stream: true, tunnel } } : {}),
        state: "online",
        lastSeenAt: FOREVER,
      },
    });
    await db.runnerPresence.create({ data: { runnerId: runner.id, organizationId, replicaId: "e2e-preview", connectionEpoch: 1, carrier: "websocket", minor, connectedAt: new Date(), lastSeenAt: FOREVER } });
    return runner;
  };
  const runner = await runnerOf(`preview-box-${tag}`, 7);
  const oldRunner = await runnerOf(`preview-old-${tag}`, 6);

  // A second project, whose environment declares no app process: nothing to preview.
  const bare = await db.project.create({ data: { organizationId, name: `${slug}-bare`, slug: `${slug}-bare`, access: "open", ownProviders: true, defaultCodeProfileId: profile.id } });

  const taskOn = async (title: string, runnerId: string, state: "running" | "stopped", projectId: string = project.id) => {
    const task = await db.task.create({
      data: {
        organizationId,
        projectId,
        kind: "code",
        source: "prompt",
        title,
        prompt: title,
        branchName: `ostra/${randomUUID().slice(0, 8)}-history-panel`,
        state,
        ...(state === "stopped" ? { stoppedReason: "requested" as const } : {}),
        agentProfileId: profile.id,
        driverMemberId: admin.id,
        creatorMemberId: admin.id,
        runnerId,
        leaseEpoch: 1,
      },
    });
    const session = await db.session.create({
      data: { organizationId, projectId, taskId: task.id, origin: "new", state: state === "running" ? "idle" : "stopped", agentProfileId: profile.id, providerId: provider.id, modelId: model.id },
    });
    const box = await db.box.create({
      data:
        state === "running"
          ? { organizationId, projectId, taskId: task.id, runnerId, executor: "host", state: "idle", readyAt: new Date(Date.now() - 5 * 60_000), idleSince: new Date(Date.now() - 2 * 60_000) }
          : { organizationId, projectId, taskId: task.id, runnerId, executor: "host", state: "released", releasedAt: new Date(Date.now() - 10 * 60_000), stoppedAt: new Date(Date.now() - 10 * 60_000) },
    });
    await db.session.update({ where: { id: session.id }, data: { boxId: box.id } });
    await db.lease.create({
      data:
        state === "running"
          ? { organizationId, projectId, taskId: task.id, epoch: 1, runnerId, boxId: box.id, state: "active", acceptedAt: new Date() }
          : { organizationId, projectId, taskId: task.id, epoch: 1, runnerId, boxId: box.id, state: "ended", acceptedAt: new Date(Date.now() - 20 * 60_000), endedAt: new Date(Date.now() - 10 * 60_000), endReason: "stopped" },
    });
    return task.id;
  };
  const liveTaskId = await taskOn("Add a history panel", runner.id, "running");
  const stoppedTaskId = await taskOn("Keep the last 50 results", runner.id, "stopped");
  const oldTaskId = await taskOn("Fix rounding in percent mode", oldRunner.id, "running");
  const noneTaskId = await taskOn("Add a CONTRIBUTING.md", runner.id, "running", bare.id);

  return {
    organizationId,
    organizationName: admin.organization.name,
    projectId: project.id,
    projectName: project.name,
    runnerId: runner.id,
    runnerName: runner.name,
    liveTaskId,
    stoppedTaskId,
    oldTaskId,
    noneTaskId,
  };
};

const accept = async (taskId: string): Promise<Record<string, string | number>> => {
  const lease = await db.lease.findFirstOrThrow({ where: { taskId, state: "active" }, orderBy: { epoch: "desc" } });
  await db.lease.update({ where: { id: lease.id }, data: { acceptedAt: new Date() } });
  await db.box.update({ where: { id: lease.boxId }, data: { state: "ready", readyAt: new Date() } });
  await notifyTask(lease.organizationId, lease.projectId, taskId);
  return { leaseEpoch: lease.epoch, purpose: lease.purpose };
};

const read = async (taskId: string): Promise<Record<string, unknown>> => {
  const lease = await db.lease.findFirst({ where: { taskId, state: "active" }, orderBy: { epoch: "desc" }, include: { box: true } });
  const views = await db.previewView.findMany({ where: { taskId }, orderBy: { openedAt: "asc" }, select: { id: true, state: true, lastHeartbeatAt: true, leaseEpoch: true, linkId: true, mode: true } });
  return {
    previewWatchedAt: lease?.box.previewWatchedAt?.getTime() ?? null,
    views: views.map((view) => ({ id: view.id, state: view.state, lastHeartbeatAt: view.lastHeartbeatAt.getTime(), leaseEpoch: view.leaseEpoch, linkId: view.linkId, mode: view.mode })),
    enterCodes: await db.previewCode.count({ where: { taskId, kind: "enter" } }),
  };
};

const expire = async (taskId: string): Promise<Record<string, number>> => {
  const moved = await db.previewLink.updateMany({ where: { taskId, kind: "expiring", revokedAt: null }, data: { expiresAt: new Date(Date.now() - 60 * 60_000) } });
  return { expired: moved.count };
};

const clearCheck = async (): Promise<Record<string, number>> => {
  const cleared = await db.instanceSetting.updateMany({ data: { previewCheckDomain: null, previewCheck: DbNull, previewCheckAt: null, previewCheckByUserId: null } });
  return { cleared: cleared.count };
};

const run = (): Promise<Record<string, unknown>> => {
  switch (args.mode) {
    case "seed":
      return seed(args.tag, args.tunnel ?? false);
    case "accept":
      return accept(args.taskId);
    case "expire":
      return expire(args.taskId);
    case "read":
      return read(args.taskId);
    case "clear-check":
      return clearCheck();
    default:
      return args satisfies never;
  }
};
const out = await run();
process.stdout.write(`${JSON.stringify(out)}\n`);
await db.$disconnect();
