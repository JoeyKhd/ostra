import { issueTaskCredentials } from "@ostra/domain";
import type { EnvironmentConfig } from "@ostra/protocol";
import { leaseEpochSchema, repoIdSchema } from "@ostra/protocol";
import type { ProjectId, RepoId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedConnectionAndModel, seedLease, seedPersonalRunner, seedProject } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// F-050: each variable, secret and file belongs to one repo of the project; a key two repos need is
// stored in each, and nothing in a secret is shared across repos. From the admin's save, through
// the secret store, to the credentials core hands the runner, grouped by repo. (The runner writing
// each repo's group into that repo's checkout only is the host executor's test.)

let harness: ApiHarness;
let projectId: ProjectId;
let repoA: RepoId;
let repoB: RepoId;
let otherProjectRepo: RepoId;

const VALUE_A = "sk_test_value_for_repo_a_0001";
const VALUE_B = "sk_test_value_for_repo_b_0002";

beforeAll(async () => {
  harness = await createApiHarness();
  const world = await seedConnectionAndModel(harness);
  const seeded = await seedProject(harness, world, "two-repos-env");
  projectId = seeded.projectId;
  repoA = seeded.repoId;
  const first = await harness.test.db.repo.findUniqueOrThrow({ where: { id: repoA } });
  const second = await harness.test.db.repo.create({
    data: {
      organizationId: first.organizationId,
      projectId,
      connectionId: first.connectionId,
      installationId: first.installationId,
      hostRepoId: `${first.hostRepoId}-b`,
      fullName: "ostra-test/test2",
      defaultBranch: "main",
      checkoutDir: "test2",
    },
  });
  repoB = repoIdSchema.parse(second.id);
  otherProjectRepo = (await seedProject(harness, world, "another-project")).repoId;
});

afterAll(async () => {
  await harness.dispose();
});

const environment = (entries: EnvironmentConfig["entries"]): EnvironmentConfig => ({ baseImage: null, setupScript: null, envFiles: [], entries });

describe("an environment's entries and their repos", () => {
  it("F-050/c2: every variable, secret and file is stored for one repo of the project, and an entry for another project's repo is refused", async () => {
    const admin = await harness.as(harness.fixture.a.admin);
    await admin.environments.save({
      projectId,
      environment: environment([
        { kind: "variable", repoId: repoA, name: "PORT", value: "3000", availableDuringSetup: false },
        { kind: "secret", repoId: repoB, name: "TOKEN", value: VALUE_B, availableDuringSetup: false },
        { kind: "file", repoId: repoB, path: "config/dev.json", content: "{}", availableDuringSetup: false },
      ]),
    });
    const rows = await harness.test.db.environmentEntry.findMany({ where: { projectId } });
    expect(rows.map((row) => [row.kind, row.repoId]).sort()).toEqual(
      [
        ["file", repoB],
        ["secret", repoB],
        ["variable", repoA],
      ].sort(),
    );

    // A repo of another project of the same organization isn't this project's: refused, nothing stored.
    await expect(
      admin.environments.save({
        projectId,
        environment: environment([{ kind: "secret", repoId: otherProjectRepo, name: "TOKEN", value: "should-not-be-stored-9", availableDuringSetup: false }]),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(harness.fakes.secretStore.values()).not.toContain("should-not-be-stored-9");
    expect(await harness.test.db.environmentEntry.count({ where: { repoId: otherProjectRepo } })).toBe(0);
  });

  it("F-050/c5,c6: a key two repos need is stored in each, apart, and reaches the runner grouped by its repo, never across", async () => {
    const admin = await harness.as(harness.fixture.a.admin);
    await admin.environments.save({
      projectId,
      environment: environment([
        { kind: "secret", repoId: repoA, name: "STRIPE_KEY", value: VALUE_A, availableDuringSetup: false },
        { kind: "secret", repoId: repoB, name: "STRIPE_KEY", value: VALUE_B, availableDuringSetup: false },
      ]),
    });
    const rows = await harness.test.db.environmentEntry.findMany({ where: { projectId, kind: "secret", name: "STRIPE_KEY" } });
    expect(rows).toHaveLength(2);
    const refOf = (repoId: RepoId): string => rows.find((row) => row.repoId === repoId)?.secretRef ?? "none";
    expect(refOf(repoA)).not.toBe(refOf(repoB));
    expect(harness.fakes.secretStore.entries.get(refOf(repoA))?.value).toBe(VALUE_A);
    expect(harness.fakes.secretStore.entries.get(refOf(repoB))?.value).toBe(VALUE_B);

    // A new value for one repo's key leaves the other's as it was, whichever repo it is.
    const valueOf = async (repoId: RepoId): Promise<{ readonly ref: string; readonly value: string | undefined }> => {
      const row = await harness.test.db.environmentEntry.findFirstOrThrow({ where: { projectId, repoId, name: "STRIPE_KEY" } });
      const ref = row.secretRef ?? "none";
      return { ref, value: harness.fakes.secretStore.entries.get(ref)?.value };
    };
    const NEW_A = "sk_test_new_value_for_a_0003";
    const NEW_B = "sk_test_new_value_for_b_0004";
    const refB = refOf(repoB);
    await admin.environments.save({
      projectId,
      environment: environment([
        { kind: "secret", repoId: repoA, name: "STRIPE_KEY", value: NEW_A, availableDuringSetup: false },
        { kind: "secret", repoId: repoB, name: "STRIPE_KEY", availableDuringSetup: false },
      ]),
    });
    expect(await valueOf(repoB)).toEqual({ ref: refB, value: VALUE_B });
    expect((await valueOf(repoA)).value).toBe(NEW_A);
    const refA = (await valueOf(repoA)).ref;
    await admin.environments.save({
      projectId,
      environment: environment([
        { kind: "secret", repoId: repoA, name: "STRIPE_KEY", availableDuringSetup: false },
        { kind: "secret", repoId: repoB, name: "STRIPE_KEY", value: NEW_B, availableDuringSetup: false },
      ]),
    });
    expect(await valueOf(repoA)).toEqual({ ref: refA, value: NEW_A });
    expect((await valueOf(repoB)).value).toBe(NEW_B);
    await admin.environments.save({
      projectId,
      environment: environment([
        { kind: "secret", repoId: repoA, name: "STRIPE_KEY", value: "sk_test_new_value_for_a_0003", availableDuringSetup: false },
        { kind: "secret", repoId: repoB, name: "STRIPE_KEY", value: VALUE_B, availableDuringSetup: false },
      ]),
    });

    // A task of the project, on a runner holding its lease: each repo's group holds its own value only.
    const created = await (await harness.as(harness.fixture.a.member)).tasks.create({ projectId, prompt: "Use the key" });
    await harness.test.db.modelProvider.updateMany({ data: { allowOnPersonalRunners: true } });
    const runnerId = await seedPersonalRunner(harness, harness.fixture.a.member.id, "env-runner");
    await seedLease(harness, created, harness.fixture.a.organization.id, projectId, runnerId);
    const lease = await harness.test.db.lease.findFirstOrThrow({ where: { taskId: created.taskId } });
    await harness.test.db.session.update({ where: { id: created.sessionId }, data: { boxId: lease.boxId } });
    const issued = await harness.test.db.$transaction((tx) =>
      issueTaskCredentials(
        { tx, audit: harness.deps.ports.audit, clock: harness.deps.ports.clock, adapters: harness.deps.ports.adapters, mcpToken: () => "mcp-token" },
        { taskId: created.taskId, leaseEpoch: leaseEpochSchema.parse(1), runnerId },
      ),
    );
    if (!issued.ok) throw new Error(issued.message);
    const groupOf = (repoId: RepoId) => issued.credentials.secrets.find((group) => group.repoId === repoId)?.entries ?? [];
    expect(groupOf(repoA)).toEqual([{ kind: "variable", name: "STRIPE_KEY", value: "sk_test_new_value_for_a_0003", availableDuringSetup: false }]);
    expect(groupOf(repoB)).toEqual([{ kind: "variable", name: "STRIPE_KEY", value: VALUE_B, availableDuringSetup: false }]);
  });
});
