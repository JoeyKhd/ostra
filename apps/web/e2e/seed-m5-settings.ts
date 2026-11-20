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

import { randomBytes, randomUUID } from "node:crypto";

import { createDb } from "@ostra/db";
import { z } from "zod";

const argsSchema = z.discriminatedUnion("scenario", [z.strictObject({ scenario: z.literal("runners"), databaseUrl: z.string(), password: z.string() })]);
const args = argsSchema.parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

const admin = await db.member.findFirstOrThrow({ where: { role: "admin" }, orderBy: { createdAt: "asc" } });
const organizationId = admin.organizationId;
const linux = { platform: "linux", arch: "x64", release: "6.8.0" };

const pool = async (name: string, maxBoxes: number | null) =>
  (await db.runnerPool.findFirst({ where: { organizationId, name } })) ?? db.runnerPool.create({ data: { organizationId, name, maxBoxes } });

const runner = async (poolId: string, name: string, executor: "docker" | "kubernetes" | "host") =>
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
      state: "online",
      lastSeenAt: new Date(),
      approvedAt: new Date(Date.now() - 86_400_000),
      approvedByMemberId: admin.id,
    },
  });

const box = async (projectId: string, runnerId: string, executor: "docker" | "kubernetes", title: string) => {
  const task = await db.task.create({
    data: { organizationId, projectId, kind: "code", source: "prompt", title, prompt: title, branchName: `ostra/${randomUUID().slice(0, 8)}-m5s`, state: "running", driverMemberId: admin.id, creatorMemberId: admin.id },
  });
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

process.stdout.write(`${JSON.stringify(await runners())}\n`);
await db.$disconnect();
