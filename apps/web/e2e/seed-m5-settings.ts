// What milestone 5's settings specs need (tickets 32 and 33), in the throwaway e2e database only.
// Run as `node e2e/seed-m5-settings.ts '<json>'`; prints one JSON line. Its names start `e2e-sizes`
// and `e2e-wait`, apart from ticket 30's `e2e-fleet` world, so the two worlds can share one run.
//
// Scenarios:
// - `runners`: three pools, `e2e-sizes-docker` (a `docker` runner at minor 4 offering 15 vCPU and
//   30 GiB, cap 6), `e2e-sizes-k8s` (a `kubernetes` runner, cap 20) and `e2e-sizes-host` (a `host`
//   runner), and a fourth, `e2e-sizes-extra`, that no project lists; the project `e2e-sizes-app` on
//   the first three in that order, its share of the docker pool 2 with 2 boxes held there (at its
//   share), of the k8s pool 4 with 1 held, none on the host pool; its default size `small`; and the
//   profile `e2e-sizes-fast`. Idempotent by the project's slug.
// - `waits`: the project `e2e-wait-app` (size `small`) on the pool `e2e-wait-pool`, whose one
//   runner is offline. A task for each reason a queued task waits, stored as the dispatch stores it
//   and out of every queue (no starting session, so the queue's sweep leaves it); two tasks in the
//   pool's queue, for their places; a task whose box waits for a node; a task Demo cancelled from
//   the queue; and the member `username` with two personal runners, one offline and one online.
//   Idempotent by the project's slug.
// - `snapshot`: a snapshot of `e2e-wait-app`'s environment pushed to the organization's registry
//   (which must be set), built with BuildKit on `e2e-wait-k8s-01`.

import { randomBytes, randomUUID } from "node:crypto";

import { hashPassword } from "better-auth/crypto";

import { createDb } from "@ostra/db";
import { seedMember } from "@ostra/domain";
import { z } from "zod";

const argsSchema = z.discriminatedUnion("scenario", [
  z.strictObject({ scenario: z.literal("runners"), databaseUrl: z.string(), password: z.string() }),
  z.strictObject({ scenario: z.literal("waits"), databaseUrl: z.string(), password: z.string(), username: z.string() }),
  z.strictObject({ scenario: z.literal("snapshot"), databaseUrl: z.string(), password: z.string() }),
]);
const args = argsSchema.parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

const admin = await db.member.findFirstOrThrow({ where: { role: "admin" }, orderBy: { createdAt: "asc" }, include: { user: { select: { name: true } } } });
const organizationId = admin.organizationId;
const linux = { platform: "linux", arch: "x64", release: "6.8.0" };
/** A presence that core's sweep never closes: the seeded runner reads as connected for the whole run. */
const FOREVER = new Date("2099-01-01T00:00:00Z");

const pool = async (name: string, maxBoxes: number | null) =>
  (await db.runnerPool.findFirst({ where: { organizationId, name } })) ?? db.runnerPool.create({ data: { organizationId, name, maxBoxes } });

const runner = async (poolId: string, name: string, executor: "docker" | "kubernetes" | "host", state: "online" | "offline" = "online") =>
  (await db.runner.findFirst({ where: { organizationId, name } })) ??
  db.runner.create({
    data: {
      organizationId,
      kind: "pool",
      poolId,
      name,
      publicKey: randomBytes(32).toString("base64url"),
      executor,
      processContainment: executor === "host" ? "job_object" : "container",
      capacity: 4,
      slots: 4,
      ...(executor === "host" ? {} : { cpuMillis: 15_000, memoryMiB: 30_720 }),
      labels: [],
      version: "0.5.0",
      minor: 4,
      install: "npm",
      os: linux,
      state,
      lastSeenAt: new Date(),
      approvedAt: new Date(Date.now() - 86_400_000),
      approvedByMemberId: admin.id,
    },
  });

const newTask = async (projectId: string, title: string, state: "running" | "queued" | "preparing" | "stopped") =>
  db.task.create({
    data: {
      organizationId,
      projectId,
      kind: "code",
      source: "prompt",
      title,
      prompt: title,
      branchName: `ostra/${randomUUID().slice(0, 8)}-m5s`,
      state,
      ...(state === "stopped" ? { stoppedReason: "requested" as const } : {}),
      driverMemberId: admin.id,
      creatorMemberId: admin.id,
    },
  });

const box = async (projectId: string, runnerId: string, executor: "docker" | "kubernetes" | "host", title: string) => {
  const task = await newTask(projectId, title, "running");
  await db.session.create({ data: { organizationId, projectId, taskId: task.id, origin: "new", state: "running" } });
  await db.box.create({ data: { organizationId, projectId, taskId: task.id, runnerId, executor, state: "ready", size: "small", cpuMillis: 2000, memoryMiB: 4096 } });
};

const runners = async () => {
  const docker = await pool("e2e-sizes-docker", 6);
  const k8s = await pool("e2e-sizes-k8s", 20);
  const host = await pool("e2e-sizes-host", null);
  const extra = await pool("e2e-sizes-extra", null);
  const dockerRunner = await runner(docker.id, "e2e-sizes-01", "docker");
  const k8sRunner = await runner(k8s.id, "e2e-sizes-k8s-01", "kubernetes");
  await runner(host.id, "e2e-sizes-host-01", "host");
  await runner(extra.id, "e2e-sizes-extra-01", "docker");
  const profile =
    (await db.agentProfile.findFirst({ where: { organizationId, name: "e2e-sizes-fast" } })) ??
    (await db.agentProfile.create({ data: { organizationId, name: "e2e-sizes-fast", adapter: "opencode" } }));
  const found = await db.project.findFirst({ where: { organizationId, slug: "e2e-sizes-app" } });
  if (found !== null) return { projectId: found.id, profileId: profile.id, pools: { docker: docker.id, k8s: k8s.id, host: host.id, extra: extra.id } };
  const project = await db.project.create({ data: { organizationId, name: "e2e-sizes-app", slug: "e2e-sizes-app", access: "open", defaultBoxSize: "small" } });
  await db.projectPool.createMany({
    data: [
      { organizationId, projectId: project.id, poolId: docker.id, position: 0, maxBoxes: 2 },
      { organizationId, projectId: project.id, poolId: k8s.id, position: 1, maxBoxes: 4 },
      { organizationId, projectId: project.id, poolId: host.id, position: 2, maxBoxes: null },
    ],
  });
  await box(project.id, dockerRunner.id, "docker", "Prorate seat changes");
  await box(project.id, dockerRunner.id, "docker", "Retry failed uploads");
  await box(project.id, k8sRunner.id, "kubernetes", "Fix cart badge count");
  return { projectId: project.id, profileId: profile.id, pools: { docker: docker.id, k8s: k8s.id, host: host.id, extra: extra.id } };
};

const member = async (username: string) => {
  const seeded = await seedMember({ db, hashPassword, env: { NODE_ENV: "test" } }, { username, email: `${username}@example.com`, password: args.password, role: "member" });
  if (!seeded.ok && seeded.error !== "taken") throw new Error(`seeding ${username} failed: ${seeded.error}`);
  const user = await db.user.findUniqueOrThrow({ where: { username } });
  return db.member.findFirstOrThrow({ where: { userId: user.id } });
};

const personal = async (ownerMemberId: string, name: string, online: boolean) => {
  const found = await db.runner.findFirst({ where: { organizationId, name } });
  if (found !== null) return found;
  const row = await db.runner.create({
    data: {
      organizationId,
      kind: "personal",
      ownerMemberId,
      name,
      publicKey: randomBytes(32).toString("base64url"),
      executor: "host",
      processContainment: "job_object",
      capacity: 2,
      slots: 2,
      labels: [],
      version: "0.5.0",
      minor: 4,
      install: "npm",
      os: linux,
      state: online ? "online" : "offline",
      lastSeenAt: new Date(),
    },
  });
  if (online) {
    await db.runnerPresence.create({ data: { runnerId: row.id, organizationId, replicaId: "e2e-seeded", connectionEpoch: 1, carrier: "websocket", minor: 4, connectedAt: new Date(), lastSeenAt: FOREVER } });
  }
  return row;
};

/** Every reason the waiting line words that milestone 5 adds, and two it had, as the dispatch stores them. */
const reasons = (poolId: string) =>
  [
    { title: "Waits for a registry", wait: { code: "needs-registry", poolId } },
    { title: "Waits for services", wait: { code: "needs-services" } },
    { title: "Waits for labels", wait: { code: "no-runner-with-labels", labels: ["gpu"] } },
    { title: "Waits for a bigger runner", wait: { code: "size-too-large", size: "large" } },
    { title: "Waits at its share", wait: { code: "project-share-reached", poolId, cap: 2 } },
    { title: "Waits at the pool's cap", wait: { code: "pool-full", poolId } },
    { title: "Waits for a runner online", wait: { code: "no-runner-online" } },
    { title: "Waits for a protocol", wait: { code: "needs-protocol", minor: 4 } },
  ] as const;

const waits = async (username: string) => {
  const waitPool = await pool("e2e-wait-pool", null);
  await runner(waitPool.id, "e2e-wait-01", "docker", "offline");
  const k8sPool = await pool("e2e-wait-k8s", null);
  const k8sRunner = await runner(k8sPool.id, "e2e-wait-k8s-01", "kubernetes");
  const sam = await member(username);
  const samOffline = await personal(sam.id, `${username}-laptop`, false);
  const samOnline = await personal(sam.id, `${username}-desktop`, true);
  const found = await db.project.findFirst({ where: { organizationId, slug: "e2e-wait-app" } });
  const result = async (projectId: string) => ({
    projectId,
    poolId: waitPool.id,
    tasks: await db.task.findMany({ where: { projectId }, orderBy: { createdAt: "asc" }, select: { id: true, title: true } }),
    adminName: admin.user.name,
    personal: { offline: samOffline.name, online: samOnline.name },
  });
  if (found !== null) return result(found.id);
  // A key and a profile with a model, so New task can ask where its task may run; the key isn't
  // allowed on personal runners (the default), so a member's online machine is refused for it.
  const provider = await db.modelProvider.upsert({
    where: { organizationId_name: { organizationId, name: "e2e-wait-key" } },
    create: { organizationId, name: "e2e-wait-key", baseUrl: "https://e2e-wait-key.example.test/v1", apiFormat: "anthropic_messages", authScheme: "x_api_key", tokenSecretRef: "builtin:e2e-wait-key" },
    update: {},
  });
  const model = await db.model.upsert({
    where: { providerId_endpointModelId: { providerId: provider.id, endpointModelId: "claude-sonnet-4-5" } },
    create: { organizationId, providerId: provider.id, endpointModelId: "claude-sonnet-4-5", catalogId: "anthropic/claude-sonnet-4-5", displayName: "Claude Sonnet 4.5" },
    update: {},
  });
  const builder =
    (await db.agentProfile.findFirst({ where: { organizationId, name: "e2e-wait-builder" } })) ??
    (await db.agentProfile.create({ data: { organizationId, name: "e2e-wait-builder", adapter: "opencode", modelId: model.id, modelCatalogId: "anthropic/claude-sonnet-4-5" } }));
  const project = await db.project.create({
    data: { organizationId, name: "e2e-wait-app", slug: "e2e-wait-app", access: "open", defaultBoxSize: "small", ownProviders: true, defaultCodeProfileId: builder.id },
  });
  await db.providerListEntry.create({ data: { organizationId, projectId: project.id, providerId: provider.id } });
  await db.projectPool.create({ data: { organizationId, projectId: project.id, poolId: waitPool.id, position: 0, maxBoxes: 2 } });
  await db.environment.create({ data: { organizationId, projectId: project.id, status: "saved", savedAt: new Date() } });

  // Each reason, out of every queue: no starting session, so the sweep never re-admits it.
  for (const entry of reasons(waitPool.id)) {
    const task = await newTask(project.id, entry.title, "queued");
    await db.task.update({ where: { id: task.id }, data: { dispatchWait: entry.wait, queuedAt: new Date() } });
  }
  // Two in the pool's queue: its one runner is offline, so they stay queued, in this order.
  for (const [i, title] of ["First in the queue", "Second in the queue"].entries()) {
    const task = await newTask(project.id, title, "queued");
    await db.task.update({ where: { id: task.id }, data: { queuePriority: 2, queuedAt: new Date(Date.now() - (10 - i) * 60_000) } });
    await db.session.create({ data: { organizationId, projectId: project.id, taskId: task.id, origin: "new", state: "starting" } });
  }
  // A box the cluster has no node for yet: the dispatch was accepted, and the box waits.
  const nodeWait = await newTask(project.id, "Waits for a node", "preparing");
  await db.session.create({ data: { organizationId, projectId: project.id, taskId: nodeWait.id, origin: "new", state: "starting" } });
  await db.box.create({
    data: { organizationId, projectId: project.id, taskId: nodeWait.id, runnerId: k8sRunner.id, executor: "kubernetes", state: "creating", size: "small", cpuMillis: 2000, memoryMiB: 4096, waitingReason: "node", waitingSince: new Date(Date.now() - 40_000) },
  });
  // Cancelled from the queue by Demo, as `cancelQueuedTask` leaves it.
  const cancelled = await newTask(project.id, "Cancelled from the queue", "stopped");
  const session = await db.session.create({ data: { organizationId, projectId: project.id, taskId: cancelled.id, origin: "new", state: "stopped", endedAt: new Date() } });
  await db.event.create({
    data: { organizationId, projectId: project.id, taskId: cancelled.id, seq: 1, sessionId: session.id, kind: "task.cancelled", payload: { kind: "task.cancelled", memberId: admin.id }, occurredAt: new Date() },
  });
  await db.task.update({ where: { id: cancelled.id }, data: { eventSeq: 1 } });
  return result(project.id);
};

const snapshot = async () => {
  const project = await db.project.findFirstOrThrow({ where: { organizationId, slug: "e2e-wait-app" } });
  const environment = await db.environment.findFirstOrThrow({ where: { projectId: project.id } });
  const registry = await db.registry.findUniqueOrThrow({ where: { organizationId } });
  const k8sRunner = await db.runner.findFirstOrThrow({ where: { organizationId, name: "e2e-wait-k8s-01" } });
  const digest = `sha256:${randomBytes(32).toString("hex")}`;
  const row = await db.snapshot.create({
    data: {
      organizationId,
      projectId: project.id,
      environmentId: environment.id,
      state: "ready",
      reason: "environment-changed",
      digest,
      runnerId: k8sRunner.id,
      registryId: registry.id,
      builder: "buildkit",
      pushedAt: new Date(Date.now() - 2 * 3_600_000),
      readyAt: new Date(Date.now() - 2 * 3_600_000),
      buildDurationMs: 94_000,
    },
  });
  return { snapshotId: row.id, digest, projectId: project.id };
};

switch (args.scenario) {
  case "runners":
    process.stdout.write(`${JSON.stringify(await runners())}\n`);
    break;
  case "waits":
    process.stdout.write(`${JSON.stringify(await waits(args.username))}\n`);
    break;
  case "snapshot":
    process.stdout.write(`${JSON.stringify(await snapshot())}\n`);
    break;
  default:
    args satisfies never;
}
await db.$disconnect();
