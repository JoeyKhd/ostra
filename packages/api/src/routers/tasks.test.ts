import { jobKey } from "@ostra/domain";
import { approvalIdSchema, clientMessageIdSchema, memberIdSchema, optionIdSchema, questionIdSchema, segmentIdSchema, toolCallIdSchema, turnIdSchema } from "@ostra/protocol";
import type { ProjectId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appendEvent, createApiHarness, seedConnectionAndModel, seedLease, seedPersonalRunner, seedProject, seedTask, trpcFailure } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// Ticket 33: the tasks router. A task is visible to every member of its project and to nobody
// else; the driver is the only one who may send; the first answer to an approval wins.

let harness: ApiHarness;
let projectId: ProjectId;
let world: Awaited<ReturnType<typeof seedConnectionAndModel>>;

beforeAll(async () => {
  harness = await createApiHarness();
  world = await seedConnectionAndModel(harness);
  projectId = (await seedProject(harness, world, "calc")).projectId;
});

afterAll(async () => {
  await harness.dispose();
});

const orgA = () => harness.fixture.a.organization.id;
const uuid = (label: string) => `${label}-${crypto.randomUUID()}`;

describe("tasks.create (F-097)", () => {
  it("F-030, F-078, F-097: starts a code task from a prompt, in one transaction, with no ticket", async () => {
    const { a } = harness.fixture;
    const prompt = "Add a short CONTRIBUTING.md that explains how to run the tests\nUse the repo's own words.";
    const created = await (await harness.as(a.member)).tasks.create({ projectId, prompt });

    expect(created.branchName).toMatch(/^ostra\/[0-9a-f]{8}-add-a-short-contributing-md-that-explain$/);
    // The ID part is the UUID's random tail: two tasks made in the same minute get different branches.
    expect(created.branchName.startsWith(`ostra/${created.taskId.replaceAll("-", "").slice(-8)}-`)).toBe(true);

    const task = await harness.test.db.task.findUniqueOrThrow({ where: { id: created.taskId }, include: { repos: true, coAuthors: true, sessions: true } });
    expect(task).toMatchObject({
      organizationId: a.organization.id,
      projectId,
      kind: "code",
      source: "prompt",
      state: "queued",
      title: "Add a short CONTRIBUTING.md that explains how to run the tests",
      prompt,
      ticketKey: null,
      driverMemberId: a.member.id,
      creatorMemberId: a.member.id,
      runnerId: null,
      branchName: created.branchName,
      eventSeq: 1,
    });
    expect(task.repos).toMatchObject([{ branchName: created.branchName, baseBranch: "main", state: "no_branch" }]);
    expect(task.sessions).toMatchObject([{ id: created.sessionId, origin: "new", state: "starting" }]);
    // The member is the co-author, with their ostra name and email (F-078, spec section 11, item 4).
    const account = await harness.test.db.user.findUniqueOrThrow({ where: { id: a.member.userId } });
    expect(task.coAuthors).toMatchObject([{ memberId: a.member.id, name: account.name, email: account.email }]);

    // The prompt is the log's first event.
    const first = await harness.test.db.event.findUniqueOrThrow({ where: { taskId_seq: { taskId: created.taskId, seq: 1 } } });
    expect(first).toMatchObject({ kind: "user.message", sessionId: created.sessionId, sessionSeq: null });
    expect(first.payload).toMatchObject({ kind: "user.message", memberId: a.member.id, text: prompt, delivery: "immediate" });

    // The dispatch job, keyed by what it does (ADR 0037), a change notice and an audit entry.
    expect(harness.fakes.jobs.jobs).toContainEqual(
      expect.objectContaining({
        job: "task.dispatch",
        key: jobKey("task.dispatch", { organizationId: a.organization.id, taskId: created.taskId, sessionId: created.sessionId, leaseEpoch: 1 }),
      }),
    );
    expect(await harness.test.db.changeNotice.count({ where: { entity: "task", entityId: created.taskId } })).toBe(1);
    expect(await harness.test.db.auditEntry.count({ where: { action: "task.created", entityId: created.taskId } })).toBe(1);
    // The audit trail holds no prompt text.
    expect(JSON.stringify(await harness.test.db.auditEntry.findMany())).not.toContain("CONTRIBUTING");
    expect(JSON.stringify(harness.logs)).not.toContain("CONTRIBUTING");
  });

  it("F-097: a prompt task in a project with a tracker board makes no ticket and writes nothing to the tracker", async () => {
    const { a } = harness.fixture;
    const tracked = (await seedProject(harness, world, "tracked")).projectId;
    const connection = await harness.test.db.connection.create({ data: { organizationId: orgA(), kind: "linear", appId: "linear-app-test" } });
    await harness.test.db.board.create({
      data: { organizationId: orgA(), projectId: tracked, connectionId: connection.id, externalId: "team-1", name: "Engineering", statusMap: {}, key: "ENG" },
    });
    const tickets = await harness.test.db.ticket.count();
    const writes = await harness.test.db.ticketWrite.count();

    const created = await (await harness.as(a.member)).tasks.create({ projectId: tracked, prompt: "Fix the flaky test in calc.test.ts" });
    expect(await harness.test.db.task.findUniqueOrThrow({ where: { id: created.taskId } })).toMatchObject({
      source: "prompt",
      state: "queued",
      ticketKey: null,
      ticketId: null,
      boardId: null,
    });
    expect(await harness.test.db.ticket.count()).toBe(tickets);
    expect(await harness.test.db.ticketWrite.count()).toBe(writes);
    expect(harness.fakes.jobs.jobs.filter((job) => job.job.startsWith("ticket."))).toEqual([]);
  });

  it("F-019: a prompt task runs on the default agent: the organization's built-in OpenCode profile, which the project starts with", async () => {
    const created = await (await harness.as(harness.fixture.a.member)).tasks.create({ projectId, prompt: "which agent runs me" });
    const session = await harness.test.db.session.findUniqueOrThrow({ where: { id: created.sessionId } });
    const profile = await harness.test.db.agentProfile.findUniqueOrThrow({ where: { id: session.agentProfileId ?? "none" } });
    expect(profile).toMatchObject({ organizationId: orgA(), adapter: "opencode", builtIn: true, name: "OpenCode" });
    expect((await harness.test.db.project.findUniqueOrThrow({ where: { id: projectId } })).defaultCodeProfileId).toBe(profile.id);
  });

  it("takes the title from the member when given, and refuses an empty prompt", async () => {
    const member = await harness.as(harness.fixture.a.member);
    const created = await member.tasks.create({ projectId, prompt: "do the thing", title: "My title" });
    expect((await harness.test.db.task.findUniqueOrThrow({ where: { id: created.taskId } })).title).toBe("My title");
    await expect(member.tasks.create({ projectId, prompt: "   " })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("is for members of the project: another organization, and a restricted project's outsiders, get NOT_FOUND", async () => {
    const { a, b } = harness.fixture;
    await expect((await harness.as(b.admin)).tasks.create({ projectId, prompt: "hello" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect((await harness.as(a.member)).tasks.create({ projectId: a.restrictedProject.id, prompt: "hello" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(harness.anonymous().tasks.create({ projectId, prompt: "hello" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("needs a model on the project's profile, and says what to do", async () => {
    const { a } = harness.fixture;
    await harness.test.db.agentProfile.updateMany({ where: { organizationId: a.organization.id, builtIn: true }, data: { modelId: null } });
    try {
      const refusal = await trpcFailure((await harness.as(a.member)).tasks.create({ projectId, prompt: "hello" }));
      expect(refusal.code).toBe("PRECONDITION_FAILED");
      expect(refusal.message).toContain("Models");
    } finally {
      await (await harness.as(a.admin)).agentProfiles.setDefaultModel({ modelId: world.modelId });
    }
  });

  it("runs on the member's own personal runner only when the provider allows it, and never on someone else's", async () => {
    const { a } = harness.fixture;
    const mine = await seedPersonalRunner(harness, a.member.id, "laptop");
    const theirs = await seedPersonalRunner(harness, a.admin.id, "admin laptop");
    const member = await harness.as(a.member);

    // Off by default (Q47).
    await expect(member.tasks.create({ projectId, prompt: "hi", runnerId: mine })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await (await harness.as(a.admin)).providers.update({ providerId: world.providerId, allowOnPersonalRunners: true });

    const created = await member.tasks.create({ projectId, prompt: "hi", runnerId: mine });
    expect((await harness.test.db.task.findUniqueOrThrow({ where: { id: created.taskId } })).runnerId).toBe(mine);
    await expect(member.tasks.create({ projectId, prompt: "hi", runnerId: theirs })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The picker shows only the member's own.
    expect((await member.runners.mine()).map((runner) => runner.name)).toEqual(["laptop"]);
    expect(await member.runners.mine()).toMatchObject([{ kind: "personal", executor: "host", isolated: false, state: "online" }]);
  });
});

describe("tasks.list and tasks.get", () => {
  it("groups a project's tasks in the order of the domain model, with what the agent is doing and where", async () => {
    const { a } = harness.fixture;
    const project = (await seedProject(harness, world, "grouped")).projectId;
    const place = { organizationId: orgA(), projectId: project };
    const runnerId = await seedPersonalRunner(harness, a.member.id, "grouped-laptop");
    await seedTask(harness, { ...place, title: "queued one", state: "queued", sessionState: "starting" });
    const running = await seedTask(harness, { ...place, title: "running one", state: "running", driverMemberId: a.member.id });
    await seedLease(harness, running, orgA(), project, runnerId);
    await seedTask(harness, { ...place, title: "waiting one", state: "needs_you", sessionState: "waiting" });
    await seedTask(harness, { ...place, title: "review one", state: "in_review", sessionState: "ended" });
    await seedTask(harness, { ...place, title: "stopped one", state: "stopped", sessionState: "ended" });
    await appendEvent(harness, running, place, { kind: "turn.started", turnId: turnIdSchema.parse("turn-1") });
    await appendEvent(harness, running, place, {
      kind: "tool.called",
      turnId: turnIdSchema.parse("turn-1"),
      toolCallId: toolCallIdSchema.parse("tool-1"),
      toolKind: "edit",
      title: "Edit CONTRIBUTING.md",
      input: {},
    });
    await appendEvent(harness, running, place, { kind: "agent.thought", turnId: turnIdSchema.parse("turn-1"), segmentId: segmentIdSchema.parse("seg-1"), text: "thinking" });

    const groups = await (await harness.as(a.insider)).tasks.list({ projectId: project });
    expect(groups.map((group) => group.group)).toEqual(["needs-you", "running", "queued", "in-review", "finished"]);
    const titles = Object.fromEntries(groups.map((group) => [group.group, group.tasks.map((task) => task.title)]));
    expect(titles).toEqual({
      "needs-you": ["waiting one"],
      running: ["running one"],
      queued: ["queued one"],
      "in-review": ["review one"],
      finished: ["stopped one"],
    });
    const runningRow = groups.find((group) => group.group === "running")?.tasks[0];
    expect(runningRow).toMatchObject({
      key: running.taskId.replaceAll("-", "").slice(-8),
      state: "running",
      // The newest of the events the list words: the agent's thought, after the tool call.
      doing: { kind: "agent.thought", detail: null },
      runner: { name: "grouped-laptop", kind: "personal", executor: "host", isolated: false },
    });
    expect(runningRow?.driver?.name).toEqual(expect.any(String));
    expect(groups.find((group) => group.group === "needs-you")?.tasks[0]).toMatchObject({ reason: "question" });
    expect(groups.find((group) => group.group === "finished")?.tasks[0]).toMatchObject({ reason: "requested" });
  });

  it("shows a tool call's title as what the agent is doing", async () => {
    const project = (await seedProject(harness, world, "doing")).projectId;
    const place = { organizationId: orgA(), projectId: project };
    const task = await seedTask(harness, { ...place, state: "running" });
    await appendEvent(harness, task, place, {
      kind: "tool.called",
      turnId: turnIdSchema.parse("turn-1"),
      toolCallId: toolCallIdSchema.parse("tool-1"),
      toolKind: "execute",
      title: "x".repeat(500),
      input: {},
    });
    const row = (await (await harness.as(harness.fixture.a.member)).tasks.list({ projectId: project })).flatMap((group) => group.tasks)[0];
    expect(row?.doing?.kind).toBe("tool.called");
    expect(row?.doing?.detail?.length).toBe(160);
  });

  it("names the path an edit works on, the command an approval asks about, and the question asked", async () => {
    const project = (await seedProject(harness, world, "detail")).projectId;
    const place = { organizationId: orgA(), projectId: project };
    const turnId = turnIdSchema.parse("turn-1");
    const editing = await seedTask(harness, { ...place, title: "editing", state: "running" });
    await appendEvent(harness, editing, place, {
      kind: "tool.called",
      turnId,
      toolCallId: toolCallIdSchema.parse("tool-edit"),
      toolKind: "edit",
      title: "edit",
      input: { paths: ["src/display/format.ts"] },
    });
    const approving = await seedTask(harness, { ...place, title: "approving", state: "needs_you", sessionState: "waiting" });
    await appendEvent(harness, approving, place, {
      kind: "tool.called",
      turnId,
      toolCallId: toolCallIdSchema.parse("tool-migrate"),
      toolKind: "execute",
      title: "pnpm db:migrate",
      input: {},
    });
    await appendEvent(harness, approving, place, {
      kind: "approval.requested",
      turnId,
      approvalId: approvalIdSchema.parse("approval-1"),
      toolCallId: toolCallIdSchema.parse("tool-migrate"),
      options: [{ optionId: optionIdSchema.parse("allow"), label: "Allow once", kind: "allow-once", decision: "allow_once" }],
    });
    const asking = await seedTask(harness, { ...place, title: "asking", state: "needs_you", sessionState: "waiting" });
    await appendEvent(harness, asking, place, { kind: "question.asked", turnId, questionId: questionIdSchema.parse("q-1"), message: "Keep the old retry header?", fields: [] });

    const rows = (await (await harness.as(harness.fixture.a.member)).tasks.list({ projectId: project })).flatMap((group) => group.tasks);
    const doingOf = (title: string) => rows.find((row) => row.title === title)?.doing;
    expect(doingOf("editing")).toEqual({ kind: "tool.called", detail: "src/display/format.ts", toolKind: "edit" });
    expect(doingOf("approving")).toEqual({ kind: "approval.requested", detail: "pnpm db:migrate", toolKind: "execute" });
    expect(doingOf("asking")).toEqual({ kind: "question.asked", detail: "Keep the old retry header?", toolKind: null });
  });

  it("is visible to another member of the project and invisible to another organization", async () => {
    const { a, b } = harness.fixture;
    const created = await (await harness.as(a.member)).tasks.create({ projectId, prompt: "visible to the team" });
    // Another member of the project reads it, and its capabilities say they are not the driver.
    const seen = await (await harness.as(a.insider)).tasks.get({ taskId: created.taskId });
    expect(seen).toMatchObject({ id: created.taskId, state: "queued", driver: { memberId: a.member.id }, capabilities: { send: false, takeOver: true, stop: true } });
    expect((await (await harness.as(a.member)).tasks.get({ taskId: created.taskId })).capabilities.takeOver).toBe(false);
    // The agent and model it runs with: the session's profile, named for the panel.
    expect(seen.agent).toMatchObject({ name: "OpenCode", adapter: "opencode", agentName: "OpenCode", model: { id: world.modelId, name: "World model" } });
    // Another organization's member and its admin get NOT_FOUND, and its list is empty.
    await expect((await harness.as(b.admin)).tasks.get({ taskId: created.taskId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect((await harness.as(b.admin)).tasks.history({ taskId: created.taskId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect((await harness.as(b.admin)).tasks.list({ projectId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("hides a restricted project's tasks from a member who isn't on it", async () => {
    const { a } = harness.fixture;
    const place = { organizationId: orgA(), projectId: a.restrictedProject.id };
    const task = await seedTask(harness, place);
    await expect((await harness.as(a.member)).tasks.get({ taskId: task.taskId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect((await harness.as(a.member)).tasks.stop({ taskId: task.taskId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await (await harness.as(a.insider)).tasks.get({ taskId: task.taskId })).id).toBe(task.taskId);
  });
});

describe("tasks.history pages by turn, newest first (ADR 0036)", () => {
  it("returns the newest 20 turns, then the 20 before them, then the start of the log", async () => {
    const project = (await seedProject(harness, world, "history")).projectId;
    const place = { organizationId: orgA(), projectId: project };
    const task = await seedTask(harness, place);
    // A prompt before any turn, then 45 turns of three events each.
    await appendEvent(harness, task, place, { kind: "user.message", memberId: harness.fixture.a.member.id, clientMessageId: clientMessageIdSchema.parse(uuid("m")), text: "go", delivery: "immediate" });
    const turnStarts: number[] = [];
    for (let turn = 1; turn <= 45; turn += 1) {
      const turnId = turnIdSchema.parse(`turn-${String(turn)}`);
      const startSeq = await appendEvent(harness, task, place, { kind: "turn.started", turnId });
      turnStarts.push(startSeq);
      await harness.test.db.turn.create({ data: { organizationId: orgA(), projectId: project, taskId: task.taskId, sessionId: task.sessionId, ordinal: turn, startSeq } });
      await appendEvent(harness, task, place, { kind: "agent.message", turnId, segmentId: segmentIdSchema.parse(`seg-${String(turn)}`), text: `turn ${String(turn)}` });
      await appendEvent(harness, task, place, { kind: "turn.ended", turnId, stopReason: "end_turn" });
    }
    const member = await harness.as(harness.fixture.a.member);

    const newest = await member.tasks.history({ taskId: task.taskId });
    // 20 turns of 3 events, the newest first page, in order, ending at the log's head.
    expect(newest.events).toHaveLength(60);
    expect(newest.events[0]?.seq).toBe(turnStarts[25]);
    expect(newest.events.at(-1)?.seq).toBe(newest.headSeq);
    expect(newest.events.map((event) => event.seq)).toEqual([...newest.events.map((event) => event.seq)].sort((x, y) => x - y));
    expect(newest.nextBeforeSeq).toBe(turnStarts[25]);

    const middle = await member.tasks.history({ taskId: task.taskId, beforeSeq: newest.nextBeforeSeq ?? 0 });
    expect(middle.events).toHaveLength(60);
    expect(middle.events[0]?.seq).toBe(turnStarts[5]);
    expect(middle.events.at(-1)?.seq).toBe((newest.nextBeforeSeq ?? 0) - 1);
    expect(middle.headSeq).toBeNull();
    expect(middle.nextBeforeSeq).toBe(turnStarts[5]);

    // The oldest page has the five first turns and what came before the first (the prompt).
    const oldest = await member.tasks.history({ taskId: task.taskId, beforeSeq: middle.nextBeforeSeq ?? 0 });
    expect(oldest.events).toHaveLength(1 + 15);
    expect(oldest.events[0]?.event.kind).toBe("user.message");
    expect(oldest.nextBeforeSeq).toBeNull();

    // No seq twice, none missing, across the three pages.
    const all = [...oldest.events, ...middle.events, ...newest.events].map((event) => event.seq);
    expect(all).toEqual(Array.from({ length: 1 + 45 * 3 }, (_, index) => index + 1));
  });

  it("returns a task with no turn yet whole, and an unknown event kind as unsupported", async () => {
    const project = (await seedProject(harness, world, "no-turns")).projectId;
    const place = { organizationId: orgA(), projectId: project };
    const task = await seedTask(harness, place);
    await appendEvent(harness, task, place, { kind: "environment.setup_started" });
    await harness.test.db.event.create({
      data: { organizationId: orgA(), projectId: project, taskId: task.taskId, seq: 2, sessionId: task.sessionId, sessionSeq: 2, kind: "from.the.future", payload: { kind: "from.the.future", x: 1 }, occurredAt: new Date() },
    });
    const page = await (await harness.as(harness.fixture.a.member)).tasks.history({ taskId: task.taskId });
    expect(page.events.map((event) => event.event.kind)).toEqual(["environment.setup_started", "unsupported"]);
    expect(page.nextBeforeSeq).toBeNull();
  });
});

describe("tasks.stop (F-025)", () => {
  it("F-025: stops a task that is running: any member of the project, a stop command for the runner holding its lease", async () => {
    const { a } = harness.fixture;
    const project = (await seedProject(harness, world, "stopping")).projectId;
    const place = { organizationId: orgA(), projectId: project };
    const runnerId = await seedPersonalRunner(harness, a.admin.id, "stop-runner");
    const task = await seedTask(harness, { ...place, state: "running", driverMemberId: a.admin.id });
    // An earlier lease of another runner, ended (its offer timed out): the stop isn't for it.
    const earlier = await seedPersonalRunner(harness, a.admin.id, "earlier-runner");
    await seedLease(harness, task, orgA(), project, earlier, 2);
    await harness.test.db.lease.updateMany({ where: { taskId: task.taskId, epoch: 2 }, data: { state: "ended", endReason: "offer-timeout", endedAt: new Date() } });
    await seedLease(harness, task, orgA(), project, runnerId, 3);
    harness.fakes.outbox.clear();

    // Not the driver, only a member of the project: still allowed.
    await expect((await harness.as(a.insider)).tasks.stop({ taskId: task.taskId })).resolves.toEqual({ stopped: true });
    const row = await harness.test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
    expect(row).toMatchObject({ state: "stopped", stoppedReason: "requested" });
    expect(harness.fakes.outbox.commands).toMatchObject([
      { runnerId, kind: "stop", body: { taskId: task.taskId, sessionId: task.sessionId, leaseEpoch: 3, reason: "requested" } },
    ]);
    expect(await harness.test.db.auditEntry.count({ where: { action: "task.stopped", entityId: task.taskId } })).toBe(1);
    expect(await harness.test.db.changeNotice.count({ where: { entity: "task", entityId: task.taskId } })).toBeGreaterThan(0);
    // Stopping twice says so, and queues no second command.
    await expect((await harness.as(a.member)).tasks.stop({ taskId: task.taskId })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(harness.fakes.outbox.commands).toHaveLength(1);
  });

  it("stops a task nobody has taken yet without a command, and ends its session", async () => {
    const { a } = harness.fixture;
    const created = await (await harness.as(a.member)).tasks.create({ projectId, prompt: "never started" });
    harness.fakes.outbox.clear();
    await (await harness.as(a.member)).tasks.stop({ taskId: created.taskId });
    expect(harness.fakes.outbox.commands).toHaveLength(0);
    expect(await harness.test.db.task.findUniqueOrThrow({ where: { id: created.taskId } })).toMatchObject({ state: "stopped", stoppedReason: "requested" });
    expect((await harness.test.db.session.findUniqueOrThrow({ where: { id: created.sessionId } })).state).toBe("stopped");
  });

  it("is invisible to another organization", async () => {
    const created = await (await harness.as(harness.fixture.a.member)).tasks.create({ projectId, prompt: "mine" });
    await expect((await harness.as(harness.fixture.b.admin)).tasks.stop({ taskId: created.taskId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await harness.test.db.task.findUniqueOrThrow({ where: { id: created.taskId } })).state).toBe("queued");
  });
});

describe("the one-driver rule: tasks.send, tasks.interrupt, tasks.takeOver (ADR 0036)", () => {
  const prepare = async (slug: string) => {
    const { a } = harness.fixture;
    const project = (await seedProject(harness, world, slug)).projectId;
    const place = { organizationId: orgA(), projectId: project };
    const runnerId = await seedPersonalRunner(harness, a.admin.id, `${slug}-runner`);
    const task = await seedTask(harness, { ...place, state: "running", driverMemberId: a.member.id });
    await seedLease(harness, task, orgA(), project, runnerId);
    return { task, project, runnerId };
  };

  it("lets the driver send, writing the message as an event and a steer command", async () => {
    const { task, runnerId } = await prepare("send-1");
    harness.fakes.outbox.clear();
    const messageId = clientMessageIdSchema.parse(uuid("client"));
    const sent = await (await harness.as(harness.fixture.a.member)).tasks.send({ taskId: task.taskId, clientMessageId: messageId, text: "also add a license" });
    expect(sent.duplicate).toBe(false);
    const event = await harness.test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "user.message" } });
    expect(event.payload).toMatchObject({ memberId: harness.fixture.a.member.id, clientMessageId: messageId, text: "also add a license", delivery: "queued" });
    expect(harness.fakes.outbox.commands).toMatchObject([{ runnerId, kind: "steer", body: { sessionId: task.sessionId, clientMessageId: messageId, text: "also add a license", delivery: "queue" } }]);
  });

  it("applies a resent message once", async () => {
    const { task } = await prepare("send-2");
    const member = await harness.as(harness.fixture.a.member);
    const messageId = clientMessageIdSchema.parse(uuid("client"));
    const first = await member.tasks.send({ taskId: task.taskId, clientMessageId: messageId, text: "once" });
    const again = await member.tasks.send({ taskId: task.taskId, clientMessageId: messageId, text: "once" });
    expect(again).toEqual({ seq: first.seq, duplicate: true });
    expect(await harness.test.db.event.count({ where: { taskId: task.taskId, kind: "user.message" } })).toBe(1);
    expect(harness.fakes.outbox.commands.filter((command) => command.kind === "steer" && Reflect.get(command.body, "clientMessageId") === messageId)).toHaveLength(1);
  });

  it("refuses a watcher, by the API and not only the UI, and refuses an interrupt the same way", async () => {
    const { task } = await prepare("watcher");
    const watcher = await harness.as(harness.fixture.a.insider);
    const messageId = clientMessageIdSchema.parse(uuid("client"));
    await expect(watcher.tasks.send({ taskId: task.taskId, clientMessageId: messageId, text: "let me in" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(watcher.tasks.interrupt({ taskId: task.taskId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await harness.test.db.event.count({ where: { taskId: task.taskId, kind: "user.message" } })).toBe(0);
    expect((await watcher.tasks.get({ taskId: task.taskId })).capabilities).toMatchObject({ send: false, interrupt: false, takeOver: true });
  });

  it("lets a watcher take over, and then the old driver is the watcher", async () => {
    const { task } = await prepare("takeover");
    const { member, insider } = harness.fixture.a;
    expect(await (await harness.as(insider)).tasks.takeOver({ taskId: task.taskId })).toEqual({ driver: insider.id, changed: true });
    expect(await (await harness.as(insider)).tasks.takeOver({ taskId: task.taskId })).toEqual({ driver: insider.id, changed: false });
    const change = await harness.test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "driver.changed" } });
    expect(change.payload).toMatchObject({ memberId: insider.id, byMemberId: insider.id });
    await expect(
      (await harness.as(member)).tasks.send({ taskId: task.taskId, clientMessageId: clientMessageIdSchema.parse(uuid("client")), text: "too late" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      (await harness.as(insider)).tasks.send({ taskId: task.taskId, clientMessageId: clientMessageIdSchema.parse(uuid("client")), text: "I drive" }),
    ).resolves.toMatchObject({ duplicate: false });
  });

  it("serializes a take-over and a send at the same moment: the send commits before it or is refused", async () => {
    for (let round = 0; round < 5; round += 1) {
      const { task } = await prepare(`race-${String(round)}`);
      const { member, insider } = harness.fixture.a;
      const settled = await Promise.allSettled([
        (await harness.as(member)).tasks.send({ taskId: task.taskId, clientMessageId: clientMessageIdSchema.parse(uuid("client")), text: "race" }),
        (await harness.as(insider)).tasks.takeOver({ taskId: task.taskId }),
      ]);
      const events = await harness.test.db.event.findMany({ where: { taskId: task.taskId, kind: { in: ["user.message", "driver.changed"] } }, orderBy: { seq: "asc" } });
      const kinds = events.map((event) => event.kind);
      const [sent, taken] = settled;
      expect(taken.status).toBe("fulfilled");
      if (sent.status === "fulfilled") {
        // The send won the lock: its message is in the log before the take-over.
        expect(kinds).toEqual(["user.message", "driver.changed"]);
      } else {
        expect(sent.reason).toMatchObject({ code: "FORBIDDEN" });
        expect(kinds).toEqual(["driver.changed"]);
      }
    }
  });

  it("interrupts the running turn for the driver, and refuses when nothing runs", async () => {
    const { task, runnerId } = await prepare("interrupt");
    harness.fakes.outbox.clear();
    await (await harness.as(harness.fixture.a.member)).tasks.interrupt({ taskId: task.taskId });
    expect(harness.fakes.outbox.commands).toMatchObject([{ runnerId, kind: "interrupt", body: { sessionId: task.sessionId } }]);
    expect(await harness.test.db.event.count({ where: { taskId: task.taskId, kind: "turn.cancel_requested" } })).toBe(1);
    const idle = await seedTask(harness, { organizationId: orgA(), projectId: harness.fixture.a.openProject.id, state: "queued", driverMemberId: harness.fixture.a.member.id, sessionState: "starting" });
    await expect((await harness.as(harness.fixture.a.member)).tasks.interrupt({ taskId: idle.taskId })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("is invisible to another organization", async () => {
    const { task } = await prepare("other-org");
    const outsider = await harness.as(harness.fixture.b.admin);
    await expect(outsider.tasks.send({ taskId: task.taskId, clientMessageId: clientMessageIdSchema.parse(uuid("client")), text: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(outsider.tasks.takeOver({ taskId: task.taskId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(outsider.tasks.interrupt({ taskId: task.taskId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("approvals.answer (F-026, ADR 0036)", () => {
  const options = [
    { optionId: "o-once", label: "Approve once", kind: "allow-once", decision: "allow_once" },
    { optionId: "o-task", label: "Approve for this task", kind: "allow-always", decision: "allow_task" },
    { optionId: "o-deny", label: "Deny", kind: "reject-once", decision: "deny" },
  ] as const;

  const prepare = async (slug: string, open = 2) => {
    const { a } = harness.fixture;
    const project = (await seedProject(harness, world, slug)).projectId;
    const place = { organizationId: orgA(), projectId: project };
    const runnerId = await seedPersonalRunner(harness, a.admin.id, `${slug}-runner`);
    const task = await seedTask(harness, { ...place, state: "needs_you", driverMemberId: a.member.id, sessionState: "waiting" });
    await seedLease(harness, task, orgA(), project, runnerId);
    const approvals: string[] = [];
    for (let index = 0; index < open; index += 1) {
      const approval = await harness.test.db.approval.create({
        data: { organizationId: orgA(), projectId: project, taskId: task.taskId, sessionId: task.sessionId, toolCallId: `tool-${String(index)}`, options: [...options] },
      });
      await harness.test.db.needsYouItem.create({ data: { organizationId: orgA(), projectId: project, taskId: task.taskId, reason: "approval", audience: "project_members", approvalId: approval.id } });
      approvals.push(approval.id);
    }
    return { task, project, runnerId, approvals };
  };

  it("lets any member of the project answer, and commits the answer, the command and the task's move", async () => {
    const { task, runnerId, approvals } = await prepare("approve-1");
    const first = approvalIdSchema.parse(approvals[0]);
    harness.fakes.outbox.clear();
    // Not the driver: an insider answers.
    const answered = await (await harness.as(harness.fixture.a.insider)).approvals.answer({ approvalId: first, decision: "allow_once" });
    expect(answered).toEqual({ approvalId: first, decision: "allow_once" });
    expect(await harness.test.db.approval.findUniqueOrThrow({ where: { id: first } })).toMatchObject({
      state: "answered",
      decision: "allow_once",
      optionId: "o-once",
      answeredByMemberId: harness.fixture.a.insider.id,
    });
    const event = await harness.test.db.event.findFirstOrThrow({ where: { taskId: task.taskId, kind: "approval.answered" } });
    expect(event.payload).toMatchObject({ approvalId: first, optionId: optionIdSchema.parse("o-once"), decision: "allow_once", memberId: memberIdSchema.parse(harness.fixture.a.insider.id) });
    expect(harness.fakes.outbox.commands).toMatchObject([{ runnerId, kind: "approval-answer", body: { approvalId: first, decision: "allow_once", sessionId: task.sessionId } }]);
    expect(await harness.test.db.auditEntry.count({ where: { action: "approval.answered", entityId: first } })).toBe(1);
    expect((await harness.test.db.task.findUniqueOrThrow({ where: { id: task.taskId } })).state).toBe("running");
    expect((await harness.test.db.needsYouItem.findFirstOrThrow({ where: { approvalId: first } })).state).toBe("answered");
  });

  it("gives the first answer the win: a second member, or the same twice, gets a conflict", async () => {
    const { approvals } = await prepare("approve-2");
    const target = approvalIdSchema.parse(approvals[0]);
    const results = await Promise.allSettled([
      (await harness.as(harness.fixture.a.insider)).approvals.answer({ approvalId: target, decision: "allow_once" }),
      (await harness.as(harness.fixture.a.member)).approvals.answer({ approvalId: target, decision: "deny" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((result) => result.status === "rejected");
    expect(lost?.status === "rejected" ? lost.reason : null).toMatchObject({ code: "CONFLICT" });
    await expect((await harness.as(harness.fixture.a.admin)).approvals.answer({ approvalId: target, decision: "allow_once" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await harness.test.db.auditEntry.count({ where: { action: "approval.answered", entityId: target } })).toBe(1);
  });

  it("leaves the session's other approvals to the runner, which reports each closed when a deny ends the turn", async () => {
    const { task, approvals } = await prepare("approve-3", 3);
    await (await harness.as(harness.fixture.a.member)).approvals.answer({ approvalId: approvalIdSchema.parse(approvals[0]), decision: "deny" });
    const rows = await harness.test.db.approval.findMany({ where: { taskId: task.taskId }, orderBy: { createdAt: "asc" } });
    expect(rows.map((row) => row.state)).toEqual(["answered", "open", "open"]);
    // The server writes no `approval.closed`: only a runner does (`serverOnlyKinds`).
    expect(await harness.test.db.event.count({ where: { taskId: task.taskId, kind: "approval.closed" } })).toBe(0);
  });

  it("refuses a decision the agent didn't offer, another organization, and a restricted project's outsiders", async () => {
    const { a, b } = harness.fixture;
    const { approvals } = await prepare("approve-4", 1);
    const target = approvalIdSchema.parse(approvals[0]);
    await harness.test.db.approval.update({ where: { id: target }, data: { options: [options[0]] } });
    await expect((await harness.as(a.member)).approvals.answer({ approvalId: target, decision: "deny" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect((await harness.as(b.admin)).approvals.answer({ approvalId: target, decision: "allow_once" })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const restricted = await seedTask(harness, { organizationId: orgA(), projectId: a.restrictedProject.id, state: "needs_you", sessionState: "waiting" });
    const hidden = await harness.test.db.approval.create({
      data: { organizationId: orgA(), projectId: a.restrictedProject.id, taskId: restricted.taskId, sessionId: restricted.sessionId, toolCallId: "t", options: [...options] },
    });
    await expect((await harness.as(a.member)).approvals.answer({ approvalId: approvalIdSchema.parse(hidden.id), decision: "allow_once" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
