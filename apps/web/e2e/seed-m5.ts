// What milestone 5's fleet specs need (tickets 30 and 31), in the throwaway e2e database only.
// Run as `node e2e/seed-m5.ts '<json>'`; prints one JSON line.
//
// Scenarios:
// - `fleet`: the pool `e2e-fleet` with an online runner (`e2e-fleet-01`, 3 slots, on HTTP), a runner one
//   minor behind, a runner to drain and one to revoke (2 boxes each), and the project `e2e-fleet-app`
//   on it; and the pool `e2e-queue`, whose one runner is offline, with three tasks queued in it at
//   priorities 3, 1 and 2; and the pool `e2e-host` with one `host` runner. Idempotent by the pool's name.
// - `take`: a task of `e2e-fleet-app` takes a box on `e2e-fleet-01` (a seeded runner taking a task).
// - `joiner`: the pool `e2e-approve`, which requires approval, and a runner `name` that joined it with
//   the token `ci-bootstrap` and waits.
// - `personal`: the member `username` (made if missing) and their personal runner `name`.

import { createHash, randomBytes, randomUUID } from "node:crypto";

import { hashPassword } from "better-auth/crypto";

import { createDb } from "@ostra/db";
import { seedMember } from "@ostra/domain";
import { z } from "zod";

const argsSchema = z.discriminatedUnion("scenario", [
  z.strictObject({ scenario: z.literal("fleet"), databaseUrl: z.string(), password: z.string() }),
  z.strictObject({ scenario: z.literal("take"), databaseUrl: z.string(), password: z.string() }),
  z.strictObject({ scenario: z.literal("joiner"), databaseUrl: z.string(), password: z.string(), name: z.string() }),
  z.strictObject({ scenario: z.literal("personal"), databaseUrl: z.string(), password: z.string(), username: z.string(), name: z.string() }),
]);
const args = argsSchema.parse(JSON.parse(process.argv[2] ?? "{}"));
const db = createDb(args.databaseUrl);

const admin = await db.member.findFirstOrThrow({ where: { role: "admin" }, orderBy: { createdAt: "asc" } });
const organizationId = admin.organizationId;
/** The member who drives the seeded tasks: they stay off the admin's own lists (My tasks, Home). */
const owner = await (async () => {
  const seeded = await seedMember({ db, hashPassword, env: { NODE_ENV: "test" } }, { username: "e2e-fleet-owner", email: "e2e-fleet-owner@example.com", password: args.password, role: "member" });
  if (!seeded.ok && seeded.error !== "taken") throw new Error(`seeding the fleet's owner failed: ${seeded.error}`);
  const user = await db.user.findUniqueOrThrow({ where: { username: "e2e-fleet-owner" } });
  return db.member.findFirstOrThrow({ where: { userId: user.id } });
})();
const linux = { platform: "linux", arch: "x64", release: "6.8.0" };
/** A presence that core's sweep never closes: the seeded runner reads as connected for the whole run. */
const FOREVER = new Date("2099-01-01T00:00:00Z");

const pool = async (name: string, requiresApproval = false) =>
  (await db.runnerPool.findFirst({ where: { organizationId, name } })) ?? db.runnerPool.create({ data: { organizationId, name, requiresApproval } });

type RunnerSeed = {
  readonly poolId: string | null;
  readonly name: string;
  readonly state: "joining" | "online" | "offline" | "draining";
  readonly slots?: number;
  readonly version?: string;
  readonly minor?: number;
  readonly install?: "npm" | "image" | "source";
  readonly labels?: readonly string[];
  readonly kind?: "pool" | "personal";
  readonly ownerMemberId?: string;
  readonly executor?: "docker" | "host";
  readonly joinTokenId?: string;
  readonly carrier?: "http" | "websocket";
};

const runner = async (seed: RunnerSeed) => {
  const found = await db.runner.findFirst({ where: { organizationId, name: seed.name } });
  if (found !== null) return found;
  const slots = seed.slots ?? 2;
  const executor = seed.executor ?? "docker";
  const row = await db.runner.create({
    data: {
      organizationId,
      kind: seed.kind ?? "pool",
      poolId: seed.poolId,
      ownerMemberId: seed.ownerMemberId ?? null,
      name: seed.name,
      publicKey: randomBytes(32).toString("base64url"),
      executor,
      processContainment: executor === "host" ? "job_object" : "container",
      capacity: slots,
      slots,
      ...(executor === "docker" && (seed.minor ?? 4) >= 4 ? { cpuMillis: 15_000, memoryMiB: 30_720 } : {}),
      labels: [...(seed.labels ?? [])],
      version: seed.version ?? "0.5.0",
      minor: seed.minor ?? 4,
      install: seed.install ?? "npm",
      os: linux,
      state: seed.state,
      joinTokenId: seed.joinTokenId ?? null,
      lastSeenAt: new Date(Date.now() - 4 * 60_000),
      createdAt: new Date(Date.now() - 2 * 86_400_000),
      ...(seed.state === "online" && seed.kind !== "personal" && seed.poolId !== null ? { approvedAt: new Date(Date.now() - 86_400_000), approvedByMemberId: admin.id } : {}),
    },
  });
  if (seed.carrier !== undefined) {
    await db.runnerPresence.create({
      data: { runnerId: row.id, organizationId, replicaId: "e2e-seeded", connectionEpoch: 1, carrier: seed.carrier, minor: seed.minor ?? 4, connectedAt: new Date(Date.now() - 134 * 60_000), lastSeenAt: FOREVER },
    });
  }
  return row;
};

const project = async (name: string, poolId: string, maxBoxes: number | null) => {
  const found = await db.project.findFirst({ where: { organizationId, slug: name } });
  if (found !== null) return found;
  const row = await db.project.create({ data: { organizationId, name, slug: name, access: "open" } });
  await db.projectPool.create({ data: { organizationId, projectId: row.id, poolId, position: 0, maxBoxes } });
  return row;
};

const task = async (projectId: string, title: string, state: "running" | "queued") => {
  const row = await db.task.create({
    data: { organizationId, projectId, kind: "code", source: "prompt", title, prompt: title, branchName: `ostra/${randomUUID().slice(0, 8)}-m5`, state, driverMemberId: owner.id, creatorMemberId: owner.id },
  });
  await db.session.create({ data: { organizationId, projectId, taskId: row.id, origin: "new", state: state === "queued" ? "starting" : "running" } });
  return row;
};

const box = async (projectId: string, runnerId: string, title: string) => {
  const made = await task(projectId, title, "running");
  await db.box.create({ data: { organizationId, projectId, taskId: made.id, runnerId, executor: "docker", state: "ready", size: "small", cpuMillis: 2000, memoryMiB: 4096, createdAt: new Date(Date.now() - 14 * 60_000) } });
  return made.id;
};

const fleet = async () => {
  const found = await db.runnerPool.findFirst({ where: { organizationId, name: "e2e-fleet" } });
  const fleetPool = await pool("e2e-fleet");
  const queuePool = await pool("e2e-queue");
  const app = await project("e2e-fleet-app", fleetPool.id, 8);
  const queueApp = await project("e2e-queue-app", queuePool.id, null);
  // A pool on the host executor: the panel labels it "not isolated".
  const hostPool = await pool("e2e-host");
  await runner({ poolId: hostPool.id, name: "e2e-host-01", state: "online", executor: "host", slots: 1 });
  if (found === null) {
    const token = await db.joinToken.create({ data: { organizationId, poolId: fleetPool.id, tokenHash: createHash("sha256").update(randomUUID()).digest("hex"), label: "ci-bootstrap", createdByMemberId: admin.id, useCount: 4 } });
    await runner({ poolId: fleetPool.id, name: "e2e-fleet-01", state: "online", slots: 3, labels: ["tier:fast", "region:eu"], carrier: "http", joinTokenId: token.id });
    await runner({ poolId: fleetPool.id, name: "e2e-fleet-old", state: "online", slots: 4, version: "0.4.2", minor: 3, install: "image", joinTokenId: token.id });
    const drain = await runner({ poolId: fleetPool.id, name: "e2e-drain-01", state: "online", slots: 2, joinTokenId: token.id });
    const revoke = await runner({ poolId: fleetPool.id, name: "e2e-revoke-01", state: "online", slots: 2, joinTokenId: token.id });
    await box(app.id, drain.id, "Prorate seat changes");
    await box(app.id, drain.id, "Retry failed uploads");
    await box(app.id, revoke.id, "Fix cart badge count");
    await box(app.id, revoke.id, "Rounding error in tax totals");
    await runner({ poolId: queuePool.id, name: "e2e-queue-01", state: "offline", slots: 2 });
    const at = Date.now();
    const queued = [
      { title: "Tidy the footer links", priority: 3, ago: 26 },
      { title: "Checkout fails on an empty cart", priority: 1, ago: 4 },
      { title: "Add a size filter to search", priority: 2, ago: 9 },
    ];
    for (const entry of queued) {
      const made = await task(queueApp.id, entry.title, "queued");
      await db.task.update({ where: { id: made.id }, data: { queuePriority: entry.priority, queuedAt: new Date(at - entry.ago * 60_000) } });
    }
  }
  return { fleetPoolId: fleetPool.id, queuePoolId: queuePool.id, projectId: app.id };
};

const take = async () => {
  const fleetRunner = await db.runner.findFirstOrThrow({ where: { organizationId, name: "e2e-fleet-01" } });
  const app = await db.project.findFirstOrThrow({ where: { organizationId, slug: "e2e-fleet-app" } });
  return { taskId: await box(app.id, fleetRunner.id, `Taken ${randomUUID().slice(0, 4)}`) };
};

const joiner = async (name: string) => {
  const approvePool = await pool("e2e-approve", true);
  const token =
    (await db.joinToken.findFirst({ where: { organizationId, poolId: approvePool.id, label: "ci-bootstrap" } })) ??
    (await db.joinToken.create({ data: { organizationId, poolId: approvePool.id, tokenHash: createHash("sha256").update(randomUUID()).digest("hex"), label: "ci-bootstrap", createdByMemberId: admin.id } }));
  const row = await runner({ poolId: approvePool.id, name, state: "joining", labels: ["tier:fast"], joinTokenId: token.id, slots: 4 });
  return { runnerId: row.id, poolId: approvePool.id };
};

const personal = async (username: string, name: string, password: string) => {
  const seeded = await seedMember({ db, hashPassword, env: { NODE_ENV: "test" } }, { username, email: `${username}@example.com`, password, role: "member" });
  if (!seeded.ok && seeded.error !== "taken") throw new Error(`seeding ${username} failed: ${seeded.error}`);
  const user = await db.user.findUniqueOrThrow({ where: { username } });
  const member = await db.member.findFirstOrThrow({ where: { userId: user.id } });
  const row = await runner({ poolId: null, kind: "personal", ownerMemberId: member.id, name, state: "online", executor: "host", slots: 2, install: "source" });
  return { runnerId: row.id, memberId: member.id };
};

switch (args.scenario) {
  case "fleet":
    process.stdout.write(`${JSON.stringify(await fleet())}\n`);
    break;
  case "take":
    process.stdout.write(`${JSON.stringify(await take())}\n`);
    break;
  case "joiner":
    process.stdout.write(`${JSON.stringify(await joiner(args.name))}\n`);
    break;
  case "personal":
    process.stdout.write(`${JSON.stringify(await personal(args.username, args.name, args.password))}\n`);
    break;
  default:
    args satisfies never;
}
await db.$disconnect();
