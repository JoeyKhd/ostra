import { createNeedsYouItemInTx, fanOutNotification, resolveNeedsYouItemsInTx } from "@ostra/domain";
import type { DbEnum } from "@ostra/db";
import { memberIdSchema, notificationIdSchema, optionIdSchema, questionIdSchema, turnIdSchema } from "@ostra/protocol";
import type { ApprovalOption, NeedsYouItemId, OrganizationId, ProjectId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appendEvent, createApiHarness, seedConnectionAndModel, seedProject, seedTask } from "../testing/index.ts";
import type { ApiHarness, SeededTask } from "../testing/index.ts";

// F-062, F-036, ticket 36: Home's needs-you rows and the Needs you page come from the open items a
// member is the audience of or can answer, in the projects they can open, newest first; a task with
// two open items shows both; the notification list, its unread count and "mark read" are the
// member's own.

let harness: ApiHarness;
let orgA: OrganizationId;
let open: ProjectId;
let restricted: ProjectId;
/** A project with a repo, for the task that has a pull request. */
let withRepo: ProjectId;
let repoId: string;

beforeAll(async () => {
  harness = await createApiHarness();
  orgA = harness.fixture.a.organization.id;
  open = harness.fixture.a.openProject.id;
  restricted = harness.fixture.a.restrictedProject.id;
  const world = await seedConnectionAndModel(harness);
  const calc = await seedProject(harness, world, "calc");
  withRepo = calc.projectId;
  repoId = calc.repoId;
});

afterAll(async () => {
  await harness.dispose();
});

const place = (projectId: ProjectId) => ({ organizationId: orgA, projectId });

const options: readonly ApprovalOption[] = [
  { optionId: optionIdSchema.parse("o-once"), label: "Approve once", kind: "allow-once", decision: "allow_once" },
  { optionId: optionIdSchema.parse("o-task"), label: "Approve for this task", kind: "allow-always", decision: "allow_task" },
  { optionId: optionIdSchema.parse("o-deny"), label: "Deny", kind: "reject-once", decision: "deny" },
];

/** An item the way core's writers make it, with its fan-out job owed. */
const makeItem = async (
  task: SeededTask,
  projectId: ProjectId,
  item: { readonly reason: DbEnum.NeedsYouReason; readonly audience?: DbEnum.NeedsYouAudience; readonly approvalId?: string; readonly questionId?: string; readonly planTurnId?: string },
): Promise<NeedsYouItemId> =>
  harness.test.db.$transaction((tx) =>
    createNeedsYouItemInTx(harness.deps.ports, tx, { ...place(projectId), taskId: task.taskId, ...item, audience: item.audience ?? "project_members" }),
  );

const needsTask = async (title: string, projectId: ProjectId, over: { readonly driver?: string | null; readonly reason?: DbEnum.NeedsYouReason } = {}) => {
  const task = await seedTask(harness, { ...place(projectId), title, state: "needs_you", driverMemberId: over.driver ?? null });
  await harness.test.db.task.update({ where: { id: task.taskId }, data: { needsYouReason: over.reason ?? "question" } });
  return task;
};

/** Every reason, once: what each seeds beside its item (a record, so a new reason fails to compile here). */
const nothing = (): Promise<void> => Promise.resolve();

const everyReason = {
  question: async (task) => {
    await appendEvent(harness, task, place(open), {
      kind: "question.asked",
      turnId: turnIdSchema.parse("turn-q"),
      questionId: questionIdSchema.parse("q-reasons"),
      message: "Keep the old share API?\nThe new one needs Android 13.",
      fields: [],
    });
  },
  approval: nothing,
  plan: async (task) => {
    await appendEvent(harness, task, place(open), {
      kind: "plan.proposed",
      turnId: turnIdSchema.parse("turn-plan"),
      entries: [
        { content: "Read the settings module", priority: "medium", status: "pending" },
        { content: "Add the theme switch", priority: "high", status: "pending" },
      ],
      message: "Here is the plan.",
    });
  },
  no_changes: nothing,
  stalled: nothing,
  spend_cap: nothing,
  crashed: nothing,
  setup_failed: async (task) => {
    await appendEvent(harness, task, place(open), { kind: "environment.setup_finished", exitCode: 1, durationMs: 1200 });
  },
  ticket_closed: async (task) => {
    await appendEvent(harness, task, place(open), { kind: "ticket.closed", status: "Done", category: "done" });
  },
  draft_ready: async (task) => {
    await harness.test.db.taskRepo.create({ data: { ...place(withRepo), taskId: task.taskId, repoId, branchName: "ostra/x", baseBranch: "main", prNumber: 2213, prUrl: "https://github.example/pr/2213", state: "pr_open" } });
  },
  round_cap: nothing,
  waiting_for_reviewer: nothing,
  environment_proposal: nothing,
  restore_conflict: nothing,
  unstorable_event: nothing,
  files_outside_repos: nothing,
  no_provider_for_model: nothing,
  runner_awaiting_approval: nothing,
  awaiting_approval: nothing,
} satisfies Record<DbEnum.NeedsYouReason, (task: SeededTask) => Promise<void>>;

const isReason = (value: string): value is DbEnum.NeedsYouReason => value in everyReason;

describe("the member's needs-you list", () => {
  it("F-062: every reason renders, each seeded once, newest first", async () => {
    const reasons = Object.keys(everyReason).filter(isReason);
    const made: { readonly reason: DbEnum.NeedsYouReason; readonly item: NeedsYouItemId; readonly task: SeededTask }[] = [];
    for (const reason of reasons) {
      const project = reason === "draft_ready" ? withRepo : open;
      const task = await needsTask(`Task for ${reason}`, project, { reason });
      await everyReason[reason](task);
      let approvalId: string | undefined;
      if (reason === "approval") {
        const approval = await harness.test.db.approval.create({
          data: { ...place(open), taskId: task.taskId, sessionId: task.sessionId, toolCallId: "tool-1", options: [...options], subjectKind: "command", subjectValue: "pnpm add zod" },
        });
        approvalId = approval.id;
      }
      const item = await makeItem(task, project, {
        reason,
        ...(approvalId === undefined ? {} : { approvalId }),
        ...(reason === "question" ? { questionId: "q-reasons" } : {}),
        ...(reason === "plan" ? { planTurnId: "turn-plan" } : {}),
      });
      made.push({ reason, item, task });
      // Items are ordered by when they came: a moment apart keeps the order the test expects.
      await harness.test.db.needsYouItem.update({ where: { id: item }, data: { createdAt: new Date(Date.now() - (reasons.length - made.length) * 1000) } });
    }

    const admin = await harness.as(harness.fixture.a.admin);
    const page = await admin.home.needsYou({ limit: 50 });
    expect(page.total).toBe(reasons.length);
    expect(page.rows.map((row) => row.reason)).toEqual([...reasons].reverse());
    expect(page.nextCursor).toBeNull();

    const byReason = new Map(page.rows.map((row) => [row.reason, row] as const));
    expect(byReason.get("question")?.detail).toEqual({ reason: "question", question: "Keep the old share API?" });
    expect(byReason.get("question")?.answer).toMatchObject({ kind: "question", questionId: "q-reasons", canAnswer: false });
    expect(byReason.get("approval")?.detail).toMatchObject({ reason: "approval", command: "pnpm add zod", subject: { kind: "command", value: "pnpm add zod" } });
    expect(byReason.get("approval")?.answer).toMatchObject({ kind: "approval", forThisTask: { tool: "execute", pattern: "pnpm add" }, agentName: "OpenCode", canAnswer: true });
    expect(byReason.get("approval")?.answer).toMatchObject({ options: [{ decision: "allow_once" }, { decision: "allow_task" }, { decision: "deny" }] });
    expect(byReason.get("plan")?.detail).toEqual({ reason: "plan", steps: 2 });
    expect(byReason.get("plan")?.answer).toMatchObject({ kind: "plan", entries: [{ content: "Read the settings module" }, { content: "Add the theme switch" }], message: "Here is the plan." });
    expect(byReason.get("setup_failed")?.detail).toEqual({ reason: "setup_failed", exitCode: 1 });
    expect(byReason.get("ticket_closed")?.detail).toEqual({ reason: "ticket_closed", status: "Done" });
    expect(byReason.get("draft_ready")?.detail).toEqual({ reason: "draft_ready", prNumber: 2213 });
    const stalled = byReason.get("stalled")?.detail;
    expect(stalled?.reason === "stalled" && stalled.minutes >= 1).toBe(true);
    for (const plain of ["no_changes", "spend_cap", "crashed", "round_cap", "waiting_for_reviewer", "environment_proposal", "restore_conflict", "unstorable_event", "files_outside_repos", "awaiting_approval"] as const) {
      expect(byReason.get(plain)?.detail).toEqual({ reason: plain });
    }
    // Each row names its task, its project and its key.
    const sample = page.rows[0];
    expect(sample).toMatchObject({ project: { id: open, name: harness.fixture.a.openProject.name }, state: "open" });
    expect(sample?.key).toHaveLength(8);
  });

  it("F-062: Home shows the first five, with the total of all", async () => {
    const home = await (await harness.as(harness.fixture.a.admin)).home.overview();
    expect(home.needsYou.total).toBe(19);
    expect(home.needsYou.rows).toHaveLength(5);
    expect(home.needsYou.rows.map((row) => row.reason)).toEqual(["awaiting_approval", "runner_awaiting_approval", "no_provider_for_model", "files_outside_repos", "unstorable_event"]);
  });

  it("F-062: a task with two open items shows both", async () => {
    const task = await needsTask("Two things at once", open, { reason: "approval" });
    const approval = await harness.test.db.approval.create({ data: { ...place(open), taskId: task.taskId, sessionId: task.sessionId, toolCallId: "t-two", options: [...options], subjectKind: "path", subjectValue: "src/a.ts" } });
    const first = await makeItem(task, open, { reason: "approval", approvalId: approval.id });
    const second = await makeItem(task, open, { reason: "question", audience: "driver" });
    const rows = (await (await harness.as(harness.fixture.a.admin)).home.needsYou({ limit: 50 })).rows.filter((row) => row.taskId === task.taskId);
    expect(rows.map((row) => row.itemId).sort()).toEqual([first, second].sort());
    expect(rows.map((row) => row.reason).sort()).toEqual(["approval", "question"]);
  });

  it("F-062: pages with a cursor, each item once, in order", async () => {
    const admin = await harness.as(harness.fixture.a.admin);
    const everyone = (await admin.home.needsYou({ limit: 50 })).rows.map((row) => row.itemId);
    const seen: (NeedsYouItemId | null)[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await admin.home.needsYou({ limit: 6, ...(cursor === undefined ? {} : { cursor }) });
      seen.push(...page.rows.map((row) => row.itemId));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor !== undefined && pages < 10);
    expect(pages).toBe(Math.ceil(everyone.length / 6));
    expect(seen).toEqual(everyone);
  });

  it("F-062: shows a member only their projects' items, what they are the audience of, and every approval", async () => {
    const { a, b } = harness.fixture;
    // A restricted project's item, a driver's question on a task another member drives, another organization's item.
    const hidden = await needsTask("Secret plan", restricted, { reason: "plan" });
    await makeItem(hidden, restricted, { reason: "plan", audience: "driver" });
    const driven = await needsTask("Driven by the insider", open, { driver: a.insider.id, reason: "question" });
    await appendEvent(harness, driven, place(open), { kind: "question.asked", turnId: turnIdSchema.parse("turn-d"), questionId: questionIdSchema.parse("q-driven"), message: "Which branch?", fields: [] });
    await makeItem(driven, open, { reason: "question", audience: "driver", questionId: "q-driven" });
    const theirs = await seedTask(harness, { organizationId: b.organization.id, projectId: b.project.id, title: "Other org", state: "needs_you" });
    await harness.test.db.needsYouItem.create({ data: { organizationId: b.organization.id, projectId: b.project.id, taskId: theirs.taskId, reason: "question", audience: "project_members" } });

    const titlesFor = async (who: typeof a.member) => (await (await harness.as(who)).home.needsYou({ limit: 50 })).rows.map((row) => row.title);
    const member = await titlesFor(a.member);
    expect(member).not.toContain("Secret plan");
    expect(member).not.toContain("Other org");
    // The question on a task the insider drives is the insider's, not the member's.
    expect(member).not.toContain("Driven by the insider");
    expect(member).toContain("Task for approval");
    const insider = await titlesFor(a.insider);
    expect(insider).toContain("Secret plan");
    expect(insider).toContain("Driven by the insider");
    // An approval on a task someone else drives is still the member's to answer.
    const approvalTask = await needsTask("Approval on their task", open, { driver: a.insider.id, reason: "approval" });
    const approval = await harness.test.db.approval.create({ data: { ...place(open), taskId: approvalTask.taskId, sessionId: approvalTask.sessionId, toolCallId: "t-x", options: [...options], subjectKind: "url", subjectValue: "https://registry.npmjs.org/zod" } });
    await makeItem(approvalTask, open, { reason: "approval", audience: "driver", approvalId: approval.id });
    expect(await titlesFor(a.member)).toContain("Approval on their task");
    expect(await titlesFor(b.admin)).toEqual(["Other org"]);
    expect((await (await harness.as(a.admin)).home.needsYou({ limit: 50 })).rows.map((row) => row.title)).toContain("Secret plan");
  });

  it("F-062: a plan and a question can be answered by the driver only: the row says so and names the driver", async () => {
    const { a } = harness.fixture;
    // A question raised for the project's members: everyone sees it, only the driver can answer.
    const shared = await needsTask("Asked of everyone", open, { driver: a.insider.id, reason: "question" });
    await appendEvent(harness, shared, place(open), { kind: "question.asked", turnId: turnIdSchema.parse("turn-s"), questionId: questionIdSchema.parse("q-shared"), message: "Which database?", fields: [] });
    await makeItem(shared, open, { reason: "question", audience: "project_members", questionId: "q-shared" });
    const rows = async (who: typeof a.member) => (await (await harness.as(who)).home.needsYou({ limit: 50 })).rows.find((row) => row.title === "Asked of everyone");
    expect((await rows(a.insider))?.answer).toMatchObject({ kind: "question", message: "Which database?", canAnswer: true });
    expect((await rows(a.admin))?.answer).toMatchObject({ kind: "question", canAnswer: false, driver: { memberId: a.insider.id, name: "insider-a" } });
    expect((await rows(a.member))?.answer).toMatchObject({ kind: "question", canAnswer: false });
  });

  it("F-062: a task in needs you from before items still shows, with no item behind it", async () => {
    await needsTask("Before items", open, { reason: "crashed" });
    const row = (await (await harness.as(harness.fixture.a.member)).home.needsYou({ limit: 50 })).rows.find((candidate) => candidate.title === "Before items");
    expect(row).toMatchObject({ itemId: null, reason: "crashed", detail: { reason: "crashed" } });
  });

  it("F-062: is for signed-in members only", async () => {
    await expect(harness.anonymous().home.needsYou({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(harness.anonymous().home.board({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("notifications", () => {
  it("F-036: the list, the unread count and 'mark read' are the member's own, and move on read and on answer", async () => {
    const { a, b } = harness.fixture;
    const task = await needsTask("Notify me", open, { driver: a.member.id, reason: "approval" });
    const approval = await harness.test.db.approval.create({ data: { ...place(open), taskId: task.taskId, sessionId: task.sessionId, toolCallId: "t-notify", options: [...options], subjectKind: "command", subjectValue: "pnpm test" } });
    const itemId = await makeItem(task, open, { reason: "approval", audience: "driver", approvalId: approval.id });
    const fanned = await fanOutNotification({ db: harness.test.db, ...harness.deps.ports }, { itemId, change: "created" });
    expect(fanned).toMatchObject({ ok: true, notifications: 1 });

    const member = await harness.as(a.member);
    // The Open tab is Home's list, with the member's own notification on the row it reached.
    const waiting = (await member.home.needsYou({ limit: 50 })).total;
    const open1 = await member.notifications.list({ tab: "open" });
    expect(open1).toMatchObject({ tab: "open", total: waiting, unread: 1 });
    expect(await member.notifications.openCount()).toEqual({ count: waiting });
    const row = open1.rows.find((candidate) => candidate.view.itemId === itemId);
    expect(row).toMatchObject({ kind: "approval", read: false, state: "open", failedDeliveries: [], view: { reason: "approval", taskId: task.taskId, itemId, project: { id: open } } });
    expect(row?.view.answer).toMatchObject({ kind: "approval", forThisTask: { tool: "execute", pattern: "pnpm test" } });
    // The driver is the audience: nobody else got a notification, in either organization. Another
    // member of the project still sees the approval (any member answers one), with nothing unread.
    const admin = await harness.as(a.admin);
    const adminRow = (await admin.notifications.list({ tab: "open" })).rows.find((candidate) => candidate.view.itemId === itemId);
    expect(adminRow).toMatchObject({ notificationId: null, kind: null, read: true });
    expect((await admin.notifications.list({ tab: "open" })).unread).toBe(0);
    expect((await (await harness.as(b.admin)).notifications.list({ tab: "open" })).rows.map((candidate) => candidate.view.itemId)).not.toContain(itemId);

    // Reading moves the unread count, not the list nor the count of what waits; another member can't read it for them.
    const notificationId = notificationIdSchema.parse(row?.notificationId);
    expect(await admin.notifications.markRead({ ids: [notificationId] })).toEqual({ marked: 0 });
    expect((await member.notifications.list({ tab: "open" })).unread).toBe(1);
    expect(await member.notifications.markRead({ ids: [notificationId] })).toEqual({ marked: 1 });
    expect(await member.notifications.markRead({ ids: [notificationId] })).toEqual({ marked: 0 });
    const read = await member.notifications.list({ tab: "open" });
    expect(read).toMatchObject({ total: waiting, unread: 0 });
    expect(read.rows.find((candidate) => candidate.view.itemId === itemId)).toMatchObject({ read: true });
    expect(await member.notifications.openCount()).toEqual({ count: waiting });

    // An answer closes the item: it leaves the Open tab and every count at once, before its
    // fan-out runs; the fan-out closes the notification, and it moves to Done with its outcome.
    await harness.test.db.$transaction(async (tx) => {
      await tx.approval.update({ where: { id: approval.id }, data: { state: "answered", decision: "allow_once", optionId: "o-once", answeredByMemberId: a.admin.id, resolvedAt: new Date() } });
      await resolveNeedsYouItemsInTx(harness.deps.ports, tx, { id: itemId }, { state: "answered", at: new Date(), byMemberId: a.admin.id });
      // The answer lets the task run on, as `answerApproval` does.
      await tx.task.update({ where: { id: task.taskId }, data: { state: "running", needsYouReason: null } });
    });
    expect((await member.notifications.list({ tab: "open" })).rows.map((candidate) => candidate.view.itemId)).not.toContain(itemId);
    expect(await member.notifications.openCount()).toEqual({ count: waiting - 1 });
    await fanOutNotification({ db: harness.test.db, ...harness.deps.ports }, { itemId, change: "answered" });
    const done = await member.notifications.list({ tab: "done" });
    expect(done.rows).toHaveLength(1);
    expect(done.rows[0]).toMatchObject({ state: "answered", view: { state: "answered", outcome: { kind: "approved-once", by: { memberId: memberIdSchema.parse(a.admin.id), name: "admin-a" } } } });
    expect(done.nextCursor).toBeNull();
  });

  it("F-036: a notification of a project the member can no longer open, and a test mail, never show or count", async () => {
    const { a } = harness.fixture;
    const task = await needsTask("Soon hidden", restricted, { reason: "question" });
    const itemId = await makeItem(task, restricted, { reason: "question", audience: "project_members" });
    await fanOutNotification({ db: harness.test.db, ...harness.deps.ports }, { itemId, change: "created" });
    const insider = await harness.as(a.insider);
    expect((await insider.notifications.list({ tab: "open" })).rows.map((row) => row.view.title)).toContain("Soon hidden");
    const before = await insider.notifications.list({ tab: "open" });
    const count = (await insider.notifications.openCount()).count;
    expect(count).toBe(before.total);
    // They leave the restricted project: its notifications drop out of the list and every count.
    await harness.test.db.projectMember.deleteMany({ where: { projectId: restricted, memberId: a.insider.id } });
    const gone = await harness.as(a.insider);
    const after = await gone.notifications.list({ tab: "open" });
    expect(after.rows.map((row) => row.view.title)).not.toContain("Soon hidden");
    expect(after.unread).toBe(before.unread - 1);
    expect((await gone.notifications.openCount()).count).toBeLessThan(count);
    await harness.test.db.projectMember.create({ data: { organizationId: orgA, projectId: restricted, memberId: a.insider.id, role: "member" } });

    // A test mail's notification has no project and no item.
    await harness.test.db.notification.create({ data: { organizationId: orgA, memberId: a.insider.id, kind: "test" } });
    const back = await harness.as(a.insider);
    expect((await back.notifications.openCount()).count).toBe(count);
    expect(await back.notifications.list({ tab: "open" })).toMatchObject({ total: count, unread: before.unread });
    expect((await back.notifications.list({ tab: "open" })).rows.every((row) => row.kind !== "test")).toBe(true);
  });

  it("F-036: shows a member's own failed deliveries under the notification, and pages the Done tab by cursor", async () => {
    const { a } = harness.fixture;
    const task = await needsTask("Mail trouble", open, { reason: "question" });
    const itemId = await makeItem(task, open, { reason: "question", audience: "project_members" });
    await fanOutNotification({ db: harness.test.db, ...harness.deps.ports }, { itemId, change: "created" });
    const mine = await harness.test.db.notification.findFirstOrThrow({ where: { memberId: a.member.id, needsYouItemId: itemId } });
    await harness.test.db.notificationDelivery.create({ data: { organizationId: orgA, notificationId: mine.id, channel: "email", adapter: "resend", idempotencyKey: `key-${itemId}`, state: "failed", error: "Resend refused the key", attempts: 3 } });
    const member = await harness.as(a.member);
    const row = (await member.notifications.list({ tab: "open" })).rows.find((candidate) => candidate.view.itemId === itemId);
    expect(row?.failedDeliveries).toEqual([{ channel: "email", state: "failed", error: "Resend refused the key", attempts: 3 }]);
    // The same notification, read by another member of the project, carries no one else's failures.
    const other = (await (await harness.as(a.admin)).notifications.list({ tab: "open" })).rows.find((candidate) => candidate.view.itemId === itemId);
    expect(other?.failedDeliveries).toEqual([]);

    // Fifty-one answered notifications make two Done pages.
    const doneTasks = await Promise.all(Array.from({ length: 51 }, (_, index) => needsTask(`Done ${String(index)}`, open, { reason: "question" })));
    for (const [index, doneTask] of doneTasks.entries()) {
      const id = await makeItem(doneTask, open, { reason: "question", audience: "project_members" });
      await fanOutNotification({ db: harness.test.db, ...harness.deps.ports }, { itemId: id, change: "created" });
      await harness.test.db.$transaction((tx) => resolveNeedsYouItemsInTx(harness.deps.ports, tx, { id }, { state: "answered", at: new Date(), byMemberId: a.admin.id }));
      await harness.test.db.notification.updateMany({ where: { needsYouItemId: id }, data: { state: "answered", updatedAt: new Date(Date.now() - index * 1000) } });
    }
    const first = await member.notifications.list({ tab: "done" });
    expect(first.rows).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const second = await member.notifications.list({ tab: "done", ...(first.nextCursor === null ? {} : { cursor: first.nextCursor }) });
    expect(second.rows.length).toBeGreaterThanOrEqual(1);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.rows, ...second.rows].map((entry) => entry.notificationId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
