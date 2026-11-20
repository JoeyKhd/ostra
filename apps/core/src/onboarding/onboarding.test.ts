import { secretRefSchema, splitByCommitPaths } from "@ostra/adapter-sdk";
import { decideEnvironmentProposal, ONBOARDING_HOST_LINE, postgresAuditLog, postgresChangeNotices, startOnboarding } from "@ostra/domain";
import type { MemberScope } from "@ostra/domain";
import type { SeededMember } from "@ostra/db/testing";
import { boxIdSchema, environmentProposalIdSchema, repoIdSchema, environmentProposalResponseSchema, leaseEpochSchema, memberIdSchema, runnerPaths } from "@ostra/protocol";
import type { EnvironmentProposal, EnvironmentProposalId, RepoId, TaskId } from "@ostra/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildTaskSpec } from "../dispatch/task-spec.ts";
import { handleEnvironmentProposalEndpoint } from "../runner-http/environment-proposal.ts";
import { FakeModelProvider } from "../testing/fake-adapters.ts";
import { postJson, startGateway } from "../testing/harness.ts";
import type { GatewayHarness } from "../testing/harness.ts";
import { seedSecondRepo, seedTaskInCi, startLoopHarness, REPO, SECOND_REPO } from "../testing/review-loop.ts";
import type { LoopHarness } from "../testing/review-loop.ts";
import { ENV_SECRET } from "../testing/world.ts";

// Milestone 6's ticket 21 (F-113, ADR 0038 amended): the onboarding task and its environment
// proposals, against Postgres and the fake code host. A project admin starts it (a member can't),
// one at a time, from the saved environment or the detected draft, its prompt naming the repos
// without an `AGENTS.md`; its spec has no snapshot, the proposal's and the PR text's tools, and only
// `AGENTS.md` to commit; on `host` it says services aren't available. A proposal goes through the
// sidecar's endpoint and milestone 4's secret scan; a project admin accepts it (the environment's
// next version, its secrets kept) or rejects it.

let h: LoopHarness;
let gateway: GatewayHarness;
let second: RepoId;

beforeAll(async () => {
  h = await startLoopHarness();
  second = await seedSecondRepo(h);
  // The installation lists the second repo too, as GitHub would once it's added.
  for (const [installationId, listed] of h.codeHost.repos) {
    h.codeHost.repos.set(installationId, [...listed, { hostRepoId: `host-${SECOND_REPO}`, fullName: SECOND_REPO, defaultBranch: "main", private: true, cloneUrl: `https://github.example/${SECOND_REPO}.git` }]);
  }
  // The first repo has an AGENTS.md on its default branch; the second has none.
  h.codeHost.repoFiles.set(`${REPO}@main:AGENTS.md`, "# Agents\n");
  gateway = await startGateway(h.db, h.test.url, {}, (gw) => [
    handleEnvironmentProposalEndpoint({ db: h.db, tokens: gw.context.tokens, taskTokens: gw.context.taskTokens, jobs: h.jobs, notices: postgresChangeNotices, clock: h.clock, secretStore: h.secretStore, logger: h.logger }),
  ]);
});

afterAll(async () => {
  await gateway.stop();
  await h.stop();
});

beforeEach(async () => {
  h.jobs.jobs.length = 0;
  h.records.length = 0;
  // Every test starts from the saved environment, and no onboarding task open.
  await h.db.task.updateMany({ where: { projectId: h.world.projectId, onboarding: true, state: { notIn: ["stopped", "merged", "done"] } }, data: { state: "stopped", stoppedReason: "requested" } });
  await h.db.environment.update({ where: { projectId: h.world.projectId }, data: { status: "saved", setupScript: "make bootstrap" } });
});

const scopeOf = (member: SeededMember, role: "admin" | "member"): MemberScope => ({ organizationId: h.world.organizationId, memberId: memberIdSchema.parse(member.id), role, projectRoles: new Map() });
const admin = (): MemberScope => scopeOf(h.fixture.a.admin, "admin");
const member = (): MemberScope => scopeOf(h.fixture.a.member, "member");

const onboardingDeps = () => ({ db: h.db, jobs: h.jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: h.clock, adapters: { codeHost: h.codeHost, secretStore: h.secretStore } });
const decideDeps = () => ({ db: h.db, jobs: h.jobs, notices: postgresChangeNotices, audit: postgresAuditLog, clock: h.clock, adapters: { codeHost: h.codeHost, modelProvider: new FakeModelProvider(), secretStore: h.secretStore } });

const start = async (): Promise<TaskId> => {
  const started = await startOnboarding(onboardingDeps(), admin(), { projectId: h.world.projectId });
  if (!started.ok) throw new Error(`onboarding didn't start: ${started.message}`);
  return started.taskId;
};

/** The task leased to the harness's runner on a box of an executor, as its dispatch leaves it; returns its task token. */
const lease = async (taskId: TaskId, executor: "docker" | "host" = "docker"): Promise<{ readonly token: string; readonly boxId: string }> => {
  const row = await h.db.task.findUniqueOrThrow({ where: { id: taskId } });
  const box = await h.db.box.create({ data: { organizationId: row.organizationId, projectId: row.projectId, taskId, runnerId: h.runner.runnerId, executor, state: "ready" } });
  await h.db.lease.create({ data: { organizationId: row.organizationId, projectId: row.projectId, taskId, epoch: 1, runnerId: h.runner.runnerId, boxId: box.id, state: "active" } });
  await h.db.task.update({ where: { id: taskId }, data: { state: "running", leaseEpoch: 1 } });
  await h.db.session.updateMany({ where: { taskId }, data: { boxId: box.id, state: "running" } });
  const token = gateway.gateway.context.taskTokens.issue({ organizationId: h.world.organizationId, taskId, leaseEpoch: leaseEpochSchema.parse(1), boxId: boxIdSchema.parse(box.id), runnerId: h.runner.runnerId });
  return { token, boxId: box.id };
};

const proposal = (overrides: { readonly setupScript?: string; readonly notes?: string } = {}): EnvironmentProposal => ({
  repos: [
    { repoId: repoIdSchema.parse(h.world.repoId), setupScript: overrides.setupScript ?? "corepack enable\npnpm install --frozen-lockfile", checks: [{ name: "test", command: "pnpm test", timeoutSeconds: 600 }], variableNames: ["DATABASE_URL"] },
    { repoId: second, setupScript: null, checks: [{ name: "lint", command: "pnpm lint", timeoutSeconds: 300 }], variableNames: [] },
  ],
  services: [{ name: "postgres", image: "postgres:16", port: 5432, healthCheck: "pg_isready", variableNames: ["POSTGRES_PASSWORD"] }],
  notes: overrides.notes ?? "The tests need a database: I added Postgres.",
});

const propose = (taskId: TaskId, token: string, body: unknown) => postJson(`${gateway.url}${runnerPaths.taskEnvironmentProposal(taskId)}`, body, token);

/** A saved proposal's ID, from the endpoint's answer. */
const proposed = async (taskId: TaskId, token: string, body: EnvironmentProposal = proposal()): Promise<EnvironmentProposalId> => {
  const answer = await propose(taskId, token, body);
  expect(answer.status).toBe(200);
  const parsed = environmentProposalResponseSchema.parse(answer.body);
  if (!("proposalId" in parsed)) throw new Error(`refused: ${parsed.code}`);
  return environmentProposalIdSchema.parse(parsed.proposalId);
};

describe("F-113: starting the onboarding task", () => {
  it("F-113/c1: a project admin starts the onboarding task from the built-in template, a member can't, and a project has one open at a time", async () => {
    expect(await startOnboarding(onboardingDeps(), member(), { projectId: h.world.projectId })).toMatchObject({ ok: false, error: "forbidden" });
    const taskId = await start();
    const task = await h.db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(task).toMatchObject({ kind: "code", origin: "onboarding", onboarding: true, title: "Set up the environment", state: "queued", driverMemberId: h.fixture.a.admin.id });
    // The template, on the saved environment: its setup script, its checks to pass, the proposal tool.
    expect(task.prompt).toContain("make bootstrap");
    expect(task.prompt).toContain("propose_environment");
    // Only the repo without one gets an AGENTS.md.
    expect(task.prompt).toContain(`Add an AGENTS.md only where it's missing (${SECOND_REPO})`);
    expect(task.prompt).not.toContain(`missing (${REPO}`);
    expect(await startOnboarding(onboardingDeps(), admin(), { projectId: h.world.projectId })).toMatchObject({ ok: false, error: "already-running" });
  });

  it("F-113/c1: with no environment saved, the onboarding task starts from the draft detected in the repos", async () => {
    await h.db.environment.update({ where: { projectId: h.world.projectId }, data: { status: "draft" } });
    h.codeHost.repoFiles.set(`${REPO}@main:package.json`, JSON.stringify({ name: "test1", packageManager: "pnpm@11.0.0" }));
    h.codeHost.repoFiles.set(`${REPO}@main:pnpm-lock.yaml`, "lockfileVersion: '9.0'\n");
    const taskId = await start();
    const { prompt } = await h.db.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(prompt).toContain("pnpm install --frozen-lockfile");
    expect(prompt).not.toContain("make bootstrap");
  });

  it("F-113/c1: its spec has no snapshot, the proposal's and the PR text's tools and only AGENTS.md to commit; on host it says services aren't available", async () => {
    // A ready snapshot on the harness's runner, which any other code task of the project would start from.
    const environment = await h.db.environment.findUniqueOrThrow({ where: { projectId: h.world.projectId } });
    await h.db.snapshot.create({
      data: { organizationId: h.world.organizationId, projectId: h.world.projectId, environmentId: environment.id, state: "ready", reason: "environment-changed", imageRef: "registry.example/ostra/snap:1", digest: `sha256:${"a".repeat(64)}`, runnerId: h.runner.runnerId, readyAt: new Date() },
    });
    const other = await seedTaskInCi(h);
    await h.db.task.update({ where: { id: other.taskId }, data: { state: "running", subState: null } });
    const plain = await buildTaskSpec({ db: h.db, codeHost: h.codeHost, secretStore: h.secretStore }, { taskId: other.taskId, runnerId: h.runner.runnerId, leaseEpoch: leaseEpochSchema.parse(1) });
    if (!plain.ok) throw new Error(plain.message);
    expect(plain.spec.snapshot).toMatchObject({ kind: "image" });

    const taskId = await start();
    await lease(taskId, "docker");
    const spec = await buildTaskSpec({ db: h.db, codeHost: h.codeHost, secretStore: h.secretStore }, { taskId, runnerId: h.runner.runnerId, leaseEpoch: leaseEpochSchema.parse(1) });
    if (!spec.ok) throw new Error(spec.message);
    expect(spec.spec.snapshot).toBeUndefined();
    expect(spec.spec.tools).toEqual(["environment", "pr-text"]);
    expect(spec.spec.commitPaths).toEqual(["AGENTS.md"]);
    expect(spec.spec.prompt).not.toContain(ONBOARDING_HOST_LINE);

    // On a host's box: no host cache either, and the prompt says services aren't started there.
    await h.db.task.update({ where: { id: taskId }, data: { state: "stopped", stoppedReason: "requested" } });
    const onHost = await start();
    await lease(onHost, "host");
    const hostSpec = await buildTaskSpec({ db: h.db, codeHost: h.codeHost, secretStore: h.secretStore }, { taskId: onHost, runnerId: h.runner.runnerId, leaseEpoch: leaseEpochSchema.parse(1) });
    if (!hostSpec.ok) throw new Error(hostSpec.message);
    expect(hostSpec.spec.snapshot).toBeUndefined();
    expect(hostSpec.spec.prompt).toContain(ONBOARDING_HOST_LINE);
  });

  it("F-113/c3: only AGENTS.md reaches a PR, and only for repos without one (with ticket 23's commit)", async () => {
    const taskId = await start();
    await lease(taskId);
    const spec = await buildTaskSpec({ db: h.db, codeHost: h.codeHost, secretStore: h.secretStore }, { taskId, runnerId: h.runner.runnerId, leaseEpoch: leaseEpochSchema.parse(1) });
    if (!spec.ok) throw new Error(spec.message);
    // The runner's filter (ticket 23) over what the agent changed: AGENTS.md is kept, the rest stays uncommitted.
    const split = splitByCommitPaths(["AGENTS.md", "package.json", "scripts/setup.sh"], spec.spec.commitPaths ?? null);
    expect(split.kept).toEqual(["AGENTS.md"]);
    expect(split.dropped).toEqual(["package.json", "scripts/setup.sh"]);
    // And the prompt asks for one only where the repo lacks it.
    expect(spec.spec.prompt).toContain(`(${SECOND_REPO})`);
    expect(spec.spec.prompt).not.toContain(`(${REPO}`);
  });
});

describe("F-113: the proposal", () => {
  it("F-113/c2: a proposal holding a secret's value is refused, naming the kind, and nothing is stored", async () => {
    const taskId = await start();
    const { token } = await lease(taskId);
    // The environment's own secret's value, pasted into a script.
    const withValue = await propose(taskId, token, proposal({ setupScript: `export API_SECRET=${ENV_SECRET}\npnpm install` }));
    expect(environmentProposalResponseSchema.parse(withValue.body)).toEqual({ code: "secret-found", found: ["one of the organization's secrets"] });
    // A credential's shape, in the notes.
    const withToken = await propose(taskId, token, proposal({ notes: `I used ghp_${"x".repeat(36)} to clone.` }));
    expect(environmentProposalResponseSchema.parse(withToken.body)).toEqual({ code: "secret-found", found: ["a GitHub token"] });
    expect(await h.db.environmentProposal.count({ where: { taskId } })).toBe(0);
    expect(await h.db.needsYouItem.count({ where: { taskId, reason: "environment_proposal" } })).toBe(0);
    // Nothing of the scripts reaches a log line.
    expect(JSON.stringify(h.records)).not.toContain(ENV_SECRET);
  });

  it("F-113/c2: an onboarding task's proposal is stored for the project's admins, and a newer one supersedes it; another task's is the wrong kind", async () => {
    const taskId = await start();
    const { token } = await lease(taskId);
    const first = await proposed(taskId, token);
    expect(await h.db.environmentProposal.findUniqueOrThrow({ where: { id: first } })).toMatchObject({ state: "proposed", taskId, notes: "The tests need a database: I added Postgres." });
    expect(await h.db.event.count({ where: { taskId, kind: "environment.proposed" } })).toBe(1);
    expect(await h.db.needsYouItem.findFirstOrThrow({ where: { taskId, reason: "environment_proposal", state: "open" } })).toMatchObject({ audience: "project_members" });
    const newer = await proposed(taskId, token);
    expect((await h.db.environmentProposal.findUniqueOrThrow({ where: { id: first } })).state).toBe("superseded");
    expect((await h.db.environmentProposal.findUniqueOrThrow({ where: { id: newer } })).state).toBe("proposed");
    expect(await h.db.needsYouItem.count({ where: { taskId, reason: "environment_proposal", state: "open" } })).toBe(1);

    // A code task that isn't onboarding: its token can't propose.
    const other = await seedTaskInCi(h);
    const otherToken = gateway.gateway.context.taskTokens.issue({ organizationId: h.world.organizationId, taskId: other.taskId, leaseEpoch: leaseEpochSchema.parse(1), boxId: boxIdSchema.parse(other.boxId), runnerId: h.runner.runnerId });
    expect(environmentProposalResponseSchema.parse((await propose(other.taskId, otherToken, proposal())).body)).toEqual({ code: "wrong-kind" });
    // A body that doesn't parse.
    expect(environmentProposalResponseSchema.parse((await propose(taskId, token, { repos: [] })).body)).toEqual({ code: "invalid" });
  });
});

describe("F-113: the decision", () => {
  it("F-113/c2: accept saves the environment's next version, keeping its secrets, and only a project admin decides", async () => {
    const taskId = await start();
    const { token } = await lease(taskId);
    const proposalId = await proposed(taskId, token);
    const before = await h.db.environment.findUniqueOrThrow({ where: { projectId: h.world.projectId }, include: { entries: { orderBy: { createdAt: "asc" } } } });
    const secret = before.entries.find((entry) => entry.kind === "secret");
    expect(secret?.secretRef).not.toBeNull();

    expect(await decideEnvironmentProposal(decideDeps(), member(), { proposalId, decision: { kind: "accept", edited: null } })).toMatchObject({ ok: false, error: "forbidden" });
    const accepted = await decideEnvironmentProposal(decideDeps(), admin(), { proposalId, decision: { kind: "accept", edited: null } });
    expect(accepted.ok).toBe(true);
    const after = await h.db.environment.findUniqueOrThrow({ where: { projectId: h.world.projectId }, include: { entries: { orderBy: { createdAt: "asc" } }, checks: { orderBy: { position: "asc" } }, services: true } });
    // The proposal's setup, each repo's in its folder, its checks and its service.
    expect(after.setupScript).toContain("pnpm install --frozen-lockfile");
    expect(after.setupScript).toContain(`cd "test1"`);
    expect(after.checks.map((check) => [check.name, check.command, check.repoId])).toEqual(
      expect.arrayContaining([
        ["test", "pnpm test", h.world.repoId],
        ["lint", "pnpm lint", second],
      ]),
    );
    expect(after.services.map((service) => [service.name, service.image, service.port])).toEqual([["postgres", "postgres:16", 5432]]);
    // Its entries and secrets as they were: the secret keeps its reference, so its value.
    expect(after.entries.map((entry) => [entry.kind, entry.name ?? entry.path, entry.secretRef])).toEqual(before.entries.map((entry) => [entry.kind, entry.name ?? entry.path, entry.secretRef]));
    const stored = await h.secretStore.get(h.world.organizationId, secretRefSchema.parse(after.entries.find((entry) => entry.kind === "secret")?.secretRef));
    expect(stored).toMatchObject({ ok: true, value: ENV_SECRET });
    // The next version, with its audit entries, and the admins' item answered.
    const row = await h.db.environmentProposal.findUniqueOrThrow({ where: { id: proposalId } });
    expect(row).toMatchObject({ state: "accepted", decidedByMemberId: h.fixture.a.admin.id });
    expect(accepted.ok && accepted.resultVersion).toBe(row.resultVersion);
    expect(row.resultVersion).toBeGreaterThan(0);
    const actions = (await h.db.auditEntry.findMany({ where: { entityId: before.id, action: { in: ["environment.saved", "environment.proposal-accepted"] } }, orderBy: { createdAt: "asc" } })).map((entry) => entry.action);
    expect(actions.slice(-2)).toEqual(["environment.saved", "environment.proposal-accepted"]);
    expect(await h.db.needsYouItem.findFirstOrThrow({ where: { taskId, reason: "environment_proposal" } })).toMatchObject({ state: "answered", resolvedByMemberId: h.fixture.a.admin.id });
    expect(await decideEnvironmentProposal(decideDeps(), admin(), { proposalId, decision: { kind: "reject", reason: "late" } })).toMatchObject({ ok: false, error: "already-decided" });
  });

  it("F-113/c2: edit and accept saves the admin's edit; reject leaves the environment as it was", async () => {
    const taskId = await start();
    const { token } = await lease(taskId);
    const edited = await proposed(taskId, token);
    const accepted = await decideEnvironmentProposal(decideDeps(), admin(), { proposalId: edited, decision: { kind: "accept", edited: proposal({ setupScript: "make edited-by-admin" }) } });
    expect(accepted.ok).toBe(true);
    expect((await h.db.environment.findUniqueOrThrow({ where: { projectId: h.world.projectId } })).setupScript).toContain("make edited-by-admin");

    const rejected = await proposed(taskId, token, proposal({ setupScript: "make rejected" }));
    const before = await h.db.environment.findUniqueOrThrow({ where: { projectId: h.world.projectId } });
    expect(await decideEnvironmentProposal(decideDeps(), admin(), { proposalId: rejected, decision: { kind: "reject", reason: "We don't run make here." } })).toEqual({ ok: true, resultVersion: null });
    expect(await h.db.environmentProposal.findUniqueOrThrow({ where: { id: rejected } })).toMatchObject({ state: "rejected", decidedByMemberId: h.fixture.a.admin.id, resultVersion: null });
    const after = await h.db.environment.findUniqueOrThrow({ where: { projectId: h.world.projectId } });
    expect(after.setupScript).toBe(before.setupScript);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    // The reason is the admin's words: the audit entry says one was given, never what.
    const entry = await h.db.auditEntry.findFirstOrThrow({ where: { action: "environment.proposal-rejected" }, orderBy: { createdAt: "desc" } });
    expect(JSON.stringify(entry.data)).not.toContain("make here");
  });
});
