import { randomBytes } from "node:crypto";

import { postgresChangeNotices, proposeEnvironment, systemClock } from "@ostra/domain";
import { environmentProposalIdSchema, repoIdSchema } from "@ostra/protocol";
import type { EnvironmentProposal, EnvironmentProposalId, OrganizationId, ProjectId, RepoId, TaskId } from "@ostra/protocol";
import { TRPCError } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedConnectionAndModel, seedProject } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// Milestone 6's ticket 29 (F-113): the onboarding task and its environment proposal through the
// panel's own procedures, against Postgres. The task starts through `environments.startOnboarding`;
// its agent's proposal is stored as core's `environment-proposal` endpoint stores it (the domain's
// `proposeEnvironment`, with milestone 4's secret scan); the rest goes through `environments.*`.

let harness: ApiHarness;
let orgA: OrganizationId;
let projectId: ProjectId;
let repo1: RepoId;
let repo2: RepoId;
/** The environment's secret's value: it must never get into the environment through an admin's edit. */
const SECRET_VALUE = `sv_${randomBytes(16).toString("hex")}`;

const codeOf = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run;
  } catch (error) {
    if (error instanceof TRPCError) return error.code;
    throw error;
  }
  return "OK";
};

const proposal = (over: { readonly setupScript?: string; readonly notes?: string } = {}): EnvironmentProposal => ({
  repos: [
    {
      repoId: repo1,
      setupScript: over.setupScript ?? "make bootstrap\npnpm install --frozen-lockfile",
      checks: [
        { name: "test", command: "pnpm test --run", timeoutSeconds: 600 },
        { name: "lint", command: "pnpm lint", timeoutSeconds: 300 },
      ],
      variableNames: ["DATABASE_URL", "STRIPE_KEY"],
    },
    { repoId: repo2, setupScript: null, checks: [{ name: "docs", command: "pnpm docs:check", timeoutSeconds: 300 }], variableNames: [] },
  ],
  services: [
    { name: "redis", image: "redis:7", port: 6379, healthCheck: null, variableNames: [] },
    { name: "postgres", image: "postgres:16", port: 5432, healthCheck: "pg_isready", variableNames: ["POSTGRES_PASSWORD"] },
  ],
  notes: over.notes ?? "The tests need a database: I added Postgres.",
});

/** The agent's proposal on the onboarding task, as core's endpoint stores it. */
const agentProposes = async (taskId: TaskId, body: EnvironmentProposal = proposal()): Promise<EnvironmentProposalId> => {
  const made = await proposeEnvironment(
    { db: harness.test.db, jobs: harness.fakes.jobs, notices: postgresChangeNotices, clock: systemClock, adapters: { secretStore: harness.fakes.secretStore } },
    { organizationId: orgA, taskId, proposal: body },
  );
  if (!made.ok) throw new Error(`refused: ${made.error}`);
  return environmentProposalIdSchema.parse(made.proposalId);
};

/** No onboarding task open: each case starts its own. */
const closeOnboarding = async (): Promise<void> => {
  await harness.test.db.task.updateMany({ where: { projectId, onboarding: true, state: { notIn: ["stopped", "merged", "done"] } }, data: { state: "stopped", stoppedReason: "requested" } });
};

beforeAll(async () => {
  harness = await createApiHarness();
  orgA = harness.fixture.a.organization.id;
  const world = await seedConnectionAndModel(harness);
  const made = await seedProject(harness, world, "onboard");
  projectId = made.projectId;
  repo1 = repoIdSchema.parse(made.repoId);
  const first = await harness.test.db.repo.findUniqueOrThrow({ where: { id: repo1 } });
  repo2 = repoIdSchema.parse(
    (
      await harness.test.db.repo.create({
        data: { organizationId: orgA, projectId, connectionId: first.connectionId, installationId: first.installationId, hostRepoId: "2", fullName: "ostra-test/test2", defaultBranch: "main", checkoutDir: "test2", position: 1 },
        select: { id: true },
      })
    ).id,
  );
  // The second repo on the fake host, with no AGENTS.md; the first has one.
  harness.fakes.codeHost.files.set("ostra-test/test2", new Map([["package.json", "{}"]]));
  harness.fakes.codeHost.files.set("ostra-test/test1", new Map([["package.json", "{}"], ["AGENTS.md", "# Agents\n"]]));
  // The environment as an admin saved it: a script, a variable, a secret, a check and a service.
  const admin = await harness.as(harness.fixture.a.admin);
  await admin.environments.save({
    projectId,
    environment: {
      baseImage: null,
      setupScript: "make bootstrap",
      envFiles: [],
      entries: [
        { kind: "variable", repoId: repo1, name: "DATABASE_URL", value: "postgres://localhost/app", availableDuringSetup: false },
        { kind: "secret", repoId: repo1, name: "API_SECRET", value: SECRET_VALUE, availableDuringSetup: false },
      ],
    },
  });
  const environment = await harness.test.db.environment.findFirstOrThrow({ where: { projectId } });
  await harness.test.db.check.create({ data: { organizationId: orgA, projectId, environmentId: environment.id, name: "test", command: "pnpm test", repoId: repo1, position: 0 } });
  await harness.test.db.check.create({ data: { organizationId: orgA, projectId, environmentId: environment.id, name: "build", command: "pnpm build", repoId: repo1, position: 1 } });
  await harness.test.db.service.create({ data: { organizationId: orgA, projectId, environmentId: environment.id, name: "redis", image: "redis:7", port: 6379, variables: [] } });
  // The insider is a project admin of it who isn't an organization admin.
  await harness.test.db.projectMember.create({ data: { organizationId: orgA, projectId, memberId: harness.fixture.a.insider.id, role: "admin" } });
});

afterAll(async () => {
  await harness.dispose();
});

describe("the onboarding task (F-113, ticket 29)", () => {
  it("F-113/c1: a project admin starts it and a member can't; one onboarding task is open at a time", async () => {
    await closeOnboarding();
    const member = await harness.as(harness.fixture.a.member);
    expect(await codeOf(member.environments.startOnboarding({ projectId }))).toBe("FORBIDDEN");
    expect(await codeOf((await harness.as(harness.fixture.b.admin)).environments.startOnboarding({ projectId }))).toBe("NOT_FOUND");
    expect(await harness.test.db.task.count({ where: { projectId, onboarding: true } })).toBe(0);

    const projectAdmin = await harness.as(harness.fixture.a.insider);
    const started = await projectAdmin.environments.startOnboarding({ projectId });
    expect(await harness.test.db.task.findUniqueOrThrow({ where: { id: started.taskId } })).toMatchObject({ kind: "code", onboarding: true, origin: "onboarding", title: "Set up the environment" });
    expect(await codeOf((await harness.as(harness.fixture.a.admin)).environments.startOnboarding({ projectId }))).toBe("CONFLICT");
    expect(await harness.test.db.task.count({ where: { projectId, onboarding: true } })).toBe(1);
    // Once it's closed, another can start.
    await closeOnboarding();
    await projectAdmin.environments.startOnboarding({ projectId });
    expect(await harness.test.db.task.count({ where: { projectId, onboarding: true } })).toBe(2);
  });

  it("F-113/c1,c3: the page reads the newest onboarding task, its AGENTS.md PR and what its commits left out, and who may start one now", async () => {
    await closeOnboarding();
    await harness.test.db.environmentProposal.updateMany({ where: { projectId, state: "proposed" }, data: { state: "rejected" } });
    const admin = await harness.as(harness.fixture.a.admin);
    const member = await harness.as(harness.fixture.a.member);
    expect((await admin.environments.onboarding({ projectId })).canStart).toBe(true);
    expect((await member.environments.onboarding({ projectId })).canStart).toBe(false);
    const { taskId } = await admin.environments.startOnboarding({ projectId });
    const running = await admin.environments.onboarding({ projectId });
    expect(running.task).toMatchObject({ taskId, open: true, prs: [] });
    expect(running.canStart).toBe(false);
    // Its AGENTS.md PR, and a commit the runner filtered.
    await harness.test.db.taskRepo.updateMany({ where: { taskId, repoId: repo2 }, data: { state: "pr_open", prNumber: 97, prUrl: "https://github.com/ostra-test/test2/pull/97", headSha: "a".repeat(40) } });
    const session = await harness.test.db.session.findFirstOrThrow({ where: { taskId } });
    const seq = (await harness.test.db.task.findUniqueOrThrow({ where: { id: taskId } })).eventSeq + 1;
    await harness.test.db.event.create({
      data: { organizationId: orgA, projectId, taskId, seq, sessionId: session.id, kind: "commit.filtered", occurredAt: new Date(), payload: { kind: "commit.filtered", repoId: repo2, kept: ["AGENTS.md"], dropped: ["package.json", "src/setup.ts"], droppedCount: 2 } },
    });
    await harness.test.db.task.update({ where: { id: taskId }, data: { eventSeq: seq } });
    const read = await member.environments.onboarding({ projectId });
    expect(read.task?.prs).toEqual([{ repo: "ostra-test/test2", number: 97, url: "https://github.com/ostra-test/test2/pull/97", state: "pr_open" }]);
    expect(read.notCommitted).toEqual(["package.json", "src/setup.ts"]);
    // A waiting proposal holds the start too, once the task is over.
    await agentProposes(taskId);
    await closeOnboarding();
    expect((await admin.environments.onboarding({ projectId })).canStart).toBe(false);
    expect(await codeOf((await harness.as(harness.fixture.b.admin)).environments.onboarding({ projectId }))).toBe("NOT_FOUND");
    // The next case starts with no proposal open.
    await harness.test.db.environmentProposal.updateMany({ where: { projectId, state: "proposed" }, data: { state: "rejected" } });
  });

  it("F-113/c2: the open proposal is shown per repo against the environment as saved: its script, its checks and the variables it needs, then the services", async () => {
    await closeOnboarding();
    const admin = await harness.as(harness.fixture.a.admin);
    const member = await harness.as(harness.fixture.a.member);
    expect(await member.environments.proposal({ projectId })).toBeNull();
    const { taskId } = await admin.environments.startOnboarding({ projectId });
    const proposalId = await agentProposes(taskId);
    const view = await member.environments.proposal({ projectId });
    expect(view).toMatchObject({ proposalId, task: { taskId, title: "Set up the environment" }, saved: true, canDecide: false, notes: "The tests need a database: I added Postgres." });
    expect(view?.repos).toEqual([
      {
        repoId: repo1,
        repo: "ostra-test/test1",
        setupScript: { current: "make bootstrap", proposed: "make bootstrap\npnpm install --frozen-lockfile", changed: true },
        checks: {
          added: [{ name: "lint", command: "pnpm lint", timeoutSeconds: 300 }],
          changed: [{ name: "test", current: { name: "test", command: "pnpm test", timeoutSeconds: 600 }, proposed: { name: "test", command: "pnpm test --run", timeoutSeconds: 600 } }],
          unchanged: [],
          kept: ["build"],
        },
        variableNames: { missing: ["STRIPE_KEY"], present: ["DATABASE_URL"] },
      },
      {
        repoId: repo2,
        repo: "ostra-test/test2",
        setupScript: { current: null, proposed: null, changed: false },
        checks: { added: [{ name: "docs", command: "pnpm docs:check", timeoutSeconds: 300 }], changed: [], unchanged: [], kept: [] },
        variableNames: { missing: [], present: [] },
      },
    ]);
    expect(view?.services).toEqual({ added: [{ name: "postgres", image: "postgres:16", port: 5432, healthCheck: "pg_isready", variableNames: ["POSTGRES_PASSWORD"] }], changed: [], unchanged: ["redis"], kept: [] });
    expect((await admin.environments.proposal({ projectId }))?.canDecide).toBe(true);
    expect(await codeOf((await harness.as(harness.fixture.b.admin)).environments.proposal({ projectId }))).toBe("NOT_FOUND");
  });

  it("F-113/c2: only a project admin decides: accept saves the next version once; reject and a bare edit are their own", async () => {
    await closeOnboarding();
    const admin = await harness.as(harness.fixture.a.admin);
    const member = await harness.as(harness.fixture.a.member);
    const projectAdmin = await harness.as(harness.fixture.a.insider);
    const { taskId } = await admin.environments.startOnboarding({ projectId });
    const proposalId = await agentProposes(taskId);
    expect(await codeOf(member.environments.decideProposal({ proposalId, decision: "accept", edited: null, reason: null }))).toBe("FORBIDDEN");
    expect(await codeOf((await harness.as(harness.fixture.b.admin)).environments.decideProposal({ proposalId, decision: "accept", edited: null, reason: null }))).toBe("NOT_FOUND");
    expect(await codeOf(projectAdmin.environments.decideProposal({ proposalId, decision: "edit-and-accept", edited: null, reason: null }))).toBe("BAD_REQUEST");
    expect(await harness.test.db.environmentProposal.findUniqueOrThrow({ where: { id: proposalId } })).toMatchObject({ state: "proposed" });

    const decided = await projectAdmin.environments.decideProposal({ proposalId, decision: "accept", edited: null, reason: null });
    expect(decided.resultVersion).toBeGreaterThan(0);
    expect(await harness.test.db.environmentProposal.findUniqueOrThrow({ where: { id: proposalId } })).toMatchObject({ state: "accepted", decidedByMemberId: harness.fixture.a.insider.id, resultVersion: decided.resultVersion });
    expect((await harness.test.db.environment.findFirstOrThrow({ where: { projectId } })).setupScript).toContain("pnpm install --frozen-lockfile");
    expect(await codeOf(projectAdmin.environments.decideProposal({ proposalId, decision: "reject", edited: null, reason: "Too late." }))).toBe("CONFLICT");
    expect(await member.environments.proposal({ projectId })).toBeNull();
    // The page reads what became of it, after a reload too.
    expect((await member.environments.onboarding({ projectId })).decision).toMatchObject({ kind: "accepted", version: decided.resultVersion });

    // A rejected one leaves the environment as it was.
    const before = await harness.test.db.environment.findFirstOrThrow({ where: { projectId } });
    const rejected = await agentProposes(taskId, proposal({ setupScript: "make rejected" }));
    expect(await admin.environments.decideProposal({ proposalId: rejected, decision: "reject", edited: null, reason: "We don't run make here." })).toEqual({ resultVersion: null });
    expect((await harness.test.db.environment.findFirstOrThrow({ where: { projectId } })).setupScript).toBe(before.setupScript);
    expect((await member.environments.onboarding({ projectId })).decision).toMatchObject({ kind: "rejected", version: null });
  });

  it("F-113/c2: an admin's edit that adds a secret's value is refused by the scan, and nothing is saved; a clean edit is accepted", async () => {
    await closeOnboarding();
    const admin = await harness.as(harness.fixture.a.admin);
    const { taskId } = await admin.environments.startOnboarding({ projectId });
    const proposalId = await agentProposes(taskId);
    const before = await harness.test.db.environment.findFirstOrThrow({ where: { projectId } });
    for (const edited of [proposal({ setupScript: `export API_SECRET=${SECRET_VALUE}\npnpm install` }), proposal({ notes: `Cloned with ghp_${"x".repeat(36)}.` })]) {
      expect(await codeOf(admin.environments.decideProposal({ proposalId, decision: "edit-and-accept", edited, reason: null }))).toBe("BAD_REQUEST");
    }
    expect(await harness.test.db.environmentProposal.findUniqueOrThrow({ where: { id: proposalId } })).toMatchObject({ state: "proposed" });
    const after = await harness.test.db.environment.findFirstOrThrow({ where: { projectId } });
    expect(after.setupScript).toBe(before.setupScript);
    expect(after.setupScript).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(harness.logs)).not.toContain(SECRET_VALUE);

    await admin.environments.decideProposal({ proposalId, decision: "edit-and-accept", edited: proposal({ setupScript: "make edited-by-admin" }), reason: null });
    expect((await harness.test.db.environment.findFirstOrThrow({ where: { projectId } })).setupScript).toContain("make edited-by-admin");
  });
});
