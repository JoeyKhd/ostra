import { randomBytes } from "node:crypto";

import { createLogger, secretRefSchema, silentLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { corePanelUploader } from "@ostra/api";
import type { Db, Prisma } from "@ostra/db";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, SeededMember, TestDatabase } from "@ostra/db/testing";
import {
  createPromptTask,
  dispatchTask,
  postgresAuditLog,
  postgresChangeNotices,
  postgresCommandOutbox,
  reopenTask,
  startTicketTask,
  systemClock,
} from "@ostra/domain";
import type { MemberScope } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import {
  agentProfileIdSchema,
  approvalRuleIdSchema,
  clientMessageIdSchema,
  leaseEpochSchema,
  memberIdSchema,
  runnerHeaders,
  runnerPaths,
  taskCredentialsSchema,
  taskSpecSchema,
  ticketIdSchema,
} from "@ostra/protocol";
import type { BlobId } from "@ostra/protocol";
import type { AgentProfileId, ApprovalRule, OrganizationId, ProjectId, RunnerId, SessionId, TaskId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBlobService } from "../blobs/blob-service.ts";
import type { BlobService } from "../blobs/blob-service.ts";
import { handlePanelBlobEndpoint } from "../blobs/panel-endpoints.ts";
import { FakeCodeHost, FakeModelProvider, FakeSecretStore } from "../testing/fake-adapters.ts";
import { accessToken, postJson, registerPersonal, startGateway } from "../testing/harness.ts";
import type { GatewayHarness, RegisteredRunner } from "../testing/harness.ts";
import { seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";
import { handleTaskEndpoint } from "./endpoints.ts";

// Milestone 3's ticket 16 (F-021, ADR 0049): the profile a task starts with, and the task spec's
// agent section built from it. Real Postgres, the real dispatch and the real spec and credentials
// endpoints, with fake adapters (spec section 8).

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let world: World;
let otherWorld: World;
let harness: GatewayHarness;
let blobs: BlobService;
const panelSecret = randomBytes(32).toString("hex");
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();
const records: LogRecord[] = [];
const logger = createLogger((record) => records.push(record));
const MCP_TOKEN = `mcp-bearer-${randomBytes(12).toString("hex")}`;
const MCP_URL = "https://release-names.example/mcp";

const scopeOf = (member: SeededMember): MemberScope => ({
  organizationId: member.organizationId,
  memberId: memberIdSchema.parse(member.id),
  role: member.role === "admin" ? "admin" : "member",
  projectRoles: new Map(),
});

const ports = { notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock };

const startTask = async (member: SeededMember, input: { readonly agentProfileId?: AgentProfileId; readonly runnerId?: RunnerId } = {}) =>
  test.db.$transaction((tx) =>
    createPromptTask(
      { tx, scope: scopeOf(member), ...ports, jobs },
      { projectId: world.projectId, prompt: "Set releaseName in config/settings.json", ...input },
    ),
  );

const started = async (member: SeededMember, input: Parameters<typeof startTask>[1] = {}): Promise<{ taskId: TaskId; sessionId: SessionId }> => {
  const result = await startTask(member, input);
  if (!result.ok) {
    throw new Error(`the start was refused: ${result.error}`);
  }
  return { taskId: result.taskId, sessionId: result.sessionId };
};

const dispatch = (organizationId: OrganizationId, task: { taskId: TaskId; sessionId: SessionId }, epoch = 1) =>
  test.db.$transaction((tx) =>
    dispatchTask(
      { tx, jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock: systemClock, logger },
      { organizationId, taskId: task.taskId, sessionId: task.sessionId, leaseEpoch: leaseEpochSchema.parse(epoch) },
    ),
  );

const makeProfile = async (
  db: Db,
  organizationId: OrganizationId,
  modelId: string | null,
  data: { name: string; access?: "everyone" | "listed"; planFirst?: boolean; approvalRules?: readonly ApprovalRule[]; mcpServers?: Prisma.InputJsonValue; instructions?: string },
): Promise<AgentProfileId> => {
  const row = await db.agentProfile.create({
    data: {
      organizationId,
      name: data.name,
      adapter: "opencode",
      modelId,
      instructions: data.instructions ?? null,
      access: data.access ?? "everyone",
      planFirst: data.planFirst ?? false,
      approvalRules: [...(data.approvalRules ?? [])],
      mcpServers: data.mcpServers ?? [],
    },
  });
  return agentProfileIdSchema.parse(row.id);
};

const modelOf = async (profileId: string): Promise<string | null> => (await test.db.agentProfile.findUniqueOrThrow({ where: { id: profileId } })).modelId;

/** A runner of the member's, online at `minor`. */
const personalRunner = async (member: SeededMember, minor: number): Promise<RegisteredRunner> => {
  const runner = await registerPersonal(harness, test.db, member);
  await test.db.runner.update({ where: { id: runner.runnerId }, data: { state: "online", capacity: 8 } });
  await test.db.runnerPresence.create({
    data: { runnerId: runner.runnerId, organizationId: member.organizationId, replicaId: "test", connectionEpoch: 1, carrier: "websocket", minor },
  });
  return runner;
};

const present = (blobId: BlobId | undefined): BlobId => {
  if (blobId === undefined) {
    throw new Error("expected a blob");
  }
  return blobId;
};

const rule: ApprovalRule = { ruleId: approvalRuleIdSchema.parse("rule-config"), name: "Edit files matching config/**", tool: "edit", match: { kind: "path-glob", glob: "config/**" } };

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  world = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  otherWorld = await seedWorld(test.db, { codeHost, secretStore }, fixture.b.organization.id, fixture.b.project.id, { fullName: "other-org/repo" });
  blobs = createBlobService({ db: test.db, settings: { kind: "postgres", maxBytes: 8 * 1024 * 1024 }, context: { logger, clock: systemClock } });
  harness = await startGateway(test.db, test.url, {}, (gateway) => [
    handlePanelBlobEndpoint({ blobs, secret: () => Promise.resolve(panelSecret), clock: systemClock, logger }),
    handleTaskEndpoint({
      db: test.db,
      tokens: gateway.context.tokens,
      taskTokens: gateway.context.taskTokens,
      adapters: { codeHost, secretStore, modelProvider: new FakeModelProvider() },
      audit: postgresAuditLog,
      clock: systemClock,
      signingKey: randomBytes(32),
      logger,
      blobs,
    }),
  ]);
});

afterAll(async () => {
  await harness.stop();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

describe("the profile a task starts with", () => {
  it("F-021: the member's choice, else the project's default for the kind, else the organization's built-in profile", async () => {
    const model = await modelOf(world.profileId);
    const careful = await makeProfile(test.db, world.organizationId, model, { name: `Careful ${randomBytes(2).toString("hex")}` });
    const projectDefault = await makeProfile(test.db, world.organizationId, model, { name: `Default ${randomBytes(2).toString("hex")}` });
    await test.db.project.update({ where: { id: world.projectId }, data: { defaultCodeProfileId: projectDefault } });
    try {
      const picked = await started(fixture.a.member, { agentProfileId: careful });
      const byDefault = await started(fixture.a.member);
      const rowOf = async (taskId: TaskId) => test.db.task.findUniqueOrThrow({ where: { id: taskId }, include: { sessions: true } });
      expect((await rowOf(picked.taskId)).agentProfileId).toBe(careful);
      expect((await rowOf(picked.taskId)).sessions.map((session) => session.agentProfileId)).toEqual([careful]);
      expect((await rowOf(byDefault.taskId)).agentProfileId).toBe(projectDefault);
      // No default for code tasks: the built-in OpenCode profile.
      await test.db.project.update({ where: { id: world.projectId }, data: { defaultCodeProfileId: null } });
      expect((await rowOf((await started(fixture.a.member)).taskId)).agentProfileId).toBe(world.profileId);
      // A default archived since: the built-in one too.
      await test.db.project.update({ where: { id: world.projectId }, data: { defaultCodeProfileId: projectDefault } });
      await test.db.agentProfile.update({ where: { id: projectDefault }, data: { archivedAt: new Date() } });
      expect((await rowOf((await started(fixture.a.member)).taskId)).agentProfileId).toBe(world.profileId);
    } finally {
      await test.db.project.update({ where: { id: world.projectId }, data: { defaultCodeProfileId: world.profileId } });
    }
  });

  it("F-021: a listed profile is for its members and admins; an archived one, or another organization's, starts nothing", async () => {
    const model = await modelOf(world.profileId);
    const listed = await makeProfile(test.db, world.organizationId, model, { name: `Listed ${randomBytes(2).toString("hex")}`, access: "listed" });
    await test.db.agentProfileMember.create({ data: { organizationId: world.organizationId, profileId: listed, memberId: fixture.a.insider.id } });
    const refused = await startTask(fixture.a.member, { agentProfileId: listed });
    expect(refused).toMatchObject({ ok: false, error: "forbidden" });
    expect(refused.ok ? "" : refused.message).toContain("You may not use the agent profile");
    expect((await started(fixture.a.insider, { agentProfileId: listed })).taskId).toBeTruthy();
    expect((await started(fixture.a.admin, { agentProfileId: listed })).taskId).toBeTruthy();

    const archived = await makeProfile(test.db, world.organizationId, model, { name: `Archived ${randomBytes(2).toString("hex")}` });
    await test.db.agentProfile.update({ where: { id: archived }, data: { archivedAt: new Date() } });
    expect(await startTask(fixture.a.admin, { agentProfileId: archived })).toMatchObject({ ok: false, error: "no-agent-profile" });

    // Another organization's profile reads as none at all, for a prompt task and a ticket task alike.
    const theirs = agentProfileIdSchema.parse(otherWorld.profileId);
    const foreign = await startTask(fixture.a.admin, { agentProfileId: theirs });
    expect(foreign).toEqual({ ok: false, error: "no-agent-profile", message: "No such agent profile" });
    const ticketStart = await test.db.$transaction((tx) =>
      startTicketTask(
        { tx, scope: scopeOf(fixture.a.admin), ...ports, jobs, publicUrl: "http://localhost:3000" },
        // The ticket isn't checked before the profile is; an unknown ticket is still refused before any write.
        { projectId: world.projectId, ticketId: ticketIdSchema.parse("00000000-0000-7000-8000-000000000000"), agentProfileId: theirs },
      ),
    );
    expect(ticketStart.ok).toBe(false);
    expect(await test.db.task.count({ where: { agentProfileId: theirs } })).toBe(0);
  });

  it("F-021: a reopen keeps the task's profile, archived since or not, and refuses a member who may not use it", async () => {
    const model = await modelOf(world.profileId);
    const listed = await makeProfile(test.db, world.organizationId, model, { name: `Kept ${randomBytes(2).toString("hex")}`, access: "listed" });
    await test.db.agentProfileMember.create({ data: { organizationId: world.organizationId, profileId: listed, memberId: fixture.a.insider.id } });
    const task = await started(fixture.a.insider, { agentProfileId: listed });
    await test.db.agentProfile.update({ where: { id: listed }, data: { archivedAt: new Date() } });
    await test.db.task.update({ where: { id: task.taskId }, data: { state: "stopped", stoppedReason: "requested" } });
    await test.db.session.updateMany({ where: { taskId: task.taskId }, data: { state: "stopped" } });
    const reopen = (member: SeededMember) =>
      test.db.$transaction((tx) =>
        reopenTask({ tx, scope: scopeOf(member), ...ports, jobs }, { taskId: task.taskId, clientMessageId: clientMessageIdSchema.parse(crypto.randomUUID()), text: "Carry on" }),
      );
    expect(await reopen(fixture.a.member)).toMatchObject({ ok: false, error: "profile-not-allowed" });
    const reopened = await reopen(fixture.a.insider);
    expect(reopened.ok).toBe(true);
    const sessions = await test.db.session.findMany({ where: { taskId: task.taskId }, orderBy: { startedAt: "asc" } });
    expect(sessions.map((session) => session.agentProfileId)).toEqual([listed, listed]);
  });
});

describe("the spec's agent section", () => {
  let careful: AgentProfileId;
  let runner: RegisteredRunner;
  let skillFileBlobId: string;

  beforeAll(async () => {
    const headerRef = await secretStore.put({ organizationId: world.organizationId, purpose: "agent-profile.mcp-header" }, `Bearer ${MCP_TOKEN}`);
    if (!headerRef.ok) {
      throw new Error("the fake secret store refused");
    }
    careful = await makeProfile(test.db, world.organizationId, await modelOf(world.profileId), {
      name: "Careful",
      planFirst: true,
      instructions: "Add a line to CHANGELOG.md for every change you make",
      approvalRules: [rule],
      mcpServers: [
        { name: "release-names", transport: "http", url: MCP_URL, readOnly: true, headerSecretRefs: { Authorization: secretRefSchema.parse(headerRef.value) } },
        { name: "local-tool", transport: "stdio", command: "local-tool", args: ["--serve"], env: { LOG_LEVEL: "info" }, readOnly: false },
      ],
    });
    // The skill's extra file is the organization's blob, as the profile editor uploads it: through the
    // panel's uploader and core's endpoint for it (ticket 42), not written into the store directly.
    const file = await corePanelUploader({ coreUrl: harness.url, secret: panelSecret, logger: silentLogger })({
      organizationId: world.organizationId,
      purpose: "skill-file",
      bytes: new TextEncoder().encode("2026-11-19: example line\n"),
    });
    if (file.kind !== "stored") {
      throw new Error("core refused the skill's file");
    }
    skillFileBlobId = file.blobId;
    await test.db.agentProfileSkill.create({
      data: { organizationId: world.organizationId, profileId: careful, name: "changelog", body: "# changelog\nOne line per change.", files: [{ path: "example.txt", blobId: file.blobId }] },
    });
    runner = await personalRunner(fixture.a.member, 2);
  });

  const fetchSpec = async (taskId: TaskId, minor: number) => {
    const token = await accessToken(harness, runner);
    const response = await fetch(`${harness.url}${runnerPaths.taskSpec(taskId)}?leaseEpoch=1`, {
      headers: { authorization: `Bearer ${token.accessToken}`, [runnerHeaders.minor]: String(minor) },
    });
    return { status: response.status, text: await response.text() };
  };

  it("F-021: carries the profile's skills as the task's blobs, its MCP servers behind the proxy, its rules, the task's rules and plan first", async () => {
    const task = await started(fixture.a.member, { agentProfileId: careful, runnerId: runner.runnerId });
    const taskRule = await test.db.taskApprovalRule.create({
      data: { organizationId: world.organizationId, projectId: world.projectId, taskId: task.taskId, tool: "edit", pattern: "config/settings.json", createdByMemberId: fixture.a.member.id },
    });
    expect(await dispatch(world.organizationId, task)).toMatchObject({ ok: true, runnerId: runner.runnerId });
    const first = await fetchSpec(task.taskId, 2);
    expect(first.status).toBe(200);
    const spec = taskSpecSchema.parse(JSON.parse(first.text));
    expect(spec.agent.instructions).toBe("Add a line to CHANGELOG.md for every change you make");
    expect(spec.agent.approvalRules).toEqual([rule]);
    expect(spec.agent.taskRules).toEqual([{ ruleId: taskRule.id, tool: "edit", pattern: "config/settings.json" }]);
    expect(spec.agent.planFirst).toBe(true);
    expect(spec.firstTurnMode).toBe("plan");
    expect(spec.agent.mcpServers).toEqual([
      { name: "release-names", transport: "http", proxyPath: "/mcp/release-names", readOnly: true },
      { name: "local-tool", transport: "stdio", command: "local-tool", args: ["--serve"], env: { LOG_LEVEL: "info" }, readOnly: false },
    ]);
    // The skill's SKILL.md and its file are blobs of this task, so the runner's lease may read them.
    const [skill] = spec.agent.skills ?? [];
    expect(skill?.name).toBe("changelog");
    const body = await blobs.read(world.organizationId, present(skill?.blobId), task.taskId);
    expect(body.ok && new TextDecoder().decode(body.value.bytes)).toBe("# changelog\nOne line per change.");
    expect(skill?.files.map((entry) => entry.path)).toEqual(["example.txt"]);
    const copied = skill?.files[0]?.blobId;
    expect(copied).not.toBe(skillFileBlobId);
    const fileBytes = await blobs.read(world.organizationId, present(copied), task.taskId);
    expect(fileBytes.ok && new TextDecoder().decode(fileBytes.value.bytes)).toBe("2026-11-19: example line\n");
    // The MCP server's address and secret never reach the spec.
    expect(first.text).not.toContain(MCP_TOKEN);
    expect(first.text).not.toContain(MCP_URL);
    // A second fetch copies nothing twice.
    const before = await test.db.blob.count({ where: { taskId: task.taskId } });
    expect((await fetchSpec(task.taskId, 2)).status).toBe(200);
    expect(await test.db.blob.count({ where: { taskId: task.taskId } })).toBe(before);
    expect(before).toBe(2);
  });

  it("F-021: the MCP headers are in the credentials for the sidecar, and in no spec, event or log line", async () => {
    records.length = 0;
    const task = await started(fixture.a.member, { agentProfileId: careful, runnerId: runner.runnerId });
    expect(await dispatch(world.organizationId, task)).toMatchObject({ ok: true });
    const spec = await fetchSpec(task.taskId, 2);
    expect(spec.text).not.toContain(MCP_TOKEN);
    const token = await accessToken(harness, runner);
    const response = await fetch(`${harness.url}${runnerPaths.taskCredentials(task.taskId)}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token.accessToken}`, [runnerHeaders.minor]: "2" },
      body: JSON.stringify({ taskId: task.taskId, leaseEpoch: 1 }),
    });
    expect(response.status).toBe(200);
    const credentials = taskCredentialsSchema.parse(await response.json());
    expect(credentials.mcpServers).toEqual([{ name: "release-names", url: MCP_URL, headers: { Authorization: `Bearer ${MCP_TOKEN}` } }]);
    // A runner below minor 2 gets none of it.
    const older = await postJson(`${harness.url}${runnerPaths.taskCredentials(task.taskId)}`, { taskId: task.taskId, leaseEpoch: 1 }, token.accessToken);
    expect(JSON.stringify(older.body)).not.toContain(MCP_TOKEN);
    // Nowhere else: not the event log, not the audit log, not a log line.
    const events = await test.db.event.findMany({ where: { taskId: task.taskId } });
    expect(JSON.stringify(events)).not.toContain(MCP_TOKEN);
    const audit = await test.db.auditEntry.findMany({ where: { entityId: task.taskId } });
    expect(JSON.stringify(audit)).not.toContain(MCP_TOKEN);
    expect(JSON.stringify(records)).not.toContain(MCP_TOKEN);
    expect(records.some((record) => record.message === "task.credentials-issued")).toBe(true);
  });

  it("F-021: a header stored with a trailing newline reaches the sidecar trimmed; one with a line break inside fails the credentials, not the runner", async () => {
    const put = async (value: string) => {
      const stored = await secretStore.put({ organizationId: world.organizationId, purpose: "agent-profile.mcp-header" }, value);
      if (!stored.ok) {
        throw new Error("the fake secret store refused");
      }
      return secretRefSchema.parse(stored.value);
    };
    const credentialsOf = async (value: string) => {
      const profile = await makeProfile(test.db, world.organizationId, await modelOf(world.profileId), {
        name: `Header ${String(Math.random())}`,
        mcpServers: [{ name: "release-names", transport: "http", url: MCP_URL, readOnly: true, headerSecretRefs: { Authorization: await put(value) } }],
      });
      const task = await started(fixture.a.member, { agentProfileId: profile, runnerId: runner.runnerId });
      expect(await dispatch(world.organizationId, task)).toMatchObject({ ok: true });
      const token = await accessToken(harness, runner);
      return fetch(`${harness.url}${runnerPaths.taskCredentials(task.taskId)}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token.accessToken}`, [runnerHeaders.minor]: "2" },
        body: JSON.stringify({ taskId: task.taskId, leaseEpoch: 1 }),
      });
    };
    const trailing = await credentialsOf(`Bearer ${MCP_TOKEN}\n`);
    expect(trailing.status).toBe(200);
    expect(taskCredentialsSchema.parse(await trailing.json()).mcpServers).toEqual([{ name: "release-names", url: MCP_URL, headers: { Authorization: `Bearer ${MCP_TOKEN}` } }]);
    const inside = await credentialsOf(`Bearer ${MCP_TOKEN}\nx-injected: 1`);
    expect(inside.status).toBe(502);
    expect(await inside.text()).not.toContain(MCP_TOKEN);
  });

  it("F-021: plan mode only on the task's first session before a plan; an archived profile still dispatches its tasks", async () => {
    const task = await started(fixture.a.member, { agentProfileId: careful, runnerId: runner.runnerId });
    await test.db.agentProfile.update({ where: { id: careful }, data: { archivedAt: new Date() } });
    try {
      expect(await dispatch(world.organizationId, task)).toMatchObject({ ok: true });
      const spec = taskSpecSchema.parse(JSON.parse((await fetchSpec(task.taskId, 2)).text));
      expect(spec.agent.profileId).toBe(careful);
      // A plan already proposed: the session starts in build mode.
      await test.db.task.update({ where: { id: task.taskId }, data: { planState: "proposed" } });
      expect(taskSpecSchema.parse(JSON.parse((await fetchSpec(task.taskId, 2)).text)).firstTurnMode).toBe("build");
      // A later session of the task: build mode too, though no plan was proposed.
      await test.db.task.update({ where: { id: task.taskId }, data: { planState: "none" } });
      await test.db.session.create({
        data: { organizationId: world.organizationId, projectId: world.projectId, taskId: task.taskId, agentProfileId: careful, origin: "new", state: "stopped", startedAt: new Date(Date.now() - 60_000) },
      });
      expect(taskSpecSchema.parse(JSON.parse((await fetchSpec(task.taskId, 2)).text)).firstTurnMode).toBe("build");
    } finally {
      await test.db.agentProfile.update({ where: { id: careful }, data: { archivedAt: null } });
    }
  });

  it("F-021: a minor-1 runner isn't offered a task whose profile needs minor 2, and the task says why", async () => {
    const old = await personalRunner(fixture.a.member, 1);
    const needing = await started(fixture.a.member, { agentProfileId: careful, runnerId: old.runnerId });
    expect(await dispatch(world.organizationId, needing)).toMatchObject({ ok: false, error: "no-runner", message: "needs-protocol" });
    const waiting = await test.db.task.findUniqueOrThrow({ where: { id: needing.taskId } });
    expect(waiting.dispatchWait).toEqual({ code: "needs-protocol", minor: 2 });
    expect(waiting.dispatchNote).toContain("needs a runner at protocol 2 or later");
    expect(await test.db.lease.count({ where: { taskId: needing.taskId } })).toBe(0);
    // The built-in profile, with nothing of minor 2's, goes to the same runner.
    const plain = await started(fixture.a.member, { agentProfileId: agentProfileIdSchema.parse(world.profileId), runnerId: old.runnerId });
    expect(await dispatch(world.organizationId, plain)).toMatchObject({ ok: true, runnerId: old.runnerId });
    // Once the runner speaks minor 2, the task goes.
    await test.db.runnerPresence.update({ where: { runnerId: old.runnerId }, data: { minor: 2 } });
    expect(await dispatch(world.organizationId, needing)).toMatchObject({ ok: true, runnerId: old.runnerId });
  });

  it("F-021: a session naming another organization's profile is never dispatched or specced with it", async () => {
    const task = await started(fixture.a.member, { runnerId: runner.runnerId });
    // Only a broken row could name it: the dispatch and the spec still read profiles by organization.
    await test.db.session.update({ where: { id: task.sessionId }, data: { agentProfileId: otherWorld.profileId } });
    expect(await dispatch(world.organizationId, task)).toMatchObject({ ok: false, error: "no-runner", message: "no-model" });
    expect(await test.db.lease.count({ where: { taskId: task.taskId } })).toBe(0);
    const projectId: ProjectId = world.projectId;
    expect(await test.db.task.count({ where: { projectId, agentProfileId: otherWorld.profileId } })).toBe(0);
  });
});
