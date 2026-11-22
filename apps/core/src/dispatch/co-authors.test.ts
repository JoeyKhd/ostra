import { createApiHarness } from "@ostra/api/testing";
import type { ApiHarness } from "@ostra/api/testing";
import type { SeededMember } from "@ostra/db/testing";
import { clientMessageIdSchema, leaseEpochSchema, organizationIdSchema, projectIdSchema } from "@ostra/protocol";
import type { GitPerson, RunnerId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FakeCodeHost, FakeSecretStore } from "../testing/fake-adapters.ts";
import { recordSessionModel, seedOnlineRunner, seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { QueuedTask, World } from "../testing/world.ts";
import { buildTaskSpec } from "./task-spec.ts";

// F-078/c2 (ADR 0040, Q41): every member whose prompt led to a task's commits gets a
// `Co-authored-by` trailer on them, not only the one who started it. The panel's own procedures
// send, take over, reopen and press "Update branch". Two carry the trailers to the box: a message
// steered into a session that's going carries the task's co-authors with its sender (the steer's
// `coAuthors`, minor 8), which the runner applies to the box's next commits mid-session (the
// executors' and the runner's F-078/c2 tests); a fresh session's spec (`buildTaskSpec`) carries
// them too. The trailers' addresses follow the verified link (F-119).

let api: ApiHarness;
let world: World;
let runnerId: RunnerId;
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();
const HEAD = "a".repeat(40);

beforeAll(async () => {
  api = await createApiHarness();
  const { a } = api.fixture;
  world = await seedWorld(api.test.db, { codeHost, secretStore }, organizationIdSchema.parse(a.organization.id), projectIdSchema.parse(a.openProject.id));
  ({ runnerId } = await seedOnlineRunner(api.test.db, world.organizationId, { kind: "personal", memberId: a.member.id }));
});

afterAll(async () => {
  await api.dispose();
});

const newMessageId = () => clientMessageIdSchema.parse(`client-${crypto.randomUUID()}`);

/** Gives the task's newest session a box and the lease of `epoch` on the runner, as a dispatch does. */
const lease = async (task: QueuedTask, epoch: number): Promise<void> => {
  const db = api.test.db;
  const session = await db.session.findFirstOrThrow({ where: { taskId: task.taskId }, orderBy: [{ startedAt: "desc" }, { id: "desc" }] });
  const box = await db.box.create({ data: { organizationId: world.organizationId, projectId: world.projectId, taskId: task.taskId, runnerId, executor: "host", state: "ready" } });
  await db.lease.create({ data: { organizationId: world.organizationId, projectId: world.projectId, taskId: task.taskId, epoch, runnerId, boxId: box.id, state: "active" } });
  await db.task.update({ where: { id: task.taskId }, data: { leaseEpoch: epoch } });
  await recordSessionModel(db, world, session.id);
  await db.session.update({ where: { id: session.id }, data: { boxId: box.id } });
};

/** A task the member started, running on its lease, with an open PR whose branch is behind its base. */
const runningTask = async (): Promise<QueuedTask> => {
  const task = await seedQueuedTask(api.test.db, world, api.fixture.a.member, runnerId);
  await lease(task, 1);
  await api.test.db.task.update({ where: { id: task.taskId }, data: { state: "running" } });
  await api.test.db.session.updateMany({ where: { taskId: task.taskId }, data: { state: "running" } });
  await api.test.db.taskRepo.updateMany({ where: { taskId: task.taskId }, data: { state: "pr_open", prNumber: 7, headSha: HEAD, ahead: true, behindBy: 2 } });
  return task;
};

/** The co-authors the newest steer of the task carries to its running box (minor 8). */
const steeredCoAuthors = (clientMessageId: string): unknown =>
  api.fakes.outbox.commands.find((command) => command.kind === "steer" && Reflect.get(Object(command.body), "clientMessageId") === clientMessageId)?.body;

/** The trailers the runner is handed for the task's next commits. */
const coAuthorsOf = async (task: QueuedTask, epoch: number): Promise<readonly GitPerson[]> => {
  const built = await buildTaskSpec({ db: api.test.db, codeHost, secretStore }, { taskId: task.taskId, runnerId, leaseEpoch: leaseEpochSchema.parse(epoch) });
  if (!built.ok) throw new Error(`no spec: ${built.message}`);
  return built.spec.coAuthors;
};

/** The member's trailer as ostra writes it before a GitHub link: their ostra name and email. */
const person = async (member: SeededMember): Promise<GitPerson> => {
  const user = await api.test.db.user.findUniqueOrThrow({ where: { id: member.userId }, select: { name: true, email: true } });
  return { name: user.name, email: user.email };
};

/** The creator's row, as `seedQueuedTask` writes it at the start. */
const CREATOR = { name: "Ada Admin", email: "ada@example.com" } as const;

describe("F-078/c2: a trailer for each member whose prompt led to the commits", () => {
  it("F-078/c2: a member who takes over and sends, and one who presses Update branch, each get a trailer once; a refused send gets none", async () => {
    const task = await runningTask();
    const { insider, admin } = api.fixture.a;
    const [watcher, taker] = [await api.as(insider), await api.as(admin)];
    // Before taking over, the send and the panel action are refused, and credit no one.
    await expect(watcher.tasks.send({ taskId: task.taskId, clientMessageId: newMessageId(), text: "let me in" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(watcher.tasks.updateBranch({ taskId: task.taskId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await coAuthorsOf(task, 1)).toEqual([CREATOR]);

    // The insider takes over and sends twice: one trailer, and the PR's independent-review check is
    // evaluated again, since a new co-author is a new driver (F-104, Q121).
    api.fakes.jobs.clear();
    await watcher.tasks.takeOver({ taskId: task.taskId });
    const sent = newMessageId();
    await watcher.tasks.send({ taskId: task.taskId, clientMessageId: sent, text: "Also cover the empty case" });
    // The steer carries them to the running box, so its next commits, the agent's and ostra's, credit the insider.
    expect(steeredCoAuthors(sent)).toMatchObject({ coAuthors: [CREATOR, await person(insider)] });
    const taskRepo = await api.test.db.taskRepo.findFirstOrThrow({ where: { taskId: task.taskId } });
    expect(api.fakes.jobs.jobs.filter((job) => job.job === "review.evaluate").map((job) => job.payload)).toEqual([
      { organizationId: world.organizationId, taskRepoId: taskRepo.id, prNumber: 7, headSha: HEAD },
    ]);
    api.fakes.jobs.clear();
    await watcher.tasks.send({ taskId: task.taskId, clientMessageId: newMessageId(), text: "And the README" });
    expect(api.fakes.jobs.jobs.filter((job) => job.job === "review.evaluate")).toEqual([]);
    expect(await coAuthorsOf(task, 1)).toEqual([CREATOR, await person(insider)]);

    // The admin takes over and presses "Update branch": a panel action's message credits them too.
    await taker.tasks.takeOver({ taskId: task.taskId });
    api.fakes.outbox.clear();
    await expect(taker.tasks.updateBranch({ taskId: task.taskId })).resolves.toMatchObject({ repos: 1, delivery: "steer" });
    const [pressed] = api.fakes.outbox.commands.filter((command) => command.kind === "steer");
    expect(pressed?.body).toMatchObject({ intent: "update-branch", coAuthors: [CREATOR, await person(insider), await person(admin)] });
    expect(await coAuthorsOf(task, 1)).toEqual([CREATOR, await person(insider), await person(admin)]);
    expect(await api.test.db.taskCoAuthor.count({ where: { taskId: task.taskId } })).toBe(3);
  });

  it("F-078/c2, F-119/c3: a member who reopens the task gets a trailer, by their no-reply address once linked, and one only, however they prompted", async () => {
    const task = await runningTask();
    const { insider } = api.fixture.a;
    // The task stopped; the insider reopens it with a message.
    await api.test.db.task.update({ where: { id: task.taskId }, data: { state: "stopped", stoppedReason: "requested" } });
    await api.test.db.session.updateMany({ where: { taskId: task.taskId }, data: { state: "stopped", endedAt: new Date() } });
    await api.test.db.lease.updateMany({ where: { taskId: task.taskId }, data: { state: "ended", endedAt: new Date(), endReason: "superseded" } });
    const reopener = await api.as(insider);
    await reopener.tasks.reopen({ taskId: task.taskId, clientMessageId: newMessageId(), text: "Add the changelog line too" });
    await lease(task, 2);
    expect(await coAuthorsOf(task, 2)).toEqual([CREATOR, await person(insider)]);

    // Linked, the trailer carries the account's no-reply address; an `@ostra` comment's row for the
    // same member (by that address) adds no second trailer.
    const user = { where: { id: insider.userId } };
    try {
      await api.test.db.user.update({ ...user, data: { githubUserId: "5522", githubLogin: "sam-insider", githubLinkedAt: new Date() } });
      await api.test.db.taskCoAuthor.create({
        data: { organizationId: world.organizationId, projectId: world.projectId, taskId: task.taskId, memberId: insider.id, name: "Sam", email: "5522+sam-insider@users.noreply.github.com" },
      });
      const { name } = await person(insider);
      expect(await coAuthorsOf(task, 2)).toEqual([CREATOR, { name, email: "5522+sam-insider@users.noreply.github.com" }]);
    } finally {
      await api.test.db.user.update({ ...user, data: { githubUserId: null, githubLogin: null, githubLinkedAt: null } });
    }
    expect(await coAuthorsOf(task, 2)).toEqual([CREATOR, await person(insider)]);
  });
});
