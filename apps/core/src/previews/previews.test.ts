import { randomBytes, randomUUID } from "node:crypto";

import { createLogger } from "@ostra/adapter-sdk";
import type { LogRecord } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, SeededMember, TestDatabase } from "@ostra/db/testing";
import {
  acceptOffer,
  closeView,
  createPanelPreviewTokens,
  dispatchTask,
  heartbeatView,
  markViewConnected,
  newPreviewLinkToken,
  openView,
  panelPreviewPaths,
  postgresAuditLog,
  postgresChangeNotices,
  postgresCommandOutbox,
  sendMemberMessageInTx,
  startApp,
  sweepPreviewViews,
  systemClock,
} from "@ostra/domain";
import type { Clock, MemberScope } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import {
  clientMessageIdSchema,
  commandIdSchema,
  commandSeqSchema,
  leaseEpochSchema,
  PREVIEW_FRAMES_BODY_PART,
  previewFramesPartName,
  previewKeySchema,
  previewPaths,
  previewRefusalWords,
  runnerPaths,
  tokenResponseSchema,
  viewportPresetSizes,
} from "@ostra/protocol";
import type { BoxId, DownFrame, LeaseEpoch, PreviewInputEvent, PreviewViewId, RunnerId, SessionId, TaskId } from "@ostra/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { FakeCodeHost, FakeSecretStore } from "../testing/fake-adapters.ts";
import { connectPeer, signAssertion } from "../testing/fake-peer.ts";
import type { FakePeer } from "../testing/fake-peer.ts";
import { postJson } from "../testing/harness.ts";
import { connectFakeBox, fakeJpeg, openPanelStream, startPreviewReplica } from "../testing/previews.ts";
import type { FakeBox, PanelStream, PreviewReplica } from "../testing/previews.ts";
import { registerRunnerAt, waitFor } from "../testing/restart.ts";
import type { RegisteredAt } from "../testing/restart.ts";
import { dispatchPayload, seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";

// Milestone 8's ticket 19 (F-141, F-142, ADR 0068): core's views of a task's previews. Real
// Postgres and pg-boss, core's gateway and previews on a loopback port, a fake runner speaking the
// protocol (`hello` at minor 7 with what it can preview), a fake box opening the preview
// connection, and the panel's stream read as the pane reads it. The two-replica case is in
// `replicas.test.ts`, with two core processes.

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
const panelTokens = createPanelPreviewTokens(secret);
const web = previewKeySchema.parse("app-web");
const opened: { close: () => void }[] = [];

const scopeOf = (member: SeededMember): MemberScope => ({ organizationId: member.organizationId, memberId: member.id, role: member.role === "admin" ? "admin" : "member", projectRoles: new Map() });
const viewDeps = (clock: Clock = systemClock) => ({ db: test.db, outbox: postgresCommandOutbox, notices: postgresChangeNotices, clock, settings: { warmMinutes: 60 }, panelTokens });
const domainDeps = () => ({ jobs, outbox: postgresCommandOutbox, notices: postgresChangeNotices, audit: postgresAuditLog, clock: systemClock, logger });

const tokenOf = async (url: string, registered: RegisteredAt): Promise<string> => {
  const response = await postJson(`${url}${runnerPaths.token}`, signAssertion(registered.key, registered.runnerId));
  return tokenResponseSchema.parse(response.body).accessToken;
};

/** The runner's own access token, for a `host` box's preview connection. */
const runnerToken = (runnerId: RunnerId = runner.runnerId): string => replica.gateway.context.tokens.issue(runnerId, fixture.a.organization.id, Date.now()).accessToken;

/** The next command of `kind` the peer got, for `taskId` when given. */
const commandOf = async (from: FakePeer, kind: string, match: (body: Record<string, unknown>) => boolean = () => true): Promise<Extract<DownFrame, { type: "command" }>> => {
  let found: Extract<DownFrame, { type: "command" }> | undefined;
  await waitFor(`a ${kind} command`, () => {
    found = from.frames.find((frame): frame is Extract<DownFrame, { type: "command" }> => frame.type === "command" && frame.kind === kind && match(frame.body));
    return found !== undefined;
  }, 10_000);
  if (found === undefined) {
    throw new Error(`no ${kind} command`);
  }
  return found;
};

type Boxed = { readonly taskId: TaskId; readonly sessionId: SessionId; readonly boxId: BoxId; readonly leaseEpoch: LeaseEpoch };

/** A prompt task leased to `runnerId` (a `host` box), its offer accepted. */
const boxedTask = async (member: SeededMember = fixture.a.member, runnerId: RunnerId = runner.runnerId): Promise<Boxed> => {
  const task = await seedQueuedTask(test.db, world, member, runnerId);
  const result = await test.db.$transaction((tx) => dispatchTask({ tx, ...domainDeps(), personalSlots: 50 }, dispatchPayload(task, 1)));
  expect(result).toMatchObject({ ok: true, runnerId });
  if (!result.ok) {
    throw new Error("not dispatched");
  }
  await test.db.lease.updateMany({ where: { taskId: task.taskId, epoch: 1 }, data: { acceptedAt: new Date() } });
  return { taskId: task.taskId, sessionId: task.sessionId, boxId: result.boxId, leaseEpoch: leaseEpochSchema.parse(1) };
};

const openStreamView = async (task: Boxed, opener: Parameters<typeof openView>[1] = { kind: "member", scope: scopeOf(fixture.a.member) }) => {
  const view = await openView(viewDeps(), opener, { taskId: task.taskId, key: web, mode: "stream", viewport: null });
  if (!view.ok) {
    throw new Error(`the view didn't open: ${view.error}`);
  }
  return view;
};

const box = async (viewId: PreviewViewId, epoch = 1, runnerId: RunnerId = runner.runnerId): Promise<FakeBox> => {
  const connected = await connectFakeBox(replica.url, viewId, epoch, runnerToken(runnerId));
  opened.push(connected);
  await waitFor("the view's presence", async () => (await test.db.previewView.findUniqueOrThrow({ where: { id: viewId } })).replicaUrl === replica.url, 5_000);
  return connected;
};

const stream = async (viewId: PreviewViewId, panelToken: string): Promise<PanelStream> => {
  const panel = await openPanelStream(replica.url, viewId, { authorization: `Bearer ${panelToken}` });
  opened.push({ close: panel.abort });
  return panel;
};

const click: PreviewInputEvent = { kind: "mouse", action: "down", x: 120, y: 48, button: "left", clickCount: 1, modifiers: 0 };

const postInput = (viewId: PreviewViewId, panelToken: string, events: readonly PreviewInputEvent[] = [click]) =>
  fetch(`${replica.url}${panelPreviewPaths.input(viewId)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${panelToken}`, "content-type": "application/json" },
    body: JSON.stringify({ events }),
  });

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  world = await seedWorld(test.db, { codeHost: new FakeCodeHost(), secretStore: new FakeSecretStore() }, fixture.a.organization.id, fixture.a.openProject.id);
  // The environment's app: a frontend, the primary preview.
  const environment = await test.db.environment.findUniqueOrThrow({ where: { projectId: world.projectId } });
  await test.db.appProcess.create({
    data: { organizationId: world.organizationId, projectId: world.projectId, environmentId: environment.id, repoId: world.repoId, name: "web", command: "pnpm dev", port: 5173, readyKind: "http", readyValue: "/", label: "Web", primary: true },
  });
  replica = await startPreviewReplica(test.db, test.url, { signingKey, secret, jobs, logger });
  // The member's personal runner on `host`, at minor 7, which says it can show a preview.
  runner = await registerRunnerAt(replica.url, test.db, fixture.a.member);
  peer = await connectPeer(replica.url, await tokenOf(replica.url, runner), runner.runnerId, { preview: { stream: true, tunnel: true } });
  await peer.next("welcome");
}, 120_000);

afterEach(() => {
  for (const connection of opened.splice(0)) {
    connection.close();
  }
});

afterAll(async () => {
  peer.close();
  await replica.stop();
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

describe("a preview's views on core", () => {
  it("F-141/c1: a view opened, streamed and closed", async () => {
    // The runner's `hello` said what it can show, and its row keeps it.
    expect((await test.db.runner.findUniqueOrThrow({ where: { id: runner.runnerId } })).preview).toEqual({ stream: true, tunnel: true });
    const task = await boxedTask();
    const view = await openStreamView(task);
    expect(view.input).toBe(true);
    // The row, its event, and `preview.open` to the box's runner, in one transaction.
    expect(await test.db.previewView.findUniqueOrThrow({ where: { id: view.viewId } })).toMatchObject({ taskId: task.taskId, key: web, mode: "stream", state: "opening", openedByMemberId: fixture.a.member.id, leaseEpoch: 1 });
    expect(await test.db.event.count({ where: { taskId: task.taskId, kind: "preview.opened" } })).toBe(1);
    const open = await commandOf(peer, "preview.open", (body) => body["viewId"] === view.viewId);
    expect(open.body).toMatchObject({ sessionId: task.sessionId, key: web, mode: "stream", viewport: viewportPresetSizes.desktop });

    // The box opens the preview connection: this replica writes the view's presence.
    const connected = await box(view.viewId);
    expect(await test.db.previewView.findUniqueOrThrow({ where: { id: view.viewId } })).toMatchObject({ state: "open", replicaUrl: replica.url });

    // The panel's stream carries the box's frames, and each is acked once the stream took it.
    const panel = await stream(view.viewId, view.panelToken);
    expect(panel.status).toBe(200);
    connected.sendFrame(1);
    expect((await panel.next("frame")).header.seq).toBe(1);
    expect((await connected.next("ack")).ack.seq).toBe(1);
    connected.sendFrame(2);
    const second = await panel.next("frame");
    expect([second.header.seq, Buffer.from(second.jpeg).equals(Buffer.from(fakeJpeg(2)))]).toEqual([2, true]);
    expect((await connected.next("ack")).ack.seq).toBe(2);

    // A member's input reaches the box as a `control`, in order.
    expect((await postInput(view.viewId, view.panelToken)).status).toBe(204);
    expect((await connected.next("control")).control).toMatchObject({ kind: "input", events: [click] });

    // The frames are the app's traffic: they never count as watching (only the heartbeat does).
    expect((await test.db.box.findUniqueOrThrow({ where: { id: task.boxId } })).previewWatchedAt).toBeNull();
    expect(await heartbeatView(viewDeps(), { viewId: view.viewId })).toEqual({ ok: true, open: true });
    expect((await test.db.box.findUniqueOrThrow({ where: { id: task.boxId } })).previewWatchedAt).not.toBeNull();

    // Closed: `preview.close` to the runner, `close` to the box and to the stream.
    expect(await closeView(viewDeps(), { viewId: view.viewId, reason: "closed" })).toEqual({ ok: true, closed: true });
    expect((await commandOf(peer, "preview.close", (body) => body["viewId"] === view.viewId)).body).toMatchObject({ sessionId: task.sessionId });
    expect((await connected.next("close")).close.reason).toBe("closed");
    expect((await panel.next("close")).close.reason).toBe("closed");
    await connected.closed;
    expect(await test.db.previewView.findUniqueOrThrow({ where: { id: view.viewId } })).toMatchObject({ state: "closed" });
    expect(await test.db.event.count({ where: { taskId: task.taskId, kind: "preview.closed" } })).toBe(1);
    // A closed view takes no stream, and no heartbeat.
    expect((await openPanelStream(replica.url, view.viewId, { authorization: `Bearer ${view.panelToken}` })).status).toBe(410);
    expect(await heartbeatView(viewDeps(), { viewId: view.viewId })).toMatchObject({ ok: false, error: "closed" });
    // Never a token in a log line.
    expect(JSON.stringify(records)).not.toContain(view.panelToken);
  }, 60_000);

  it("F-141/c2: a preview connection with a stale lease epoch is refused, as an event is", async () => {
    const task = await boxedTask();
    const view = await openStreamView(task);
    // A newer lease took the task: the box of epoch 1 is stale.
    await test.db.task.update({ where: { id: task.taskId }, data: { leaseEpoch: 2 } });
    await expect(connectFakeBox(replica.url, view.viewId, 1, runnerToken())).rejects.toThrow("upgrade refused: 409");
    await test.db.task.update({ where: { id: task.taskId }, data: { leaseEpoch: 1 } });
    // An epoch the view wasn't opened under, and no lease holds.
    await expect(connectFakeBox(replica.url, view.viewId, 2, runnerToken())).rejects.toThrow("upgrade refused: 409");
    // Another runner's token is no lease at all.
    const other = await registerRunnerAt(replica.url, test.db, fixture.a.member);
    await expect(connectFakeBox(replica.url, view.viewId, 1, runnerToken(other.runnerId))).rejects.toThrow("upgrade refused: 401");
    // The HTTP carrier's frames are refused the same way.
    const form = new FormData();
    form.set(PREVIEW_FRAMES_BODY_PART, JSON.stringify({ viewId: view.viewId, leaseEpoch: 2, frames: [{ seq: 1, at: Date.now(), width: 1440, height: 900, part: previewFramesPartName(0) }] }));
    form.set(previewFramesPartName(0), new Blob([fakeJpeg(1)]));
    const frames = await fetch(`${replica.url}${previewPaths.frames}`, { method: "POST", headers: { authorization: `Bearer ${runnerToken()}` }, body: form });
    expect([frames.status, await frames.json()]).toEqual([409, { code: "stale-lease" }]);
    // The current epoch connects.
    const connected = await box(view.viewId);
    expect(connected.received).toEqual([]);
  }, 60_000);

  it("F-141/c4: a watched box stays warm to the cap, by the Clock, and idles out after it", async () => {
    const task = await boxedTask();
    // The turn ended at T0: the box is idle. The clock moves on from there.
    const t0 = Date.now() - 59 * 60_000;
    await test.db.box.update({ where: { id: task.boxId }, data: { state: "idle", idleSince: new Date(t0) } });
    let now = t0 + 60_000;
    const clock: Clock = { now: () => now };
    const view = await openView(viewDeps(clock), { kind: "member", scope: scopeOf(fixture.a.member) }, { taskId: task.taskId, key: web, mode: "stream", viewport: null });
    if (!view.ok) {
      throw new Error(view.error);
    }
    await markViewConnected(test.db, view.viewId, replica.url, now);
    const state = async (): Promise<string> => (await test.db.previewView.findUniqueOrThrow({ where: { id: view.viewId } })).state;
    // Watched: a heartbeat every 30 s keeps the box, up to 60 minutes after its turn ended.
    for (const minute of [10, 30, 58, 59]) {
      now = t0 + minute * 60_000;
      expect(await heartbeatView(viewDeps(clock), { viewId: view.viewId })).toEqual({ ok: true, open: true });
      now += 30_000;
      await sweepPreviewViews({ ...viewDeps(clock), settings: { warmMinutes: 60 } });
      expect(await state()).toBe("open");
    }
    expect((await test.db.box.findUniqueOrThrow({ where: { id: task.boxId } })).previewWatchedAt?.getTime()).toBe(t0 + 59 * 60_000);
    // Past the cap, watched or not, its views close and the box idles out as ADR 0039 says.
    now = t0 + 60 * 60_000 + 15_000;
    expect(await heartbeatView(viewDeps(clock), { viewId: view.viewId })).toEqual({ ok: true, open: true });
    now += 15_000;
    const swept = await sweepPreviewViews({ ...viewDeps(clock), settings: { warmMinutes: 60 } });
    expect(swept["warm-cap"]).toBeGreaterThanOrEqual(1);
    expect(await state()).toBe("closed");
    await commandOf(peer, "preview.close", (body) => body["viewId"] === view.viewId);
    // A new view doesn't hold it again.
    now += 30_000;
    expect(await openView(viewDeps(clock), { kind: "member", scope: scopeOf(fixture.a.member) }, { taskId: task.taskId, key: web, mode: "stream", viewport: null })).toMatchObject({ ok: false, error: "no-box" });

    // A view nobody watches closes after 2 minutes, within the cap.
    const other = await boxedTask();
    await test.db.box.update({ where: { id: other.boxId }, data: { state: "idle", idleSince: new Date(Date.now()) } });
    now = Date.now();
    const unwatched = await openView(viewDeps(clock), { kind: "member", scope: scopeOf(fixture.a.member) }, { taskId: other.taskId, key: web, mode: "stream", viewport: null });
    if (!unwatched.ok) {
      throw new Error(unwatched.error);
    }
    await markViewConnected(test.db, unwatched.viewId, replica.url, now);
    now += 90_000;
    await sweepPreviewViews({ ...viewDeps(clock), settings: { warmMinutes: 60 } });
    expect((await test.db.previewView.findUniqueOrThrow({ where: { id: unwatched.viewId } })).state).toBe("open");
    now += 45_000;
    await sweepPreviewViews({ ...viewDeps(clock), settings: { warmMinutes: 60 } });
    expect((await test.db.previewView.findUniqueOrThrow({ where: { id: unwatched.viewId } })).state).toBe("closed");
  }, 60_000);

  it("F-141/c5: \"Start the app\" admits an app lease and dispatches no agent; a message then starts a turn on it", async () => {
    // A task in review whose box is gone: its turn ended and the box stopped.
    const task = await boxedTask();
    await test.db.lease.updateMany({ where: { taskId: task.taskId }, data: { state: "ended", endedAt: new Date(), endReason: "released" } });
    await test.db.box.update({ where: { id: task.boxId }, data: { state: "stopped", stoppedAt: new Date() } });
    await test.db.session.update({ where: { id: task.sessionId }, data: { state: "ended", outcome: "with_changes", endedAt: new Date() } });
    await test.db.task.update({ where: { id: task.taskId }, data: { state: "in_review", subState: "waiting_for_reviewer" } });
    const scope = scopeOf(fixture.a.member);
    const startDeps = { db: test.db, ...domainDeps(), dispatch: { personalSlots: 50 } };

    expect(await startApp(startDeps, scope, { taskId: task.taskId })).toEqual({ ok: true, state: "starting" });
    // A lease with the purpose `app`, admitted at once, and a dispatch that launches no agent.
    const lease = await test.db.lease.findFirstOrThrow({ where: { taskId: task.taskId, state: "active" } });
    expect(lease).toMatchObject({ purpose: "app", appStartedByMemberId: fixture.a.member.id, epoch: 2, runnerId: runner.runnerId });
    const dispatch = await commandOf(peer, "dispatch", (body) => body["taskId"] === task.taskId && body["leaseEpoch"] === 2);
    expect(dispatch.body).toMatchObject({ purpose: "app", boxId: lease.boxId });
    const appSession = await test.db.session.findFirstOrThrow({ where: { taskId: task.taskId, state: "starting" } });
    expect(dispatch.body).toMatchObject({ sessionId: appSession.id });
    expect(await test.db.event.count({ where: { taskId: task.taskId, kind: "app.started_by", sessionId: appSession.id } })).toBe(1);
    expect(await test.db.auditEntry.count({ where: { action: "app.started", entityId: task.taskId, actorId: fixture.a.member.id } })).toBe(1);
    // The task's own state doesn't move, and stays so once the runner takes the box.
    const accepted = await test.db.$transaction((tx) =>
      acceptOffer({ tx, jobs, notices: postgresChangeNotices, clock: systemClock }, { runnerId: runner.runnerId, commandId: commandIdSchema.parse(dispatch.id), seq: commandSeqSchema.parse(dispatch.seq), result: "accepted" }),
    );
    expect(accepted).toEqual({ ok: true, outcome: "accepted" });
    expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "in_review", leaseEpoch: 2 });
    // Pressed again while the box runs: the processes start in it, with no second lease.
    expect(await startApp(startDeps, scope, { taskId: task.taskId })).toEqual({ ok: true, state: "running" });
    expect((await commandOf(peer, "app.start", (body) => body["sessionId"] === appSession.id)).body).toEqual({ sessionId: appSession.id, names: null });
    expect(await test.db.lease.count({ where: { taskId: task.taskId } })).toBe(2);

    // A member's message starts a turn on that lease, in that box and session: the agent starts at the steer.
    const sent = await test.db.$transaction((tx) =>
      sendMemberMessageInTx({ ...domainDeps() }, tx, scope, { taskId: task.taskId, clientMessageId: clientMessageIdSchema.parse(randomUUID()), text: "Make the footer bold", intent: "message", sender: "anyone" }),
    );
    expect(sent).toMatchObject({ ok: true, delivery: "steer", sessionId: appSession.id, duplicate: false });
    expect(await test.db.lease.findUniqueOrThrow({ where: { id: lease.id } })).toMatchObject({ state: "active", purpose: "turn", appStartedByMemberId: null });
    expect(await test.db.lease.count({ where: { taskId: task.taskId } })).toBe(2);
    expect((await commandOf(peer, "steer", (body) => body["sessionId"] === appSession.id)).body).toMatchObject({ text: "Make the footer bold", delivery: "queue" });
    expect(await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).toMatchObject({ state: "preparing", leaseEpoch: 2 });
  }, 60_000);

  it("F-141/c6: a runner below minor 7 gets no view and no app start, with the reason", async () => {
    // The admin's only runner speaks minor 6.
    const old = await registerRunnerAt(replica.url, test.db, fixture.a.admin);
    const oldPeer = await connectPeer(replica.url, await tokenOf(replica.url, old), old.runnerId, { minor: 6 });
    opened.push(oldPeer);
    await oldPeer.next("welcome");
    const task = await boxedTask(fixture.a.admin, old.runnerId);
    expect(await openView(viewDeps(), { kind: "member", scope: scopeOf(fixture.a.admin) }, { taskId: task.taskId, key: web, mode: "stream", viewport: null })).toEqual({
      ok: false,
      error: "runner-needs-upgrade",
      message: previewRefusalWords("runner-needs-upgrade"),
    });
    expect(await test.db.previewView.count({ where: { taskId: task.taskId } })).toBe(0);
    // "Start the app" with no box goes only to a minor-7 runner: here there's none, and it says why, with nothing written.
    await test.db.lease.updateMany({ where: { taskId: task.taskId }, data: { state: "ended", endedAt: new Date(), endReason: "released" } });
    await test.db.box.update({ where: { id: task.boxId }, data: { state: "stopped", stoppedAt: new Date() } });
    await test.db.session.update({ where: { id: task.sessionId }, data: { state: "ended", outcome: "with_changes", endedAt: new Date() } });
    await test.db.task.update({ where: { id: task.taskId }, data: { state: "in_review", subState: "waiting_for_reviewer" } });
    expect(await startApp({ db: test.db, ...domainDeps(), dispatch: { personalSlots: 50 } }, scopeOf(fixture.a.admin), { taskId: task.taskId })).toMatchObject({ ok: false, error: "runner-needs-upgrade" });
    expect(await test.db.lease.count({ where: { taskId: task.taskId } })).toBe(1);
    expect(await test.db.session.count({ where: { taskId: task.taskId } })).toBe(1);
    expect(oldPeer.frames.some((frame) => frame.type === "command" && (frame.kind === "preview.open" || frame.kind === "app.start"))).toBe(false);
  }, 60_000);

  it("frames posted over the HTTP carrier reach the stream, at most 2 a second", async () => {
    const task = await boxedTask();
    const view = await openStreamView(task);
    const post = (seqs: readonly number[]) => {
      const form = new FormData();
      form.set(PREVIEW_FRAMES_BODY_PART, JSON.stringify({ viewId: view.viewId, leaseEpoch: 1, frames: seqs.map((seq, index) => ({ seq, at: Date.now(), width: 390, height: 844, part: previewFramesPartName(index) })) }));
      seqs.forEach((seq, index) => {
        form.set(previewFramesPartName(index), new Blob([fakeJpeg(seq)]));
      });
      return fetch(`${replica.url}${previewPaths.frames}`, { method: "POST", headers: { authorization: `Bearer ${runnerToken()}` }, body: form });
    };
    const panel = stream(view.viewId, view.panelToken);
    const first = await post([1, 2]);
    expect([first.status, await first.json()]).toEqual([200, { ackedUpTo: 2 }]);
    const reading = await panel;
    expect(reading.status).toBe(200);
    // The newest frame first, for a stream that joins.
    expect((await reading.next("frame")).header.seq).toBe(2);
    const third = await post([3]);
    expect([third.status, await third.json()]).toEqual([429, { code: "too-fast" }]);
    await new Promise((wait) => setTimeout(wait, 1_100));
    expect((await post([4])).status).toBe(200);
    expect((await reading.next("frame")).header.seq).toBe(4);
  }, 60_000);
});

describe("sharing a preview on core", () => {
  it("F-142/c1: input from a watch-only link is dropped before it reaches the runner", async () => {
    const task = await boxedTask();
    const link = async (allowInput: boolean): Promise<string> => {
      const made = newPreviewLinkToken();
      await test.db.previewLink.create({
        data: { organizationId: world.organizationId, projectId: world.projectId, taskId: task.taskId, key: web, kind: "expiring", tokenHash: made.tokenHash, allowInput, expiresAt: new Date(Date.now() + 3_600_000), createdByMemberId: fixture.a.member.id },
      });
      return made.token;
    };
    const watchOnly = await openStreamView(task, { kind: "link", token: await link(false) });
    expect(watchOnly.input).toBe(false);
    const watching = await box(watchOnly.viewId);
    const panel = await stream(watchOnly.viewId, watchOnly.panelToken);
    watching.sendFrame(1);
    expect((await panel.next("frame")).header.seq).toBe(1);
    // The link watches, and its clicks stop at core.
    const refused = await postInput(watchOnly.viewId, watchOnly.panelToken);
    expect([refused.status, await refused.json()]).toEqual([403, { error: { code: "watch-only", message: "this view is watch-only" } }]);
    await new Promise((wait) => setTimeout(wait, 300));
    expect(watching.received.filter((message) => message.type === "control")).toEqual([]);
    // A link that allows input reaches the box.
    const typing = await openStreamView(task, { kind: "link", token: await link(true) });
    expect(typing.input).toBe(true);
    const typed = await box(typing.viewId);
    expect((await postInput(typing.viewId, typing.panelToken)).status).toBe(204);
    expect((await typed.next("control")).control).toMatchObject({ kind: "input", events: [click] });
    // A panel token for one view opens no other.
    expect((await postInput(typing.viewId, watchOnly.panelToken)).status).toBe(401);
    // And a revoked link stops at once, read again on the next batch.
    await test.db.previewLink.updateMany({ where: { taskId: task.taskId, allowInput: true }, data: { revokedAt: new Date(), revokedByMemberId: fixture.a.member.id } });
    expect((await postInput(typing.viewId, typing.panelToken)).status).toBe(403);
    expect(typed.received.filter((message) => message.type === "control")).toHaveLength(1);
  }, 60_000);
});
