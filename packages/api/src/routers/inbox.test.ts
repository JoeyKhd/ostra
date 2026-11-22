import { runnerIdSchema, ticketIdSchema } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedBoard, seedConnectionAndModel, seedLinearConnection, seedProject, seedTicket } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// Ticket 29: the Inbox, tasks from tickets and "Create ticket". The cache answers every read (the
// Linear connection here has no tracker behind it at all), a ticket holds at most one active code
// task, and another organization's tickets, or a restricted project's, are invisible.

let harness: ApiHarness;
let world: Awaited<ReturnType<typeof seedConnectionAndModel>>;
let projectId: Awaited<ReturnType<typeof seedProject>>["projectId"];
let connectionId: Awaited<ReturnType<typeof seedLinearConnection>>;
let boardId: Awaited<ReturnType<typeof seedBoard>>;

const REPO = "ostra-test/test1";

beforeAll(async () => {
  harness = await createApiHarness();
  world = await seedConnectionAndModel(harness);
  projectId = (await seedProject(harness, world, "inbox")).projectId;
  connectionId = await seedLinearConnection(harness);
  boardId = await seedBoard(harness, { projectId, connectionId, key: "ENG" });
});

afterAll(async () => {
  await harness.dispose();
});

const member = () => harness.as(harness.fixture.a.member);
const admin = () => harness.as(harness.fixture.a.admin);

const T0 = Date.UTC(2026, 10, 19, 9, 0, 0);
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

/** The mapping `seedBoard` saves: open is the backlog and the todo status. */
const todo = { statusId: "s-todo", statusName: "Todo", statusCategory: "open" as const };
const progress = { statusId: "s-progress", statusName: "In Progress", statusCategory: "started" as const };
const done = { statusId: "s-done", statusName: "Done", statusCategory: "done" as const, open: false };

const keysOf = async (input: Record<string, unknown> = {}) => {
  const result = await (await member()).inbox.list({ projectId, ...input });
  return result.tickets.map((ticket) => ticket.key);
};

describe("F-010: the Inbox lists the cache", () => {
  beforeAll(async () => {
    await seedTicket(harness, { projectId, boardId, connectionId, key: "ENG-1", title: "Fix the cart total", ...todo, priority: 2, labels: ["bug", "cart"], assignee: { id: "u-1", name: "Sam Rivera" }, trackerUpdatedAt: at(10) });
    await seedTicket(harness, { projectId, boardId, connectionId, key: "ENG-2", title: "Add dark mode", ...todo, priority: null, labels: ["design"], trackerUpdatedAt: at(30) });
    await seedTicket(harness, { projectId, boardId, connectionId, key: "ENG-3", title: "Refactor billing", statusId: "s-backlog", statusName: "Backlog", statusCategory: "open", priority: 4, labels: [], trackerUpdatedAt: at(20) });
    await seedTicket(harness, { projectId, boardId, connectionId, key: "ENG-4", title: "Migrate the database", ...progress, priority: 1, labels: ["bug"], trackerUpdatedAt: at(40) });
    await seedTicket(harness, { projectId, boardId, connectionId, key: "ENG-5", title: "Ship v1", ...done, trackerUpdatedAt: at(50) });
    await seedTicket(harness, { projectId, boardId, connectionId, key: "ENG-6", title: "Gone from the board", ...todo, removedAt: at(5), trackerUpdatedAt: at(60) });
  });

  it("shows the mapped open statuses by default, newest change first, and counts them", async () => {
    const result = await (await member()).inbox.list({ projectId });
    expect(result.tickets.map((ticket) => ticket.key)).toEqual(["ENG-2", "ENG-3", "ENG-1"]);
    expect(result.total).toBe(3);
    expect(result.nextCursor).toBeNull();
    expect(result.tickets[0]).toMatchObject({
      key: "ENG-2",
      title: "Add dark mode",
      board: { name: "Engineering", key: "ENG" },
      status: { id: "s-todo", name: "Todo", category: "open" },
      priority: null,
      labels: ["design"],
      assignee: null,
      task: null,
      url: "https://linear.app/ostra-test/issue/ENG-2",
    });
    expect(result.tickets[2]).toMatchObject({ priority: 2, assignee: { id: "u-1", name: "Sam Rivera" } });
    // The cache's age: the connection and the boards, never a call to the tracker.
    expect(result.source).toMatchObject({ connection: { workspaceName: "ostra-test", state: "active", mode: "webhooks" }, stale: false });
    expect(result.source.boards).toHaveLength(1);
  });

  it("shows started and done tickets when the status filter says so, or one status by its ID", async () => {
    expect(await keysOf({ status: ["open", "started"] })).toEqual(["ENG-4", "ENG-2", "ENG-3", "ENG-1"]);
    expect(await keysOf({ status: ["done"] })).toEqual(["ENG-5"]);
    expect(await keysOf({ status: ["s-backlog"] })).toEqual(["ENG-3"]);
    expect(await keysOf({ status: ["started", "s-backlog"] })).toEqual(["ENG-4", "ENG-3"]);
  });

  it("filters by label, priority, assignee and text, alone and together", async () => {
    expect(await keysOf({ status: ["open", "started"], labels: ["bug"] })).toEqual(["ENG-4", "ENG-1"]);
    expect(await keysOf({ status: ["open", "started"], labels: ["bug", "design"] })).toEqual(["ENG-4", "ENG-2", "ENG-1"]);
    expect(await keysOf({ priorities: [2] })).toEqual(["ENG-1"]);
    expect(await keysOf({ priorities: [0] })).toEqual(["ENG-2"]);
    expect(await keysOf({ priorities: [4, 2] })).toEqual(["ENG-3", "ENG-1"]);
    expect(await keysOf({ assignees: ["u-1"] })).toEqual(["ENG-1"]);
    expect(await keysOf({ assignees: ["unassigned"] })).toEqual(["ENG-2", "ENG-3"]);
    expect(await keysOf({ text: "DARK" })).toEqual(["ENG-2"]);
    expect(await keysOf({ text: "eng-3" })).toEqual(["ENG-3"]);
    expect(await keysOf({ status: ["open", "started"], labels: ["bug"], text: "cart", priorities: [2] })).toEqual(["ENG-1"]);
    expect(await keysOf({ text: "no ticket has these words" })).toEqual([]);
  });

  it("offers the filters what the cache holds: statuses, labels and assignees", async () => {
    const filters = await (await member()).inbox.filters({ projectId });
    expect(filters.labels).toEqual(["bug", "cart", "design"]);
    expect(filters.assignees).toEqual([{ id: "u-1", name: "Sam Rivera" }]);
    expect(filters.statuses.map((status) => status.id).sort()).toEqual(["s-backlog", "s-done", "s-progress", "s-todo"]);
  });

  it("returns the cached ticket for the preview, with its images counted and its parent found", async () => {
    const parent = await seedTicket(harness, { projectId, boardId, connectionId, key: "ENG-20", title: "Epic", ...todo });
    const parentRow = await harness.test.db.ticket.findUniqueOrThrow({ where: { id: parent } });
    const child = await seedTicket(harness, {
      projectId,
      boardId,
      connectionId,
      key: "ENG-21",
      title: "Child",
      description: "See ![mockup](https://uploads.linear.app/a.png) and ![](https://uploads.linear.app/b.png)\n\nText",
      ...todo,
    });
    await harness.test.db.ticket.update({ where: { id: child }, data: { parentExternalId: parentRow.externalId } });
    const shown = await (await member()).inbox.get({ projectId, ticketId: child });
    expect(shown).toMatchObject({ key: "ENG-21", imageCount: 2, parentKey: "ENG-20", driver: null, task: null });
    expect(shown.description).toContain("Text");
    expect(shown.source.connection?.workspaceName).toBe("ostra-test");
    await expect((await member()).inbox.get({ projectId, ticketId: (await seedTicket(harness, { projectId, boardId, connectionId, key: "ENG-99", ...todo, removedAt: at(1) })) })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("F-010: paging by cursor", () => {
  it("pages newest first without a repeat or a gap, even when changes share a time", async () => {
    const paged = await seedProject(harness, world, "inbox-paged");
    const pagedBoard = await seedBoard(harness, { projectId: paged.projectId, connectionId, externalId: "team-paged", key: "PGD" });
    // Seven tickets, three of them changed at the same instant.
    for (let n = 1; n <= 7; n += 1) {
      await seedTicket(harness, { projectId: paged.projectId, boardId: pagedBoard, connectionId, key: `PGD-${String(n)}`, ...todo, trackerUpdatedAt: at(n <= 3 ? 100 : 100 + n) });
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await (await member()).inbox.list({ projectId: paged.projectId, limit: 3, ...(cursor === undefined ? {} : { cursor }) });
      expect(page.total).toBe(7);
      seen.push(...page.tickets.map((ticket) => ticket.key));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor !== undefined);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(7);
    expect(seen.slice(0, 4)).toEqual(["PGD-7", "PGD-6", "PGD-5", "PGD-4"]);

    await expect((await member()).inbox.list({ projectId: paged.projectId, cursor: "not-a-cursor" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("F-010: who sees what", () => {
  it("shows nothing of another project, another organization, or a restricted project the member isn't on", async () => {
    const { a, b } = harness.fixture;
    await expect((await harness.as(b.admin)).inbox.list({ projectId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect((await member()).inbox.list({ projectId: a.restrictedProject.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(harness.anonymous().inbox.list({ projectId })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const ticketId = ticketIdSchema.parse((await harness.test.db.ticket.findFirstOrThrow({ where: { projectId } })).id);
    await expect((await harness.as(b.admin)).inbox.get({ projectId, ticketId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Another organization's own project, with its own Linear connection, lists its own tickets only.
    const otherConnection = await seedLinearConnection(harness, { organizationId: b.organization.id });
    const otherBoard = await seedBoard(harness, { projectId: b.project.id, connectionId: otherConnection, organizationId: b.organization.id, externalId: "team-b", key: "OTH" });
    await seedTicket(harness, { projectId: b.project.id, boardId: otherBoard, connectionId: otherConnection, organizationId: b.organization.id, key: "OTH-1", ...todo });
    const theirs = await (await harness.as(b.admin)).inbox.list({ projectId: b.project.id });
    expect(theirs.tickets.map((ticket) => ticket.key)).toEqual(["OTH-1"]);
    expect((await keysOf({ status: ["open", "started", "done"] })).some((key) => key.startsWith("OTH"))).toBe(false);
  });

  it("says there is no connection or no board when there is none", async () => {
    const empty = await seedProject(harness, world, "inbox-empty");
    const result = await (await member()).inbox.list({ projectId: empty.projectId });
    expect(result).toMatchObject({ tickets: [], total: 0, nextCursor: null });
    expect(result.source.boards).toEqual([]);
    expect(result.source.connection).not.toBeNull();
  });

  it("marks the list stale while the connection can't be asked, and still lists", async () => {
    await harness.test.db.connection.update({ where: { id: connectionId }, data: { state: "failed" } });
    try {
      const result = await (await member()).inbox.list({ projectId });
      expect(result.source).toMatchObject({ stale: true, connection: { state: "failed" } });
      expect(result.tickets.length).toBeGreaterThan(0);
    } finally {
      await harness.test.db.connection.update({ where: { id: connectionId }, data: { state: "active" } });
    }
  });
});

describe("F-010: the sidebar's Inbox count", () => {
  it("counts the open tickets of the default filter per project, in one list", async () => {
    const list = await (await member()).projects.list();
    const mine = list.find((project) => project.id === projectId);
    expect(mine?.inboxCount).toBe(5);
    // A project without boards counts none; the other organization's tickets never count here.
    expect(list.find((project) => project.slug === "inbox-empty")?.inboxCount).toBe(0);
    expect(list.find((project) => project.slug === "inbox-paged")?.inboxCount).toBe(7);
    await expect((await member()).projects.get({ projectId })).resolves.toMatchObject({ inboxCount: 5 });
  });
});

describe("F-010, F-097: starting a task from a ticket", () => {
  const ticketNamed = async (key: string, over: Record<string, unknown> = {}) =>
    seedTicket(harness, { projectId, boardId, connectionId, key, title: `Work on ${key}`, ...todo, ...over });

  it("creates a code task on the ticket, with its branch, repos, session, started writes and the job that reads its context", async () => {
    const ticketId = await ticketNamed("ENG-30", { title: "Add the CSV export" });
    harness.fakes.jobs.clear();
    const started = await (await member()).tasks.startFromTicket({ projectId, ticketId });

    const task = await harness.test.db.task.findUniqueOrThrow({ where: { id: started.taskId }, include: { repos: true, sessions: true, coAuthors: true } });
    expect(task).toMatchObject({
      kind: "code",
      source: "ticket",
      state: "queued",
      ticketId,
      boardId,
      ticketKey: "ENG-30",
      title: "Add the CSV export",
      prompt: null,
      driverMemberId: harness.fixture.a.member.id,
      creatorMemberId: harness.fixture.a.member.id,
    });
    expect(started.branchName).toBe(`ostra/eng-30-${started.taskId.replaceAll("-", "").slice(-8)}-add-the-csv-export`);
    expect(task.branchName).toBe(started.branchName);
    expect(task.repos.map((repo) => [repo.branchName, repo.baseBranch])).toEqual([[started.branchName, "main"]]);
    expect(task.sessions).toHaveLength(1);
    expect(task.sessions[0]).toMatchObject({ id: started.sessionId, origin: "new", state: "starting" });
    expect(task.coAuthors).toHaveLength(1);

    // The ticket's "started" writes: the move, one comment with the task's link, a link attachment.
    const writes = await harness.test.db.ticketWrite.findMany({ where: { taskId: started.taskId }, orderBy: { createdAt: "asc" } });
    expect(writes.map((write) => [write.kind, write.state, write.ticketId, write.boardId])).toEqual([
      ["move", "pending", ticketId, boardId],
      ["comment", "pending", ticketId, boardId],
      ["link_task", "pending", ticketId, boardId],
    ]);
    expect(writes.map((write) => write.idempotencyKey)).toEqual([
      `ticket-write:${started.taskId}:move:started`,
      `ticket-write:${started.taskId}:comment`,
      `ticket-write:${started.taskId}:link-task`,
    ]);
    const taskUrl = `http://localhost:3000/tasks/${started.taskId}`;
    expect(writes[1]?.payload).toEqual({ kind: "comment", markdown: `ostra is working on this: ${taskUrl}` });
    expect(writes[2]?.payload).toMatchObject({ kind: "link_task", url: taskUrl });

    const jobs = harness.fakes.jobs.jobs;
    expect(jobs.filter((job) => job.job === "ticket.sync")).toHaveLength(3);
    expect(jobs.filter((job) => job.job === "ticket.sync").every((job) => job.options?.group?.id === connectionId)).toBe(true);
    const fetches = jobs.filter((job) => job.job === "ticket.fetch-context");
    expect(fetches).toHaveLength(1);
    expect(fetches[0]).toMatchObject({ key: `task:${started.taskId}:fetch-context:${started.sessionId}`, payload: { taskId: started.taskId, sessionId: started.sessionId } });
    // The dispatch comes after the context is read, not before.
    expect(jobs.filter((job) => job.job === "task.dispatch")).toEqual([]);

    // The Inbox shows the task at once.
    const listed = (await (await member()).inbox.list({ projectId, status: ["open"], text: "ENG-30" })).tickets[0];
    expect(listed?.task).toMatchObject({ id: started.taskId, state: "queued", active: true, shortId: started.taskId.replaceAll("-", "").slice(-8) });
    const shown = await (await member()).inbox.get({ projectId, ticketId });
    expect(shown.driver).toMatchObject({ memberId: harness.fixture.a.member.id });
    expect((await harness.test.db.auditEntry.findFirst({ where: { action: "task.created", entityId: started.taskId } }))?.data).toMatchObject({ source: "ticket" });
  });

  it("F-007/c3: refuses a second active task for the ticket and names the first, even when two members start at once", async () => {
    const ticketId = await ticketNamed("ENG-31");
    const [first, second] = await Promise.allSettled([
      (await member()).tasks.startFromTicket({ projectId, ticketId }),
      (await admin()).tasks.startFromTicket({ projectId, ticketId }),
    ]);
    const outcomes = [first, second];
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const refused = outcomes.find((outcome) => outcome.status === "rejected");
    const winner = outcomes.find((outcome) => outcome.status === "fulfilled");
    if (refused?.status !== "rejected" || winner?.status !== "fulfilled") throw new Error("expected one start to win");
    const reason: unknown = refused.reason;
    expect(reason).toMatchObject({ code: "CONFLICT" });
    expect(reason instanceof Error ? reason.message : "").toContain(winner.value.taskId);
    expect(await harness.test.db.task.count({ where: { ticketId, kind: "code" } })).toBe(1);
    // Again, later: the same refusal.
    await expect((await member()).tasks.startFromTicket({ projectId, ticketId })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("F-007/c3: the rule is per project: the same tracker issue on another project's board gets that project's own active task, and one only", async () => {
    const ticketId = await ticketNamed("ENG-36");
    const here = await harness.test.db.ticket.findUniqueOrThrow({ where: { id: ticketId } });
    // The team is a board of a second project too: the issue is cached there as that board's ticket.
    const other = await seedProject(harness, world, "inbox-other");
    const otherBoard = await seedBoard(harness, { projectId: other.projectId, connectionId, key: "ENG" });
    const there = ticketIdSchema.parse(
      (
        await harness.test.db.ticket.create({
          data: {
            organizationId: here.organizationId,
            projectId: other.projectId,
            boardId: otherBoard,
            connectionId: here.connectionId,
            externalId: here.externalId,
            key: here.key,
            title: here.title,
            statusId: here.statusId,
            statusName: here.statusName,
            statusCategory: here.statusCategory,
            url: here.url,
            trackerUpdatedAt: here.trackerUpdatedAt,
          },
          select: { id: true },
        })
      ).id,
    );
    const first = await (await member()).tasks.startFromTicket({ projectId, ticketId });
    const second = await (await member()).tasks.startFromTicket({ projectId: other.projectId, ticketId: there });
    expect(second.taskId).not.toBe(first.taskId);
    expect(await harness.test.db.task.findMany({ where: { id: { in: [first.taskId, second.taskId] } }, select: { projectId: true }, orderBy: { createdAt: "asc" } })).toEqual([
      { projectId },
      { projectId: other.projectId },
    ]);
    // In each project a second start is refused, and names that project's task.
    for (const [project, ticket, holder] of [
      [projectId, ticketId, first.taskId],
      [other.projectId, there, second.taskId],
    ] as const) {
      const refusal = await (await admin()).tasks.startFromTicket({ projectId: project, ticketId: ticket }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refusal).toMatchObject({ code: "CONFLICT" });
      expect(refusal instanceof Error ? refusal.message : "").toContain(holder);
    }
    expect(await harness.test.db.task.count({ where: { ticket: { externalId: here.externalId }, kind: "code", state: { notIn: ["stopped", "merged", "done"] } } })).toBe(2);
  });

  it("lets a stopped task's ticket start again, and shows the earlier task meanwhile", async () => {
    const ticketId = await ticketNamed("ENG-32");
    const first = await (await member()).tasks.startFromTicket({ projectId, ticketId });
    await (await member()).tasks.stop({ taskId: first.taskId });
    const earlier = (await (await member()).inbox.list({ projectId, text: "ENG-32" })).tickets[0];
    expect(earlier?.task).toMatchObject({ id: first.taskId, state: "stopped", active: false });
    const second = await (await member()).tasks.startFromTicket({ projectId, ticketId });
    expect(second.taskId).not.toBe(first.taskId);
    const now = (await (await member()).inbox.list({ projectId, text: "ENG-32" })).tickets[0];
    expect(now?.task).toMatchObject({ id: second.taskId, active: true });
  });

  it("refuses a detached board's ticket, a removed ticket, and tickets of other projects and organizations", async () => {
    const detached = await seedProject(harness, world, "inbox-detached");
    const detachedBoard = await seedBoard(harness, { projectId: detached.projectId, connectionId, externalId: "team-det", key: "DET" });
    const stale = await seedTicket(harness, { projectId: detached.projectId, boardId: detachedBoard, connectionId, key: "DET-1", ...todo });
    await harness.test.db.board.update({ where: { id: detachedBoard }, data: { detachedAt: new Date() } });
    await expect((await member()).tasks.startFromTicket({ projectId: detached.projectId, ticketId: stale })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const removed = await ticketNamed("ENG-33", { removedAt: at(1) });
    await expect((await member()).tasks.startFromTicket({ projectId, ticketId: removed })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const live = await ticketNamed("ENG-34");
    await expect((await member()).tasks.startFromTicket({ projectId: detached.projectId, ticketId: live })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect((await harness.as(harness.fixture.b.admin)).tasks.startFromTicket({ projectId, ticketId: live })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect((await member()).tasks.startFromTicket({ projectId: harness.fixture.a.restrictedProject.id, ticketId: live })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await harness.test.db.task.count({ where: { ticketId: live } })).toBe(0);
  });

  it("refuses a repo that requires signed commits, as a prompt task does, and never on unknown", async () => {
    const ticketId = await ticketNamed("ENG-35");
    harness.fakes.codeHost.branchRules.set(REPO, { protected: true, requiresSignedCommits: true, reasons: [] });
    try {
      const refusal = await (await member()).tasks.startFromTicket({ projectId, ticketId }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refusal).toMatchObject({ code: "PRECONDITION_FAILED" });
      expect(String(Reflect.get(refusal ?? {}, "message"))).toContain("signed commits");
      expect(await harness.test.db.task.count({ where: { ticketId } })).toBe(0);
      harness.fakes.codeHost.branchRules.set(REPO, { protected: "unknown", requiresSignedCommits: "unknown", reasons: ["rules-refused"] });
      expect((await (await member()).tasks.startFromTicket({ projectId, ticketId })).taskId).toBeTruthy();
    } finally {
      harness.fakes.codeHost.branchRules.clear();
    }
  });

  it("needs a model on the project's profile, and keeps the personal runner rules of a prompt task", async () => {
    const { a } = harness.fixture;
    const ticketId = await ticketNamed("ENG-36");
    const theirs = await harness.test.db.runner.create({
      data: { organizationId: a.organization.id, kind: "personal", ownerMemberId: a.admin.id, name: "not mine", publicKey: "n".repeat(43), executor: "host", capacity: 1, version: "0.0.0", state: "online" },
    });
    await expect((await member()).tasks.startFromTicket({ projectId, ticketId, runnerId: runnerIdSchema.parse(theirs.id) })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await harness.test.db.agentProfile.updateMany({ where: { organizationId: a.organization.id, builtIn: true }, data: { modelId: null, modelCatalogId: null, modelCustomName: null, providerId: null } });
    try {
      await expect((await member()).tasks.startFromTicket({ projectId, ticketId })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    } finally {
      await (await admin()).agentProfiles.setDefaultModel({ modelId: world.modelId });
    }
  });
});

describe("F-097: Create ticket", () => {
  it("writes the create write for a prompt task, once, and links nothing until ticket sync has made the ticket", async () => {
    const promptTask = await (await member()).tasks.create({ projectId, prompt: "Please add pagination to the users table\nIt should keep the filters." });
    harness.fakes.jobs.clear();
    const made = await (await member()).tasks.createTicket({ taskId: promptTask.taskId, boardId });
    const write = await harness.test.db.ticketWrite.findUniqueOrThrow({ where: { id: made.ticketWriteId } });
    expect(write).toMatchObject({ kind: "create", state: "pending", ticketId: null, boardId, taskId: promptTask.taskId, idempotencyKey: `ticket-write:${promptTask.taskId}:create` });
    expect(write.payload).toEqual({
      kind: "create",
      title: "Please add pagination to the users table",
      description: "Please add pagination to the users table\nIt should keep the filters.",
    });
    expect(harness.fakes.jobs.jobs.filter((job) => job.job === "ticket.sync")).toHaveLength(1);
    // Asking again is refused, and nothing doubles.
    await expect((await member()).tasks.createTicket({ taskId: promptTask.taskId, boardId })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await harness.test.db.ticketWrite.count({ where: { taskId: promptTask.taskId } })).toBe(1);
    // The task is still a prompt task until the write is applied.
    expect(await harness.test.db.task.findUniqueOrThrow({ where: { id: promptTask.taskId } })).toMatchObject({ ticketId: null, source: "prompt" });
  });

  it("is refused once the task holds a ticket, for a ticket task, for another project's board and for outsiders", async () => {
    const promptTask = await (await member()).tasks.create({ projectId, prompt: "Another prompt" });
    const ticketId = await seedTicket(harness, { projectId, boardId, connectionId, key: "ENG-40", ...todo });
    await harness.test.db.task.update({ where: { id: promptTask.taskId }, data: { ticketId, boardId, ticketKey: "ENG-40" } });
    await expect((await member()).tasks.createTicket({ taskId: promptTask.taskId, boardId })).rejects.toMatchObject({ code: "CONFLICT" });

    const fromTicket = await (await member()).tasks.startFromTicket({ projectId, ticketId: await seedTicket(harness, { projectId, boardId, connectionId, key: "ENG-41", ...todo }) });
    await expect((await member()).tasks.createTicket({ taskId: fromTicket.taskId, boardId })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const fresh = await (await member()).tasks.create({ projectId, prompt: "A third prompt" });
    const otherProject = await seedProject(harness, world, "inbox-create-other");
    const otherBoard = await seedBoard(harness, { projectId: otherProject.projectId, connectionId, externalId: "team-other", key: "OTR" });
    await expect((await member()).tasks.createTicket({ taskId: fresh.taskId, boardId: otherBoard })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect((await harness.as(harness.fixture.b.admin)).tasks.createTicket({ taskId: fresh.taskId, boardId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await harness.test.db.ticketWrite.count({ where: { taskId: fresh.taskId } })).toBe(0);
  });
});
