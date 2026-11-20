import { randomBytes } from "node:crypto";

import type { OrganizationId } from "@ostra/protocol";
import { organizationIdSchema } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedConnectionAndModel, seedProject } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// Milestone 5, ticket 33 (F-120): what the Registry page reads beside `registry.get`: who set each
// credential and when (never its value), the `docker` pools that use it, where each pushed snapshot
// was built, and today's issued credentials by kind. Organization admins only.

let harness: ApiHarness;
let world: Awaited<ReturnType<typeof seedConnectionAndModel>>;
let organizationId: OrganizationId;

const PUSH = { username: "ostra-push", token: `push-token-${randomBytes(12).toString("hex")}` };
const PULL = { username: "ostra-pull", token: `pull-token-${randomBytes(12).toString("hex")}` };

beforeAll(async () => {
  harness = await createApiHarness();
  world = await seedConnectionAndModel(harness);
  organizationId = organizationIdSchema.parse(harness.fixture.a.organization.id);
});

afterAll(async () => {
  await harness.dispose();
});

const seedRunner = async (name: string, executor: "docker" | "kubernetes" | "host") => {
  const pool = await harness.test.db.runnerPool.create({ data: { organizationId, name: `${name}-pool` }, select: { id: true } });
  return harness.test.db.runner.create({
    data: { organizationId, kind: "pool", poolId: pool.id, name, publicKey: randomBytes(32).toString("base64url"), executor, capacity: 2, version: "0.5.0", state: "online" },
    select: { id: true, poolId: true },
  });
};

describe("the Registry page's reads (F-120)", () => {
  it("F-120: who set each credential, the docker pools, where each snapshot was built and today's issued credentials; no credential's value; admins only", async () => {
    const admin = await harness.as(harness.fixture.a.admin);
    expect(await admin.registryUse.get()).toMatchObject({ credentials: { push: null, pull: null }, issuedToday: { pull: 0, push: 0 } });

    await admin.registry.set({ url: "registry.example.com", repositoryPrefix: "ostra", auth: "basic", push: PUSH, pull: PULL });
    // A later save that leaves the pull credential out keeps who set it.
    await admin.registry.set({ url: "registry.example.com", repositoryPrefix: "ostra/two", auth: "basic", push: PUSH });
    const docker = await seedRunner("use-docker-01", "docker");
    await seedRunner("use-host-01", "host");
    const k8s = await seedRunner("use-k8s-01", "kubernetes");
    const { projectId } = await seedProject(harness, world, "registry-use");
    const registry = await harness.test.db.registry.findUniqueOrThrow({ where: { organizationId } });
    const environment = await harness.test.db.environment.findFirstOrThrow({ where: { projectId } });
    const snapshot = await harness.test.db.snapshot.create({
      data: { organizationId, projectId, environmentId: environment.id, state: "ready", reason: "rebuild", digest: `sha256:${"cd".repeat(32)}`, runnerId: k8s.id, registryId: registry.id, builder: "buildkit", pushedAt: new Date() },
    });
    for (const kind of ["pull", "pull", "push"] as const) {
      await harness.test.db.auditEntry.create({ data: { organizationId, projectId, actorKind: "runner", actorId: docker.id, action: "registry.credential-issued", entity: "registry", entityId: registry.id, data: { kind } } });
    }
    // Yesterday's issue isn't today's.
    await harness.test.db.auditEntry.create({
      data: { organizationId, projectId, actorKind: "runner", actorId: docker.id, action: "registry.credential-issued", entity: "registry", entityId: registry.id, data: { kind: "push" }, createdAt: new Date(Date.now() - 2 * 86_400_000) },
    });
    // The newest save that replaced only the push credential, by another member: the pull credential keeps who set it.
    await harness.test.db.auditEntry.create({
      data: { organizationId, actorKind: "member", actorId: harness.fixture.a.member.id, action: "registry.set", entity: "registry", entityId: registry.id, data: { pushChanged: true, pullChanged: false }, createdAt: new Date(Date.now() + 1000) },
    });

    const use = await admin.registryUse.get();
    const adminName = (await harness.test.db.member.findUniqueOrThrow({ where: { id: harness.fixture.a.admin.id }, include: { user: true } })).user.name;
    const memberName = (await harness.test.db.member.findUniqueOrThrow({ where: { id: harness.fixture.a.member.id }, include: { user: true } })).user.name;
    expect(use.credentials.push?.name).toBe(memberName);
    expect(use.credentials.pull?.name).toBe(adminName);
    expect(use.dockerPools.map((pool) => pool.poolId)).toEqual([docker.poolId]);
    expect(use.builtOn).toContainEqual({ snapshotId: snapshot.id, runnerName: "use-k8s-01", builder: "buildkit" });
    expect(use.issuedToday).toEqual({ pull: 2, push: 1 });
    expect(JSON.stringify(use)).not.toContain(PUSH.token);
    expect(JSON.stringify(use)).not.toContain(PULL.token);

    // A member and another organization's admin read nothing of it.
    await expect((await harness.as(harness.fixture.a.member)).registryUse.get()).rejects.toMatchObject({ code: "FORBIDDEN" });
    const other = await (await harness.as(harness.fixture.b.admin)).registryUse.get();
    expect(other).toMatchObject({ credentials: { push: null, pull: null }, dockerPools: [], builtOn: [], issuedToday: { pull: 0, push: 0 } });
  });
});
