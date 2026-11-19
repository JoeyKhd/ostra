// Seeds what the environment's services page needs from outside the panel (ticket 48): the
// throwaway e2e database only. Run as `node e2e/seed-services.ts '<json>'`; prints one JSON line.
//
// Scenarios:
// - `host-runner`: a `host` runner of the project's pools, online now (its presence just seen), as a
//   runner's `hello` leaves it. It can't start services.
// - `waiting-task`: a queued task of the project whose dispatch waits for a runner that can start
//   services, with the runners online, as core's dispatch writes it (`needs-services-runner`).
// - `showcase`: the target's picture (environment-services.md): two `docker` runners of the project's
//   pool online, three services with their health on the last box, three checks and a ready
//   snapshot built on `build-01`, for the screenshot compared with the target.

import { randomBytes } from "node:crypto";

import { createDb } from "@ostra/db";
import { dispatchWaitColumns } from "@ostra/domain";
import { projectIdSchema, taskIdSchema } from "@ostra/protocol";
import { z } from "zod";

const argsSchema = z.strictObject({
  databaseUrl: z.string(),
  projectId: projectIdSchema,
  scenario: z.enum(["host-runner", "waiting-task", "showcase"]),
  runnerName: z.string().min(1).max(60).optional(),
});

const args = argsSchema.parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

const main = async (): Promise<void> => {
  const project = await db.project.findUniqueOrThrow({ where: { id: args.projectId }, include: { pools: true } });
  const organizationId = project.organizationId;
  const runnerName = args.runnerName ?? `e2e-host-${randomBytes(2).toString("hex")}`;
  if (args.scenario === "host-runner") {
    const listed = project.pools[0]?.poolId;
    const poolId = listed ?? (await db.runnerPool.findFirstOrThrow({ where: { organizationId, isDefault: true }, select: { id: true } })).id;
    const runner = await db.runner.create({
      data: {
        organizationId,
        kind: "pool",
        poolId,
        name: runnerName,
        publicKey: randomBytes(32).toString("base64url"),
        executor: "host",
        capacity: 1,
        version: "0.0.0",
        state: "online",
      },
      select: { id: true },
    });
    await db.runnerPresence.create({ data: { runnerId: runner.id, organizationId, replicaId: "e2e-seed", connectionEpoch: 1, carrier: "websocket", minor: 2 } });
    console.log(JSON.stringify({ runnerId: runner.id, runnerName }));
    return;
  }
  if (args.scenario === "showcase") {
    await showcase(organizationId, project.id, project.pools[0]?.poolId ?? null);
    console.log(JSON.stringify({ projectId: project.id }));
    return;
  }
  const member = await db.member.findFirstOrThrow({ where: { organizationId, role: "admin" }, orderBy: { createdAt: "asc" } });
  const wait = { code: "needs-services-runner" as const, online: [{ name: runnerName, executor: "host" as const }] };
  const task = await db.task.create({
    data: {
      organizationId,
      projectId: project.id,
      kind: "code",
      source: "prompt",
      title: "Add a migration for the orders table",
      prompt: "Add a migration for the orders table",
      branchName: `ostra/${randomBytes(4).toString("hex")}-add-a-migration`,
      state: "queued",
      creatorMemberId: member.id,
      driverMemberId: member.id,
      ...dispatchWaitColumns(wait),
    },
    select: { id: true },
  });
  console.log(JSON.stringify({ taskId: taskIdSchema.parse(task.id) }));
};

const showcase = async (organizationId: string, projectId: string, listedPool: string | null): Promise<void> => {
  const poolId = listedPool ?? (await db.runnerPool.findFirstOrThrow({ where: { organizationId, isDefault: true }, select: { id: true } })).id;
  await db.runnerPool.update({ where: { id: poolId }, data: { name: "build-fleet" } });
  const environment = await db.environment.findUniqueOrThrow({ where: { projectId } });
  const runners: string[] = [];
  for (const name of ["build-01", "build-02"]) {
    const runner = await db.runner.create({
      data: { organizationId, kind: "pool", poolId, name, publicKey: randomBytes(32).toString("base64url"), executor: "docker", capacity: 4, version: "0.0.0", state: "online" },
      select: { id: true },
    });
    await db.runnerPresence.create({ data: { runnerId: runner.id, organizationId, replicaId: "e2e-seed", connectionEpoch: 1, carrier: "websocket", minor: 2 } });
    runners.push(runner.id);
  }
  const [builder = ""] = runners;
  const base = { organizationId, projectId, environmentId: environment.id };
  await db.service.createMany({
    data: [
      { ...base, name: "db", image: "postgres:17", port: 5432, healthCheck: "pg_isready -U app", variables: [{ kind: "plain", name: "POSTGRES_USER", value: "app" }, { kind: "plain", name: "POSTGRES_DB", value: "app" }, { kind: "secret", name: "POSTGRES_PASSWORD", secretRef: "db:e2e-showcase-not-stored" }] },
      { ...base, name: "redis", image: "redis:7", port: 6379, healthCheck: "redis-cli ping", variables: [] },
      { ...base, name: "mailpit", image: "axllent/mailpit:1.21", port: 8025, healthCheck: null, variables: [] },
    ],
  });
  const repo = await db.repo.findFirstOrThrow({ where: { projectId }, select: { id: true } });
  await db.check.createMany({
    data: [
      { ...base, name: "typecheck", command: "pnpm typecheck", repoId: repo.id, timeoutSeconds: 600, position: 0 },
      { ...base, name: "lint", command: "pnpm lint", repoId: repo.id, timeoutSeconds: 300, position: 1 },
      { ...base, name: "whitespace", command: "git diff --check origin/main...HEAD", repoId: null, timeoutSeconds: 60, position: 2 },
    ],
  });
  await db.snapshot.create({
    data: {
      ...base,
      reason: "environment-changed",
      state: "ready",
      runnerId: builder,
      digest: `sha256:9c41e2a${"5".repeat(57)}`,
      imageRef: "ostra-snapshot/showcase",
      buildDurationMs: 161_000,
      secretScan: "passed",
      readyAt: new Date(Date.now() - 2 * 3_600_000),
      createdAt: new Date(Date.now() - 2 * 3_600_000 - 161_000),
    },
  });
  // The last box that ran the services: a finished task on build-01, with their health events.
  const member = await db.member.findFirstOrThrow({ where: { organizationId, role: "admin" }, orderBy: { createdAt: "asc" } });
  const task = await db.task.create({
    data: { organizationId, projectId, kind: "code", source: "prompt", title: "Count the orders", prompt: "Count the orders", branchName: `ostra/${randomBytes(4).toString("hex")}-count`, state: "stopped", stoppedReason: "requested", creatorMemberId: member.id },
    select: { id: true },
  });
  const box = await db.box.create({ data: { organizationId, projectId, taskId: task.id, runnerId: builder, executor: "docker", state: "stopped" }, select: { id: true } });
  const session = await db.session.create({ data: { organizationId, projectId, taskId: task.id, origin: "new", state: "ended", outcome: "without_changes", endedAt: new Date(Date.now() - 2 * 3_600_000), boxId: box.id }, select: { id: true } });
  const events = [
    { kind: "service.healthy", name: "db", afterMs: 4_000 },
    { kind: "service.healthy", name: "redis", afterMs: 1_000 },
    { kind: "service.healthy", name: "mailpit", afterMs: 600 },
  ];
  await db.event.createMany({
    data: events.map((event, index) => ({
      organizationId, projectId, taskId: task.id, seq: index + 1, sessionId: session.id, sessionSeq: index + 1, leaseEpoch: 1, kind: event.kind, payload: event, occurredAt: new Date(Date.now() - 2 * 3_600_000),
    })),
  });
  await db.task.update({ where: { id: task.id }, data: { eventSeq: events.length } });
};

await main().finally(() => db.$disconnect());
