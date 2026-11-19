import { createNeedsYouItemInTx } from "@ostra/domain";
import type { DbEnum } from "@ostra/db";
import { optionIdSchema, toolCallIdSchema, turnIdSchema } from "@ostra/protocol";
import type { OrganizationId, ProjectId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appendEvent, createApiHarness, seedBoard, seedLinearConnection, seedPersonalRunner, seedTask, seedTicket } from "../testing/index.ts";
import type { ApiHarness, SeededTask } from "../testing/index.ts";
import { BOARD_PAGE_SIZE } from "./home-board.ts";

// F-062, ticket 36: Home's board. The member's tasks as cards in five columns by state, each column
// with its own total and cursor, a card carrying what its status line is made of, the finished
// column limited to the last seven days, and only the projects the member can open.

let harness: ApiHarness;
let orgA: OrganizationId;
let open: ProjectId;
let restricted: ProjectId;
let boardId: Awaited<ReturnType<typeof seedBoard>>;
let connectionId: Awaited<ReturnType<typeof seedLinearConnection>>;

beforeAll(async () => {
  harness = await createApiHarness();
  orgA = harness.fixture.a.organization.id;
  open = harness.fixture.a.openProject.id;
  restricted = harness.fixture.a.restrictedProject.id;
  connectionId = await seedLinearConnection(harness);
  boardId = await seedBoard(harness, { projectId: open, connectionId });
});

afterAll(async () => {
  await harness.dispose();
});

const place = (projectId: ProjectId) => ({ organizationId: orgA, projectId });
const DAY = 86_400_000;

type StateSeed = {
  readonly state: DbEnum.TaskState;
  readonly title: string;
  readonly projectId?: ProjectId;
  readonly driver?: string | null;
  readonly ageMs?: number;
  readonly over?: Record<string, unknown>;
};

/** A task in any state, with the columns its lifecycle checks need. */
const makeTask = async (seed: StateSeed): Promise<SeededTask> => {
  const projectId = seed.projectId ?? open;
  const task = await seedTask(harness, { ...place(projectId), title: seed.title, state: "queued", driverMemberId: seed.driver ?? null });
  await harness.test.db.task.update({
    where: { id: task.taskId },
    data: {
      state: seed.state,
      subState: seed.state === "in_review" ? "ci_running" : null,
      needsYouReason: seed.state === "needs_you" ? "approval" : null,
      stoppedReason: seed.state === "stopped" ? "requested" : null,
      // Only a refine or review task is `done` (ADR 0028).
      ...(seed.state === "done" ? { kind: "refine" as const } : {}),
      ...seed.over,
    },
  });
  if (seed.ageMs !== undefined) {
    await harness.test.db.$executeRaw`UPDATE "task" SET "updatedAt" = ${new Date(Date.now() - seed.ageMs)} WHERE "id" = ${task.taskId}`;
  }
  return task;
};

const titles = (cards: readonly { readonly title: string }[]) => cards.map((card) => card.title);

describe("home.board", () => {
  it("F-062: groups the member's tasks by state into five columns, each with its total and status line data", async () => {
    const { a } = harness.fixture;
    const runner = await seedPersonalRunner(harness, a.admin.id, "alex-laptop");

    // Needs you: an approval with its item, so the line is the command it asks about.
    const asking = await makeTask({ state: "needs_you", title: "Asks to add zod", driver: a.member.id });
    const approval = await harness.test.db.approval.create({
      data: {
        ...place(open),
        taskId: asking.taskId,
        sessionId: asking.sessionId,
        toolCallId: "tc-1",
        options: [{ optionId: optionIdSchema.parse("o-once"), label: "Approve once", kind: "allow-once", decision: "allow_once" }],
        subjectKind: "command",
        subjectValue: "pnpm add zod",
      },
    });
    await harness.test.db.$transaction((tx) => createNeedsYouItemInTx(harness.deps.ports, tx, { ...place(open), taskId: asking.taskId, reason: "approval", audience: "project_members", approvalId: approval.id }));

    // Queued: a personal runner's task, and ones from tickets with priorities.
    await makeTask({ state: "queued", title: "Pinned to my runner", over: { runnerId: runner } });
    const low = await makeTask({ state: "queued", title: "Low priority ticket" });
    const urgent = await makeTask({ state: "queued", title: "Urgent ticket" });
    await makeTask({ state: "queued", title: "Prompt without a ticket" });
    for (const [task, priority, key] of [
      [low, 4, "ENG-401"],
      [urgent, 1, "ENG-402"],
    ] as const) {
      const ticketId = await seedTicket(harness, { projectId: open, boardId, connectionId, key, priority });
      await harness.test.db.task.update({ where: { id: task.taskId }, data: { ticketId, ticketKey: key, boardId } });
    }

    // Running: what the agent is doing, from its latest event. Preparing: the setup it is in.
    const running = await makeTask({ state: "running", title: "Running tests", driver: a.admin.id });
    await appendEvent(harness, running, place(open), {
      kind: "tool.called",
      turnId: turnIdSchema.parse("turn-r"),
      toolCallId: toolCallIdSchema.parse("tc-run"),
      toolKind: "execute",
      title: "pnpm test",
      input: { command: "pnpm test" },
    });
    const preparing = await makeTask({ state: "preparing", title: "Setting up" });
    await appendEvent(harness, preparing, place(open), { kind: "environment.setup_started" });

    // In review: with a PR. Finished: merged, done, stopped by a member; and one merged long ago.
    const review = await makeTask({ state: "in_review", title: "Waiting on CI" });
    const repo = await seedRepoFor(open);
    await harness.test.db.taskRepo.create({ data: { ...place(open), taskId: review.taskId, repoId: repo, branchName: "ostra/r", baseBranch: "main", prNumber: 481, prUrl: "https://github.example/pr/481", state: "pr_open" } });
    const merged = await makeTask({ state: "merged", title: "Shipped", ageMs: 2 * DAY });
    await harness.test.db.taskRepo.create({ data: { ...place(open), taskId: merged.taskId, repoId: repo, branchName: "ostra/m", baseBranch: "main", prNumber: 2207, prUrl: "https://github.example/pr/2207", state: "merged" } });
    await makeTask({ state: "done", title: "All done", ageMs: 3 * DAY });
    const stopped = await makeTask({ state: "stopped", title: "Stopped by Sam", ageMs: DAY });
    await harness.test.db.auditEntry.create({ data: { ...place(open), actorKind: "member", actorId: a.member.id, action: "task.stopped", entity: "task", entityId: stopped.taskId } });
    await makeTask({ state: "merged", title: "Merged last month", ageMs: 30 * DAY });

    // Out of reach: a restricted project's task, and another organization's.
    await makeTask({ state: "running", title: "Secret work", projectId: restricted });
    await seedTask(harness, { organizationId: harness.fixture.b.organization.id, projectId: harness.fixture.b.project.id, title: "Other org", state: "running" });

    const board = await (await harness.as(a.member)).home.board({});
    expect(board.columns.map((column) => column.column)).toEqual(["needs-you", "queued", "running", "in-review", "finished"]);
    expect(board.finishedWindowDays).toBe(7);
    const column = (name: string) => board.columns.find((candidate) => candidate.column === name);

    const needs = column("needs-you");
    expect(needs).toMatchObject({ total: 1 });
    expect(needs?.cards[0]).toMatchObject({
      title: "Asks to add zod",
      driver: { memberId: a.member.id, name: "member-a" },
      project: { id: open },
      status: { kind: "needs-you", reason: "approval", view: { reason: "approval", detail: { reason: "approval", command: "pnpm add zod" } } },
    });

    // The queue's own order: priority first (urgent, then low), then those without, by age.
    const queued = column("queued");
    expect(queued?.total).toBe(4);
    expect(titles(queued?.cards ?? [])).toEqual(["Urgent ticket", "Low priority ticket", "Pinned to my runner", "Prompt without a ticket"]);
    expect(queued?.cards.find((card) => card.title === "Pinned to my runner")?.status).toMatchObject({ kind: "queued", runner: { name: "alex-laptop", personal: true } });
    expect(queued?.cards[0]).toMatchObject({ key: "ENG-402" });

    const live = column("running");
    expect(live?.total).toBe(2);
    expect(live?.cards.find((card) => card.title === "Running tests")).toMatchObject({
      driver: { name: "admin-a" },
      status: { kind: "running", doing: { kind: "tool.called", detail: "pnpm test", toolKind: "execute" } },
    });
    expect(live?.cards.find((card) => card.title === "Setting up")?.status).toMatchObject({ kind: "preparing", doing: { kind: "environment.setup_started" } });

    expect(column("in-review")?.cards[0]).toMatchObject({ title: "Waiting on CI", status: { kind: "in-review", subState: "ci_running", prNumbers: [481] } });

    const finished = column("finished");
    expect(finished?.total).toBe(3);
    expect(titles(finished?.cards ?? [])).toEqual(["Stopped by Sam", "Shipped", "All done"]);
    expect(finished?.cards.find((card) => card.title === "Shipped")?.status).toMatchObject({ kind: "finished", outcome: "merged", prNumbers: [2207] });
    expect(finished?.cards.find((card) => card.title === "All done")?.status).toMatchObject({ kind: "finished", outcome: "done" });
    expect(finished?.cards.find((card) => card.title === "Stopped by Sam")?.status).toMatchObject({ kind: "finished", outcome: "stopped", stopReason: "requested", stoppedBy: { name: "member-a" } });

    // Nothing from the restricted project or the other organization, for this member.
    const everything = board.columns.flatMap((candidate) => titles(candidate.cards));
    expect(everything).not.toContain("Secret work");
    expect(everything).not.toContain("Other org");
    expect(everything).not.toContain("Merged last month");
    // The insider, who is on the restricted project, sees its running task.
    const insider = await (await harness.as(a.insider)).home.board({});
    expect(titles(insider.columns.find((candidate) => candidate.column === "running")?.cards ?? [])).toContain("Secret work");
  });

  it("F-062: a project filter narrows every column to that project, and a project the member can't open is not found", async () => {
    const { a } = harness.fixture;
    const member = await harness.as(a.member);
    const narrowed = await member.home.board({ projectId: open });
    expect(narrowed.columns.reduce((sum, column) => sum + column.total, 0)).toBe(11);
    const insider = await harness.as(a.insider);
    const only = await insider.home.board({ projectId: restricted });
    expect(only.columns.map((column) => titles(column.cards))).toEqual([[], [], ["Secret work"], [], []]);
    await expect(member.home.board({ projectId: restricted })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(member.home.board({ projectId: harness.fixture.b.project.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("F-062: pages a column with its own cursor, the total apart from the page", async () => {
    const { a } = harness.fixture;
    for (let index = 0; index < 24; index += 1) {
      await makeTask({ state: "in_review", title: `Review ${String(index).padStart(2, "0")}`, ageMs: index * 1000 });
    }
    const member = await harness.as(a.member);
    const first = await member.home.board({});
    const review = first.columns.find((column) => column.column === "in-review");
    expect(review?.total).toBe(25);
    expect(review?.cards).toHaveLength(BOARD_PAGE_SIZE);
    expect(review?.nextCursor).not.toBeNull();
    // The other columns are unaffected by this one's paging.
    expect(first.columns.find((column) => column.column === "queued")?.nextCursor).toBeNull();

    const second = await member.home.board({ column: "in-review", cursor: review?.nextCursor ?? "" });
    expect(second.columns).toHaveLength(1);
    const next = second.columns[0];
    expect(next?.total).toBe(25);
    expect(next?.cards).toHaveLength(5);
    expect(next?.nextCursor).toBeNull();
    const ids = [...(review?.cards ?? []), ...(next?.cards ?? [])].map((card) => card.taskId);
    expect(new Set(ids).size).toBe(25);

    // The queue pages by position in its own order.
    for (let index = 0; index < 22; index += 1) {
      await makeTask({ state: "queued", title: `Queued ${String(index).padStart(2, "0")}` });
    }
    const queue = (await member.home.board({ column: "queued" })).columns[0];
    expect(queue?.total).toBe(26);
    expect(queue?.cards).toHaveLength(BOARD_PAGE_SIZE);
    const rest = (await member.home.board({ column: "queued", cursor: queue?.nextCursor ?? "" })).columns[0];
    expect(rest?.cards).toHaveLength(6);
    expect(rest?.nextCursor).toBeNull();
    expect(new Set([...(queue?.cards ?? []), ...(rest?.cards ?? [])].map((card) => card.taskId)).size).toBe(26);
  });
});

/** A repo of the open project, for tasks with pull requests. */
const seedRepoFor = async (projectId: ProjectId): Promise<string> => {
  const existing = await harness.test.db.repo.findFirst({ where: { projectId } });
  if (existing !== null) {
    return existing.id;
  }
  const connection = await harness.test.db.connection.create({
    data: { organizationId: orgA, kind: "github", appId: "board-app" },
    select: { id: true },
  });
  const repo = await harness.test.db.repo.create({
    data: {
      organizationId: orgA,
      projectId,
      connectionId: connection.id,
      installationId: "board-install",
      hostRepoId: "board-1",
      fullName: "ostra-test/board",
      defaultBranch: "main",
      checkoutDir: "board",
    },
    select: { id: true },
  });
  return repo.id;
};
