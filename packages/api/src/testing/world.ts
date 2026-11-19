import { randomBytes } from "node:crypto";

import { notifyChannels } from "@ostra/db";
import { ensureBuiltInAgentProfile } from "@ostra/domain";
import { projectIdSchema, repoFullNameSchema, repoIdSchema, runnerIdSchema, sessionIdSchema, taskIdSchema } from "@ostra/protocol";
import type { ConnectionId, OrganizationId, ProjectId, RunnerId, SessionId, TaskEvent, TaskId } from "@ostra/protocol";

import type { ApiHarness } from "./harness.ts";

// Seeding helpers for the tests of tasks and the stream: a project with a repo and a model, a
// personal runner, and tasks with events written the way core's ingest writes them (the task's
// counter row, the event row and the `NOTIFY`), so a reader sees what it would in production.

export const GITHUB_APP_ID = "5821041";
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nWORLD-KEY-BODY-0123456789\n-----END RSA PRIVATE KEY-----";
export const MODEL_BASE_URL = "https://models.example.com/v1";
const MODEL_TOKEN = "sk-world-model-token-0123456789abcdef";

/** Organization A's GitHub connection (the fake App), its model provider and the built-in profile's model. */
export const seedConnectionAndModel = async (harness: ApiHarness) => {
  const { a } = harness.fixture;
  harness.fakes.codeHost.apps.set(GITHUB_APP_ID, {
    privateKey: PEM,
    info: { appId: GITHUB_APP_ID, slug: "world-app", name: "world", permissions: { checks: "write", actions: "read" }, events: [] },
    bot: { name: "world-app[bot]", email: "1+world-app[bot]@users.noreply.github.com" },
    installations: [{ installationId: "9001", accountLogin: "ostra-test", accountKind: "organization", repositorySelection: "all" }],
    repos: new Map([
      ["9001", [{ hostRepoId: "1", fullName: "ostra-test/test1", defaultBranch: "main", private: true, cloneUrl: "https://github.example/ostra-test/test1.git" }]],
    ]),
  });
  harness.fakes.codeHost.files.set("ostra-test/test1", new Map([["package.json", "{}"]]));
  harness.fakes.modelProvider.endpoints.set(MODEL_BASE_URL, {
    token: MODEL_TOKEN,
    apiFormat: "anthropic-messages",
    authScheme: "x-api-key",
    models: [{ endpointModelId: "world-model", displayName: "World model", contextWindow: 100_000 }],
  });
  const admin = await harness.as(a.admin);
  const connected = await admin.github.connectExisting({ appId: GITHUB_APP_ID, privateKey: PEM, webhookSecret: "whsec-world-0123456789" });
  await harness.test.db.$transaction((tx) => ensureBuiltInAgentProfile(tx, a.organization.id));
  const provider = await admin.providers.create({
    name: "World models",
    baseUrl: MODEL_BASE_URL,
    apiFormat: "anthropic-messages",
    authScheme: "x-api-key",
    sessionsAtOnce: null,
    allowOnPersonalRunners: false,
    token: MODEL_TOKEN,
  });
  const [model] = await admin.providers.models({ providerId: provider.providerId });
  if (model === undefined) {
    throw new Error("the provider listed no model");
  }
  await admin.agentProfiles.setDefaultModel({ modelId: model.id });
  return { connectionId: connected.connectionId, installationId: "9001", providerId: provider.providerId, modelId: model.id };
};

/** A project on `ostra-test/test1` in organization A. */
export const seedProject = async (harness: ApiHarness, world: { readonly connectionId: ConnectionId; readonly installationId: string }, slug: string) => {
  const admin = await harness.as(harness.fixture.a.admin);
  const created = await admin.projects.create({
    name: slug,
    slug,
    access: "open",
    repo: { connectionId: world.connectionId, installationId: world.installationId, fullName: repoFullNameSchema.parse("ostra-test/test1") },
  });
  return { projectId: projectIdSchema.parse(created.projectId), repoId: repoIdSchema.parse(created.repoId) };
};

let runnerKeyCounter = 0;

/** A personal runner owned by a member. */
export const seedPersonalRunner = async (harness: ApiHarness, ownerMemberId: string, name: string): Promise<RunnerId> => {
  runnerKeyCounter += 1;
  const runner = await harness.test.db.runner.create({
    data: {
      organizationId: harness.fixture.a.organization.id,
      kind: "personal",
      ownerMemberId,
      name,
      publicKey: `k${String(runnerKeyCounter).padStart(42, "0")}`,
      executor: "host",
      capacity: 1,
      version: "0.0.0",
      state: "online",
    },
    select: { id: true },
  });
  return runnerIdSchema.parse(runner.id);
};

export type SeededTask = { readonly taskId: TaskId; readonly sessionId: SessionId };

/** A task row with a session, in any state, written directly (the lifecycle's own tests are the domain's). */
export const seedTask = async (
  harness: ApiHarness,
  input: {
    readonly organizationId: OrganizationId;
    readonly projectId: ProjectId;
    readonly title?: string;
    readonly state?: "queued" | "preparing" | "running" | "needs_you" | "stopped" | "in_review";
    readonly driverMemberId?: string | null;
    readonly creatorMemberId?: string | null;
    readonly sessionState?: "starting" | "running" | "waiting" | "idle" | "ended";
    readonly runnerId?: string | null;
  },
): Promise<SeededTask> => {
  const state = input.state ?? "running";
  const task = await harness.test.db.task.create({
    data: {
      organizationId: input.organizationId,
      projectId: input.projectId,
      kind: "code",
      source: "prompt",
      title: input.title ?? "A task",
      prompt: "A prompt",
      // Unique per project (ticket 46): the last 8 hex digits, as a real task's ID gives them.
      branchName: `ostra/${randomBytes(4).toString("hex")}-a-task`,
      state,
      ...(state === "needs_you" ? { needsYouReason: "question" as const } : {}),
      ...(state === "stopped" ? { stoppedReason: "requested" as const } : {}),
      ...(state === "in_review" ? { subState: "waiting_for_reviewer" as const } : {}),
      driverMemberId: input.driverMemberId ?? null,
      creatorMemberId: input.creatorMemberId ?? null,
      runnerId: input.runnerId ?? null,
    },
    select: { id: true },
  });
  const session = await harness.test.db.session.create({
    data: {
      organizationId: input.organizationId,
      projectId: input.projectId,
      taskId: task.id,
      origin: "new",
      state: input.sessionState ?? "running",
      ...(input.sessionState === "ended" ? { outcome: "with_changes" as const, endedAt: new Date() } : {}),
    },
    select: { id: true },
  });
  return { taskId: taskIdSchema.parse(task.id), sessionId: sessionIdSchema.parse(session.id) };
};

/** An active lease and its box, as core's dispatch makes them: the runner that holds the task. */
export const seedLease = async (harness: ApiHarness, task: SeededTask, organizationId: OrganizationId, projectId: ProjectId, runnerId: RunnerId, epoch = 1) => {
  const box = await harness.test.db.box.create({
    data: { organizationId, projectId, taskId: task.taskId, runnerId, executor: "host", state: "ready" },
    select: { id: true },
  });
  await harness.test.db.lease.create({ data: { organizationId, projectId, taskId: task.taskId, epoch, runnerId, boxId: box.id, state: "active" } });
  await harness.test.db.task.update({ where: { id: task.taskId }, data: { leaseEpoch: epoch } });
};

/**
 * Appends an event as core's ingest does: the task's counter, the row, and a `NOTIFY` that commits
 * with them. Returns the event's seq.
 */
export const appendEvent = async (
  harness: ApiHarness,
  task: SeededTask,
  at: { readonly organizationId: OrganizationId; readonly projectId: ProjectId },
  event: TaskEvent,
): Promise<number> =>
  harness.test.db.$transaction(async (tx) => {
    const counter = await tx.task.update({ where: { id: task.taskId }, data: { eventSeq: { increment: 1 } }, select: { eventSeq: true } });
    await tx.event.create({
      data: {
        organizationId: at.organizationId,
        projectId: at.projectId,
        taskId: task.taskId,
        seq: counter.eventSeq,
        sessionId: task.sessionId,
        sessionSeq: counter.eventSeq,
        leaseEpoch: 1,
        kind: event.kind,
        payload: event,
        occurredAt: new Date(),
      },
    });
    const payload = JSON.stringify({ taskId: task.taskId, seq: counter.eventSeq });
    await tx.$executeRaw`SELECT pg_notify(${notifyChannels.taskEvents}, ${payload})`;
    return counter.eventSeq;
  });

/** Writes or replaces one open segment's partial text (the `UNLOGGED` table core's ingest writes). */
export const writeLiveText = async (
  harness: ApiHarness,
  task: SeededTask,
  at: { readonly organizationId: OrganizationId; readonly projectId: ProjectId },
  segment: { readonly segmentId: string; readonly turnId: string; readonly text: string; readonly kind?: "message" | "thought" },
): Promise<void> => {
  await harness.test.db.$executeRaw`
    INSERT INTO "ostra_live"."live_text" ("taskId", "segmentId", "organizationId", "projectId", "sessionId", "turnId", "kind", "text")
    VALUES (${task.taskId}, ${segment.segmentId}, ${at.organizationId}, ${at.projectId}, ${task.sessionId}, ${segment.turnId}, ${segment.kind ?? "message"}, ${segment.text})
    ON CONFLICT ("taskId", "segmentId") DO UPDATE SET "text" = EXCLUDED."text", "updatedAt" = now()`;
};

export const deleteLiveText = async (harness: ApiHarness, task: SeededTask, segmentId: string): Promise<void> => {
  await harness.test.db.$executeRaw`DELETE FROM "ostra_live"."live_text" WHERE "taskId" = ${task.taskId} AND "segmentId" = ${segmentId}`;
};
