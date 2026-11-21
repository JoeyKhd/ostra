import { randomBytes, randomUUID } from "node:crypto";

import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, SeededMember, TestDatabase } from "@ostra/db/testing";
import {
  acceptOffer,
  createPanelStartAppTokens,
  dispatchTask,
  PANEL_START_APP_PATH,
  PANEL_START_APP_TOKEN_TTL_MS,
  postgresAuditLog,
  postgresChangeNotices,
  postgresCommandOutbox,
  sendMemberMessageInTx,
  startAppAnswerSchema,
  systemClock,
} from "@ostra/domain";
import type { MemberScope } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { blobIdSchema, clientMessageIdSchema, commandIdSchema, commandSeqSchema, leaseEpochSchema, memberIdSchema, runnerPaths, tokenResponseSchema } from "@ostra/protocol";
import type { BlobRef, BoxId, DownFrame, LeaseEpoch, SessionId, TaskId, TaskSpec } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildTaskSpec } from "../dispatch/task-spec.ts";
import { FakeCodeHost, FakeSecretStore } from "../testing/fake-adapters.ts";
import { connectPeer, signAssertion } from "../testing/fake-peer.ts";
import type { FakePeer } from "../testing/fake-peer.ts";
import { postJson } from "../testing/harness.ts";
import { startPreviewReplica } from "../testing/previews.ts";
import type { PreviewReplica } from "../testing/previews.ts";
import { registerRunnerAt, waitFor } from "../testing/restart.ts";
import type { RegisteredAt } from "../testing/restart.ts";
import { dispatchPayload, seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";

// "Start the app" from the panel runs on core (milestone 8, F-141, Q300, ADR 0068): the panel asks
// `POST /panel/v1/previews/start-app` with its token for one member and one task, and core starts
// the app with the settings every dispatch of its own reads, the agent adapters' session archive
// capability among them. Real Postgres and pg-boss, core's gateway, previews and start route on a
// loopback port, and a fake runner at minor 7. The panel's side is `packages/api`'s
// `routers/previews.test.ts`.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let world: World;
let replica: PreviewReplica;
let runner: RegisteredAt;
let peer: FakePeer;
const records: LogRecord[] = [];
const logger = createLogger((record) => records.push(record));
const secret = randomBytes(32).toString("hex");
const signingKey = randomBytes(32);
const panelTokens = createPanelStartAppTokens(secret);
const CAPS = { capMicroUsd: 25_000_000, capTokens: 10_000_000 } as const;
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();

const scopeOf = (member: SeededMember): MemberScope => ({ organizationId: member.organizationId, memberId: member.id, role: member.role === "admin" ? "admin" : "member", projectRoles: new Map() });
const domainDeps = () => ({ jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, logger });

const tokenOf = async (url: string, registered: RegisteredAt): Promise<string> => {
  const response = await postJson(`${url}${runnerPaths.token}`, signAssertion(registered.key, registered.runnerId));
  return tokenResponseSchema.parse(response.body).accessToken;
};

/** The next command of `kind` the peer got that `match` takes. */
const commandOf = async (kind: string, match: (body: Record<string, unknown>) => boolean): Promise<Extract<DownFrame, { type: "command" }>> => {
  let found: Extract<DownFrame, { type: "command" }> | undefined;
  await waitFor(`a ${kind} command`, () => {
    found = peer.frames.find((frame): frame is Extract<DownFrame, { type: "command" }> => frame.type === "command" && frame.kind === kind && match(frame.body));
    return found !== undefined;
  }, 10_000);
  if (found === undefined) {
    throw new Error(`no ${kind} command`);
  }
  return found;
};

/** The panel's request, as `coreAppStarter` sends it: the token alone. */
const askCore = (taskId: TaskId, member: SeededMember = fixture.a.member, tokens = panelTokens) =>
  fetch(`${replica.url}${PANEL_START_APP_PATH}`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokens.issue({ organizationId: member.organizationId, memberId: memberIdSchema.parse(member.id), taskId, expiresAt: Date.now() + PANEL_START_APP_TOKEN_TTL_MS })}` },
  });

type StoppedTask = { readonly taskId: TaskId; readonly sessionId: SessionId; readonly boxId: BoxId; readonly archive: BlobRef };

/**
 * A task whose turn ended in review and whose box is gone, its session saved with an archive of the
 * agent's session, as the runner's `session.saved` leaves one.
 */
const stoppedWithArchive = async (): Promise<StoppedTask> => {
  const task = await seedQueuedTask(test.db, world, fixture.a.member, runner.runnerId);
  const dispatched = await test.db.$transaction((tx) => dispatchTask({ tx, ...domainDeps(), personalSlots: 50 }, dispatchPayload(task, 1)));
  if (!dispatched.ok) {
    throw new Error("not dispatched");
  }
  await test.db.lease.updateMany({ where: { taskId: task.taskId, epoch: 1 }, data: { acceptedAt: new Date() } });
  const blob = await test.db.blob.create({
    data: {
      organizationId: world.organizationId,
      projectId: world.projectId,
      taskId: task.taskId,
      store: "postgres",
      key: `postgres:${randomUUID()}`,
      purpose: "session-archive",
      contentType: "application/gzip",
      size: 1234,
      sha256: randomBytes(32).toString("hex"),
    },
  });
  await test.db.lease.updateMany({ where: { taskId: task.taskId }, data: { state: "ended", endedAt: new Date(), endReason: "released" } });
  await test.db.box.update({ where: { id: dispatched.boxId }, data: { state: "released", stoppedAt: new Date() } });
  await test.db.session.update({ where: { id: task.sessionId }, data: { state: "ended", outcome: "with_changes", endedAt: new Date(), archiveBlobId: blob.id } });
  await test.db.task.update({ where: { id: task.taskId }, data: { state: "in_review", subState: "waiting_for_reviewer" } });
  return { taskId: task.taskId, sessionId: task.sessionId, boxId: dispatched.boxId, archive: { blobId: blobIdSchema.parse(blob.id), size: blob.size, sha256: blob.sha256 } };
};

const specAt = async (taskId: TaskId, leaseEpoch: LeaseEpoch): Promise<TaskSpec> => {
  const built = await buildTaskSpec(
    { db: test.db, codeHost, secretStore, settings: { idleMinutes: 15, spendCap: CAPS } },
    { taskId, runnerId: runner.runnerId, leaseEpoch },
  );
  if (!built.ok) {
    throw new Error(`spec: ${built.error}`);
  }
  return built.spec;
};

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  world = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  const environment = await test.db.environment.findUniqueOrThrow({ where: { projectId: world.projectId } });
  await test.db.appProcess.create({
    data: { organizationId: world.organizationId, projectId: world.projectId, environmentId: environment.id, repoId: world.repoId, name: "web", command: "pnpm dev", port: 5173, readyKind: "http", readyValue: "/", label: "Web", primary: true },
  });
  replica = await startPreviewReplica(test.db, test.url, { signingKey, secret, jobs, logger, personalSlots: 50 });
  // The member's personal runner on `host`, at minor 7, which says it can show a preview.
  runner = await registerRunnerAt(replica.url, test.db, fixture.a.member);
  peer = await connectPeer(replica.url, await tokenOf(replica.url, runner), runner.runnerId, { preview: { stream: true, tunnel: true } });
  await peer.next("welcome");
}, 120_000);

afterAll(async () => {
  peer.close();
  await replica.stop();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

describe("\"Start the app\" on core", () => {
  it("F-141/c5: the panel's \"Start the app\" runs on core: the app's box restores the agent's archived session, not the template, and a message then resumes it there", async () => {
    const task = await stoppedWithArchive();

    const asked = await askCore(task.taskId);
    expect(asked.status).toBe(200);
    expect(startAppAnswerSchema.parse(await asked.json())).toEqual({ ok: true, state: "starting" });
    // An `app` lease, dispatched to the runner with no agent turn.
    const lease = await test.db.lease.findFirstOrThrow({ where: { taskId: task.taskId, state: "active" } });
    expect(lease).toMatchObject({ purpose: "app", appStartedByMemberId: fixture.a.member.id, epoch: 2, runnerId: runner.runnerId });
    const appSession = await test.db.session.findFirstOrThrow({ where: { taskId: task.taskId, state: "starting" } });
    const dispatch = await commandOf("dispatch", (body) => body["taskId"] === task.taskId && body["leaseEpoch"] === 2);
    expect(dispatch.body).toMatchObject({ purpose: "app", sessionId: appSession.id, boxId: lease.boxId });
    // The box is fresh (the old one is gone), and it restores from the archive: OpenCode imports one.
    expect(appSession).toMatchObject({ origin: "restored" });
    expect(lease.boxId).not.toBe(task.boxId);
    await test.db.$transaction((tx) =>
      acceptOffer({ tx, jobs, notices: postgresChangeNotices, clock: systemClock }, { runnerId: runner.runnerId, commandId: commandIdSchema.parse(dispatch.id), seq: commandSeqSchema.parse(dispatch.seq), result: "accepted" }),
    );
    const leaseEpoch = leaseEpochSchema.parse(2);
    expect((await specAt(task.taskId, leaseEpoch)).restore).toMatchObject({ origin: "restored", archive: task.archive });

    // A member's message starts a turn on that lease, in that box and session, whose agent session
    // the box restored from the archive.
    const sent = await test.db.$transaction((tx) =>
      sendMemberMessageInTx({ ...domainDeps(), spendCap: CAPS }, tx, scopeOf(fixture.a.member), {
        taskId: task.taskId,
        clientMessageId: clientMessageIdSchema.parse(randomUUID()),
        text: "Make the footer bold",
        intent: "message",
        sender: "anyone",
      }),
    );
    expect(sent).toMatchObject({ ok: true, delivery: "steer", sessionId: appSession.id, duplicate: false });
    expect(await test.db.lease.findUniqueOrThrow({ where: { id: lease.id } })).toMatchObject({ state: "active", purpose: "turn", epoch: 2 });
    expect((await commandOf("steer", (body) => body["sessionId"] === appSession.id)).body).toMatchObject({ text: "Make the footer bold" });
    expect(await test.db.session.findUniqueOrThrow({ where: { id: appSession.id } })).toMatchObject({ origin: "restored", boxId: lease.boxId });
    const spec = await specAt(task.taskId, leaseEpoch);
    expect(spec.restore?.origin).toBe("restored");
    expect(spec.restore?.archive).toEqual(task.archive);
  }, 60_000);

  it("F-141/c5: core refuses a start without the panel's token for that member and task, and writes nothing", async () => {
    const task = await stoppedWithArchive();
    const bare = await fetch(`${replica.url}${PANEL_START_APP_PATH}`, { method: "POST" });
    const forged = await askCore(task.taskId, fixture.a.member, createPanelStartAppTokens(randomBytes(32).toString("hex")));
    const stale = await fetch(`${replica.url}${PANEL_START_APP_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${panelTokens.issue({ organizationId: fixture.a.organization.id, memberId: memberIdSchema.parse(fixture.a.member.id), taskId: task.taskId, expiresAt: Date.now() - 1 })}` },
    });
    expect([bare.status, forged.status, stale.status]).toEqual([401, 401, 401]);
    // Another organization's admin, with a good token, finds no such task.
    const foreign = await askCore(task.taskId, fixture.b.admin);
    expect(startAppAnswerSchema.parse(await foreign.json())).toMatchObject({ ok: false, error: "not-found" });
    expect(await test.db.lease.count({ where: { taskId: task.taskId, state: "active" } })).toBe(0);
    expect(await test.db.session.count({ where: { taskId: task.taskId } })).toBe(1);
  }, 60_000);
});
