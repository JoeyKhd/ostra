import { randomUUID } from "node:crypto";

import { silentLogger } from "@ostra/adapter-sdk";
import { mapMember } from "@ostra/db";
import { changeEntities, segmentIdSchema, turnIdSchema } from "@ostra/protocol";
import type { ProjectId } from "@ostra/protocol";
import { isTrackedEnvelope } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Context } from "../trpc/context.ts";
import {
  appendEvent,
  createApiHarness,
  deleteLiveText,
  seedConnectionAndModel,
  seedProject,
  seedTask,
  writeLiveText,
} from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";
import { createStreamHub } from "./hub.ts";
import { openStream } from "./subscribe.ts";
import type { StreamInput, StreamMessage } from "./subscribe.ts";

// Ticket 33, ADR 0035: the live stream. Resume by sequence number with no gap and no duplicate,
// partial text that appears and is replaced by its committed message, every message filtered by
// organization and project access, a revoked membership that closes the stream, and two web
// processes reading one database.

let harness: ApiHarness;
let projectId: ProjectId;

beforeAll(async () => {
  harness = await createApiHarness();
  const world = await seedConnectionAndModel(harness);
  projectId = (await seedProject(harness, world, "stream")).projectId;
  await harness.hub.start();
});

afterAll(async () => {
  await harness.dispose();
});

const orgA = () => harness.fixture.a.organization.id;
const place = () => ({ organizationId: orgA(), projectId });
const turnId = turnIdSchema.parse("turn-1");

const message = (text: string) => ({
  kind: "agent.message" as const,
  turnId,
  segmentId: segmentIdSchema.parse(randomUUID()),
  text,
});

type Seen = { readonly id: string | null; readonly message: StreamMessage };

/** Opens the stream the way a subscription does, and records everything it yields. */
const watch = (context: Context, input: StreamInput) => {
  const controller = new AbortController();
  const seen: Seen[] = [];
  let failure: unknown = null;
  const finished = (async () => {
    try {
      for await (const value of openStream({ ...context, scope: context.member?.scope ?? failScope() }, input, controller.signal)) {
        if (isTrackedEnvelope(value)) {
          seen.push({ id: value[0], message: value[1] });
        } else {
          seen.push({ id: null, message: value });
        }
      }
    } catch (error) {
      failure = error;
    }
  })();
  const waitFor = async (predicate: (all: readonly Seen[]) => boolean, timeoutMs = 8000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(seen)) {
      if (Date.now() > deadline) {
        throw new Error(`timed out; saw ${JSON.stringify(seen.map((entry) => [entry.id, entry.message.type]))}`);
      }
      if (failure !== null) {
        throw new Error("the stream failed");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return {
    seen,
    waitFor,
    stop: async () => {
      controller.abort();
      await finished;
    },
    failure: () => failure,
    finished,
  };
};

const failScope = (): never => {
  throw new Error("this context has no member");
};

const events = (seen: readonly Seen[]) => seen.filter((entry) => entry.message.type === "event");
const eventSeqs = (seen: readonly Seen[]) =>
  events(seen).map((entry) => (entry.message.type === "event" ? entry.message.event.seq : -1));

describe("resume by sequence number (ADR 0035)", () => {
  it("yields committed events with tracked(seq), then the tail as it commits, each once", async () => {
    const task = await seedTask(harness, { ...place(), driverMemberId: harness.fixture.a.member.id });
    for (let index = 1; index <= 10; index += 1) {
      await appendEvent(harness, task, place(), message(`m${String(index)}`));
    }
    const viewer = watch(await harness.contextOf(harness.fixture.a.member), { taskId: task.taskId });
    await viewer.waitFor((all) => events(all).length === 10);
    expect(viewer.seen.map((entry) => entry.id)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);

    for (let index = 11; index <= 15; index += 1) {
      await appendEvent(harness, task, place(), message(`m${String(index)}`));
    }
    await viewer.waitFor((all) => events(all).length === 15);
    expect(eventSeqs(viewer.seen)).toEqual(Array.from({ length: 15 }, (_, index) => index + 1));
    await viewer.stop();
    expect(viewer.failure()).toBeNull();
  });

  it("resumed with Last-Event-ID reads seq > lastEventId: no gap and no duplicate", async () => {
    const task = await seedTask(harness, { ...place(), driverMemberId: harness.fixture.a.member.id });
    for (let index = 1; index <= 15; index += 1) {
      await appendEvent(harness, task, place(), message(`m${String(index)}`));
    }
    // The stream drops after 15 ...
    // ... and more commits while the viewer is away.
    for (let index = 16; index <= 20; index += 1) {
      await appendEvent(harness, task, place(), message(`m${String(index)}`));
    }
    // The client's link sends the last id it saw, and still holds the page's afterSeq.
    const resumed = watch(await harness.contextOf(harness.fixture.a.member), { taskId: task.taskId, afterSeq: 0, lastEventId: "15" });
    await resumed.waitFor((all) => events(all).length === 5);
    expect(resumed.seen.map((entry) => entry.id)).toEqual(["16", "17", "18", "19", "20"]);
    await resumed.stop();
  });

  it("starts after the page's head: the history page's newest seq is where the tail begins", async () => {
    const task = await seedTask(harness, place());
    for (let index = 1; index <= 8; index += 1) {
      await appendEvent(harness, task, place(), message(`m${String(index)}`));
    }
    const viewer = watch(await harness.contextOf(harness.fixture.a.member), { taskId: task.taskId, afterSeq: 5 });
    await viewer.waitFor((all) => events(all).length === 3);
    expect(eventSeqs(viewer.seen)).toEqual([6, 7, 8]);
    await viewer.stop();
  });

  it("has no gap and no duplicate when events commit while it catches up", async () => {
    const task = await seedTask(harness, place());
    for (let index = 1; index <= 20; index += 1) {
      await appendEvent(harness, task, place(), message(`before ${String(index)}`));
    }
    const writer = (async () => {
      for (let index = 1; index <= 40; index += 1) {
        await appendEvent(harness, task, place(), message(`during ${String(index)}`));
      }
    })();
    const viewer = watch(await harness.contextOf(harness.fixture.a.member), { taskId: task.taskId });
    await writer;
    await viewer.waitFor((all) => events(all).length >= 60);
    const seqs = eventSeqs(viewer.seen);
    expect(seqs).toEqual(Array.from({ length: 60 }, (_, index) => index + 1));
    await viewer.stop();
  });

  it("reads an event kind it doesn't know as unsupported, never dropping it", async () => {
    const task = await seedTask(harness, place());
    await harness.test.db.event.create({
      data: { organizationId: orgA(), projectId, taskId: task.taskId, seq: 1, sessionId: task.sessionId, sessionSeq: 1, kind: "from.the.future", payload: { kind: "from.the.future" }, occurredAt: new Date() },
    });
    await harness.test.db.task.update({ where: { id: task.taskId }, data: { eventSeq: 1 } });
    const viewer = watch(await harness.contextOf(harness.fixture.a.member), { taskId: task.taskId });
    await viewer.waitFor((all) => events(all).length === 1);
    const first = viewer.seen[0]?.message;
    expect(first?.type === "event" ? first.event.event : null).toEqual({ kind: "unsupported", rawKind: "from.the.future" });
    await viewer.stop();
  });
});

describe("live text (ADR 0035)", () => {
  it("shows a snapshot of the open partial text first, then deltas by offset, and drops it when the message commits", async () => {
    const task = await seedTask(harness, place());
    const segmentId = segmentIdSchema.parse(randomUUID());
    const live = { segmentId, turnId: "turn-1" };
    await writeLiveText(harness, task, place(), { ...live, text: "Hello" });

    const viewer = watch(await harness.contextOf(harness.fixture.a.member), { taskId: task.taskId });
    const frames = () => viewer.seen.flatMap((entry) => (entry.message.type === "live" ? [entry.message.frame] : []));
    await viewer.waitFor(() => frames().length === 1);
    // A viewer who joins late reads the current partial: a snapshot at offset 0.
    expect(frames()[0]).toMatchObject({ taskId: task.taskId, segmentId, kind: "message", offset: 0, text: "Hello" });

    // Deltas by offset: only what was added.
    await writeLiveText(harness, task, place(), { ...live, text: "Hello, wor" });
    await viewer.waitFor(() => frames().length === 2);
    expect(frames()[1]).toMatchObject({ offset: 5, text: ", wor" });
    await writeLiveText(harness, task, place(), { ...live, text: "Hello, world" });
    await viewer.waitFor(() => frames().length === 3);
    expect(frames()[2]).toMatchObject({ offset: 10, text: "ld" });

    // Text that isn't an extension of the last is sent whole.
    await writeLiveText(harness, task, place(), { ...live, text: "Goodbye" });
    await viewer.waitFor(() => frames().length === 4);
    expect(frames()[3]).toMatchObject({ offset: 0, text: "Goodbye" });

    // The completed message commits and the row goes: the event arrives, then the partial is dropped.
    await appendEvent(harness, task, place(), { kind: "agent.message", turnId, segmentId, text: "Goodbye" });
    await deleteLiveText(harness, task, segmentId);
    await viewer.waitFor((all) => all.some((entry) => entry.message.type === "live-end") && events(all).length === 1);
    expect(viewer.seen.find((entry) => entry.message.type === "live-end")?.message).toEqual({ type: "live-end", segmentId });
    // Live frames carry no id, so they never move the resume point; the committed event does.
    expect(viewer.seen.filter((entry) => entry.message.type === "live").every((entry) => entry.id === null)).toBe(true);
    expect(events(viewer.seen)[0]?.id).toBe("1");
    await viewer.stop();
  });

  it("splits a long snapshot into frames within the limit", async () => {
    const task = await seedTask(harness, place());
    await writeLiveText(harness, task, place(), { segmentId: randomUUID(), turnId: "turn-1", text: "x".repeat(70_000) });
    const viewer = watch(await harness.contextOf(harness.fixture.a.member), { taskId: task.taskId });
    const frames = () => viewer.seen.flatMap((entry) => (entry.message.type === "live" ? [entry.message.frame] : []));
    await viewer.waitFor(() => frames().length === 3);
    expect(frames().map((frame) => [frame.offset, frame.text.length])).toEqual([[0, 32_768], [32_768, 32_768], [65_536, 4_464]]);
    await viewer.stop();
  });
});

describe("authorization (ADR 0026, ADR 0035)", () => {
  it("refuses another organization's task, and a restricted project's task to a member who isn't on it", async () => {
    const task = await seedTask(harness, place());
    const outsider = watch(await harness.contextOf(harness.fixture.b.admin), { taskId: task.taskId });
    await outsider.finished;
    expect(outsider.failure()).toMatchObject({ code: "NOT_FOUND" });

    const restricted = await seedTask(harness, { organizationId: orgA(), projectId: harness.fixture.a.restrictedProject.id });
    const member = watch(await harness.contextOf(harness.fixture.a.member), { taskId: restricted.taskId });
    await member.finished;
    expect(member.failure()).toMatchObject({ code: "NOT_FOUND" });
    const insider = watch(await harness.contextOf(harness.fixture.a.insider), { taskId: restricted.taskId });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(insider.failure()).toBeNull();
    await insider.stop();
  });

  it("sends change notices of the member's organization only, and never a restricted project's to an outsider", async () => {
    const { a, b } = harness.fixture;
    const member = watch(await harness.contextOf(a.member), {});
    const insider = watch(await harness.contextOf(a.insider), {});
    const adminB = watch(await harness.contextOf(b.admin), {});
    await new Promise((resolve) => setTimeout(resolve, 100));

    const notice = async (organizationId: string, projectId: string | null, entityId: string) => {
      await harness.test.db.changeNotice.create({ data: { organizationId, projectId, entity: "task", entityId } });
    };
    await notice(a.organization.id, a.openProject.id, "open-task");
    await notice(a.organization.id, a.restrictedProject.id, "restricted-task");
    await notice(a.organization.id, null, "org-wide");
    await notice(b.organization.id, b.project.id, "b-task");

    const ids = (watcher: ReturnType<typeof watch>) =>
      watcher.seen.flatMap((entry) => (entry.message.type === "change" ? [entry.message.entityId] : []));
    await member.waitFor(() => ids(member).includes("org-wide"));
    await insider.waitFor(() => ids(insider).includes("org-wide"));
    await adminB.waitFor(() => ids(adminB).includes("b-task"));
    expect(ids(member)).toEqual(["open-task", "org-wide"]);
    expect(ids(insider)).toEqual(["open-task", "restricted-task", "org-wide"]);
    expect(ids(adminB)).toEqual(["b-task"]);
    expect(member.seen.every((entry) => entry.id === null)).toBe(true);
    await Promise.all([member.stop(), insider.stop(), adminB.stop()]);
  });

  it("delivers every kind of change notice typed, and skips a kind it doesn't know", async () => {
    const { a } = harness.fixture;
    const viewer = watch(await harness.contextOf(a.member), {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const entity of [...changeEntities, "from-a-newer-core"]) {
      await harness.test.db.changeNotice.create({ data: { organizationId: a.organization.id, projectId: null, entity, entityId: `id-${entity}` } });
    }
    const kinds = () => viewer.seen.flatMap((entry) => (entry.message.type === "change" ? [entry.message.entity] : []));
    await viewer.waitFor(() => kinds().length >= changeEntities.length);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(kinds()).toEqual([...changeEntities]);
    await viewer.stop();
  });

  it("closes the stream when the membership is revoked", async () => {
    const account = await harness.test.db.user.create({
      data: { id: randomUUID(), name: "leaver", email: `leaver-${randomUUID()}@example.com`, username: `leaver-${randomUUID()}` },
    });
    const row = await harness.test.db.member.create({
      data: { id: randomUUID(), organizationId: orgA(), userId: account.id, role: "member", createdAt: new Date() },
    });
    const task = await seedTask(harness, place());
    const context = await harness.contextOf(mapMember(row));
    // An open stream looks at its member again on a timer; this one every 100 ms.
    const viewer = watch({ ...context, deps: { ...context.deps, streamRecheckMs: 100 } }, { taskId: task.taskId });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(viewer.failure()).toBeNull();

    await harness.test.db.member.delete({ where: { id: row.id } });
    await Promise.race([viewer.finished, new Promise((resolve) => setTimeout(resolve, 3000))]);
    expect(viewer.failure()).toMatchObject({ code: "FORBIDDEN" });
    // Nothing more reaches a closed stream.
    const count = viewer.seen.length;
    await appendEvent(harness, task, place(), message("after the revocation"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(viewer.seen).toHaveLength(count);
  });

  it("closes the stream when the member loses access to the task's project", async () => {
    const { a } = harness.fixture;
    const restricted = await seedTask(harness, { organizationId: orgA(), projectId: a.restrictedProject.id });
    const context = await harness.contextOf(a.insider);
    const viewer = watch({ ...context, deps: { ...context.deps, streamRecheckMs: 100 } }, { taskId: restricted.taskId });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(viewer.failure()).toBeNull();
    await harness.test.db.projectMember.deleteMany({ where: { projectId: a.restrictedProject.id, memberId: a.insider.id } });
    await Promise.race([viewer.finished, new Promise((resolve) => setTimeout(resolve, 3000))]);
    expect(viewer.failure()).toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("two web processes on one database (ADR 0035)", () => {
  it("give both viewers the same events in the same order, woken by NOTIFY with polling nearly off", async () => {
    const second = createStreamHub({ db: harness.test.db, databaseUrl: harness.test.url, logger: silentLogger, pollMs: 60_000 });
    await second.start();
    try {
      const task = await seedTask(harness, place());
      const contextA = await harness.contextOf(harness.fixture.a.member);
      const contextB = await harness.contextOf(harness.fixture.a.insider);
      const viewerA = watch(contextA, { taskId: task.taskId });
      // The second viewer is served by the second process's tailer.
      const viewerB = watch({ ...contextB, deps: { ...contextB.deps, stream: second } }, { taskId: task.taskId });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const before = second.metrics().polls;
      for (let index = 1; index <= 25; index += 1) {
        await appendEvent(harness, task, place(), message(`event ${String(index)}`));
      }
      await viewerA.waitFor((all) => events(all).length === 25);
      await viewerB.waitFor((all) => events(all).length === 25, 4000);
      expect(eventSeqs(viewerB.seen)).toEqual(eventSeqs(viewerA.seen));
      expect(eventSeqs(viewerA.seen)).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
      // The second process had no poll to rely on: its wake-ups came from NOTIFY.
      expect(second.metrics().polls).toBe(before);
      expect(second.metrics().wakes).toBeGreaterThan(0);
      await Promise.all([viewerA.stop(), viewerB.stop()]);
    } finally {
      await second.stop();
    }
  });

  it("scales its queries with notifications, not with watchers", async () => {
    const hub = createStreamHub({ db: harness.test.db, databaseUrl: harness.test.url, logger: silentLogger, pollMs: 60_000 });
    await hub.start();
    try {
      const task = await seedTask(harness, place());
      const context = await harness.contextOf(harness.fixture.a.member);
      const watchers = Array.from({ length: 40 }, () => watch({ ...context, deps: { ...context.deps, stream: hub } }, { taskId: task.taskId }));
      await new Promise((resolve) => setTimeout(resolve, 200));
      const before = hub.metrics().eventQueries;
      for (let index = 1; index <= 5; index += 1) {
        await appendEvent(harness, task, place(), message(`event ${String(index)}`));
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      for (const watcher of watchers) {
        await watcher.waitFor((all) => events(all).length === 5);
      }
      // 5 events and 40 watchers: not 200 queries.
      expect(hub.metrics().eventQueries - before).toBeLessThanOrEqual(10);
      await Promise.all(watchers.map((watcher) => watcher.stop()));
    } finally {
      await hub.stop();
    }
  });
});

describe("a project restricted under a member", () => {
  it("F-087: reaches the member once as a change to that project, so the panel drops it at once, and nothing of it after", async () => {
    const { a } = harness.fixture;
    const project = await harness.test.db.project.create({ data: { organizationId: a.organization.id, name: "soon-restricted", slug: `soon-restricted-${randomUUID().slice(0, 6)}`, access: "open" } });
    const member = watch(await harness.contextOf(a.member), {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    const ids = () => member.seen.flatMap((entry) => (entry.message.type === "change" ? [entry.message.entityId] : []));

    await harness.test.db.project.update({ where: { id: project.id }, data: { access: "restricted" } });
    await harness.test.db.changeNotice.create({ data: { organizationId: a.organization.id, projectId: project.id, entity: "project", entityId: project.id } });
    await member.waitFor(() => ids().includes(project.id));

    // After that one notice the project is out of sight: neither its tasks nor its next change reach them.
    await harness.test.db.changeNotice.create({ data: { organizationId: a.organization.id, projectId: project.id, entity: "task", entityId: "hidden-task" } });
    await harness.test.db.changeNotice.create({ data: { organizationId: a.organization.id, projectId: project.id, entity: "project", entityId: project.id } });
    await harness.test.db.changeNotice.create({ data: { organizationId: a.organization.id, projectId: null, entity: "organization", entityId: "after" } });
    await member.waitFor(() => ids().includes("after"));
    expect(ids()).toEqual([project.id, "after"]);
    await member.stop();
  });
});
