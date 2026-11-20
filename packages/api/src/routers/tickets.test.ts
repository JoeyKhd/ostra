import { LinearAdapter } from "@ostra/adapter-linear";
import { createFakeLinear, createJiraSite, JiraFakeAdapter } from "@ostra/adapter-sdk/testing";
import type { FakeLinear } from "@ostra/adapter-sdk/testing";
import { taskIdSchema, ticketIdSchema } from "@ostra/protocol";
import type { BoardId, ConnectionId, ExternalTicketId, ProjectId, TicketId, TicketKey } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiHarness, seedBoard, seedConnectionAndModel, seedLinearConnection, seedProject, trpcFailure } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// Ticket 25 (F-077, F-010; ADR 0056): a parent ticket's page and "Start sub-issues", through Linear's
// adapter on the fake Linear server. A three-level tree starts only its leaves, the parent never gets
// a code task, a child on another team is listed and not started, each child shows its task, and the
// parent its refine task; the page is the project's, as any read of it.

let harness: ApiHarness;
let fake: FakeLinear;
let projectId: ProjectId;
let connectionId: ConnectionId;
let boardId: BoardId;
let parentId: TicketId;
const issues: Record<string, { readonly id: ExternalTicketId; readonly identifier: TicketKey }> = {};

const member = () => harness.as(harness.fixture.a.member);

beforeAll(async () => {
  harness = await createApiHarness();
  const world = await seedConnectionAndModel(harness);
  projectId = (await seedProject(harness, world, "parents")).projectId;
  fake = await createFakeLinear();
  harness.fakes.tracker.adapter = new LinearAdapter({ auth: { kind: "api-key", token: fake.adminApiKey }, apiUrl: fake.apiUrl });
  connectionId = await seedLinearConnection(harness);
  boardId = await seedBoard(harness, { projectId, connectionId, externalId: fake.team.id, key: fake.team.key });
  const elsewhere = fake.addTeam("ELS", "Elsewhere");
  // P → C1 → G1 → H1, P → C2, P → E (another team, on no board of the project), and a closed C3.
  issues["P"] = await fake.createIssue({ title: "The billing epic" });
  issues["C1"] = await fake.createIssue({ title: "Billing, part one", parentId: issues["P"].id });
  issues["G1"] = await fake.createIssue({ title: "Billing, part one, first half", parentId: issues["C1"].id });
  issues["H1"] = await fake.createIssue({ title: "Billing, the first quarter; `rm -rf /` stays text", parentId: issues["G1"].id });
  issues["C2"] = await fake.createIssue({ title: "Billing, part two", parentId: issues["P"].id });
  issues["E"] = await fake.createIssue({ title: "Billing, elsewhere", parentId: issues["P"].id, teamId: elsewhere.id });
  // Only the parent is cached when the member opens it: the start reads and caches the rest.
  const parent = issues["P"];
  const row = await harness.test.db.ticket.create({
    data: {
      organizationId: harness.fixture.a.organization.id,
      projectId,
      boardId,
      connectionId,
      externalId: parent.id,
      key: parent.identifier,
      title: "The billing epic",
      statusCategory: "open",
      url: `https://linear.app/ostra-test/issue/${parent.identifier}`,
      open: true,
      trackerUpdatedAt: new Date(),
    },
    select: { id: true },
  });
  parentId = ticketIdSchema.parse(row.id);
}, 120_000);

afterAll(async () => {
  harness.fakes.tracker.adapter = new JiraFakeAdapter({ site: createJiraSite() });
  await fake.close();
  await harness.dispose();
});

const keyOf = (name: string): string => issues[name]?.identifier ?? name;

describe("a parent ticket (F-077)", () => {
  it("F-077/c1: Start sub-issues on a three-level tree starts only its leaves, and lists the child on another team", async () => {
    const started = await (await member()).tickets.startSubIssues({ ticketId: parentId, requestKey: "start-1" });
    expect(started.result).toBe("started");
    expect(started.outcomes.map((outcome) => [outcome.key, outcome.state]).sort()).toEqual([[keyOf("C2"), "started"], [keyOf("H1"), "started"]].sort());
    expect(started.skipped).toEqual([{ key: keyOf("E"), reason: "not-on-a-board" }]);
    // The parent and the middle tickets have no code task; the leaves have one each.
    const tasks = await harness.test.db.task.findMany({ where: { projectId, kind: "code" }, select: { ticket: { select: { key: true } }, parentTicketId: true } });
    expect(tasks.map((task) => task.ticket?.key).sort()).toEqual([keyOf("C2"), keyOf("H1")].sort());
    expect(tasks.every((task) => task.parentTicketId === parentId)).toBe(true);
    // Asked again, nothing starts twice.
    const again = await (await member()).tickets.startSubIssues({ ticketId: parentId, requestKey: "start-2" });
    expect(again.outcomes.map((outcome) => outcome.state)).toEqual(["skipped", "skipped"]);
    expect(again.outcomes.every((outcome) => outcome.reason === "has-task")).toBe(true);
    expect(await harness.test.db.task.count({ where: { projectId, kind: "code" } })).toBe(2);
    // The parent itself never gets a code task.
    expect((await trpcFailure((await member()).tasks.startFromTicket({ projectId, ticketId: parentId }))).code).toBe("PRECONDITION_FAILED");
  });

  it("F-077/c2: the parent's page lists its three levels with each child's task, the children on no board, and its refine task", async () => {
    // The parent's own refine task, a member's.
    const refine = await harness.test.db.task.create({
      data: { organizationId: harness.fixture.a.organization.id, projectId, kind: "refine", source: "ticket", ticketId: parentId, ticketKey: keyOf("P"), boardId, title: "Refine the billing epic", branchName: "ostra/refine-billing", state: "needs_you", needsYouReason: "draft_ready" },
      select: { id: true },
    });
    const page = await (await member()).tickets.parent({ ticketId: parentId });
    expect(page.ticket).toMatchObject({ id: parentId, key: keyOf("P"), projectId });
    expect(page).toMatchObject({ source: "tracker", depth: 3, start: { kind: "leaves", tasks: 2 } });
    const byKey = new Map(page.children.map((child) => [child.key, child] as const));
    expect(page.children.map((child) => [child.key, child.depth, child.parentKey])).toEqual([
      [keyOf("C1"), 1, keyOf("P")],
      [keyOf("G1"), 2, keyOf("C1")],
      [keyOf("H1"), 3, keyOf("G1")],
      [keyOf("C2"), 1, keyOf("P")],
      [keyOf("E"), 1, keyOf("P")],
    ]);
    expect(byKey.get(keyOf("C1"))).toMatchObject({ place: "board", leaf: false, skipped: null, task: null });
    expect(byKey.get(keyOf("H1"))).toMatchObject({ place: "board", leaf: true, skipped: null, title: "Billing, the first quarter; `rm -rf /` stays text", task: { state: "queued", needsYou: null, prs: [] } });
    expect(byKey.get(keyOf("C2"))?.task?.state).toBe("queued");
    expect(byKey.get(keyOf("E"))).toMatchObject({ place: "elsewhere", ticketId: null, leaf: true, skipped: "not-on-a-board", task: null });
    expect(page.refineTask).toEqual({ id: taskIdSchema.parse(refine.id), shortId: refine.id.replaceAll("-", "").slice(-8), state: "needs_you" });

    // A child's task moves, and its PR shows: the page follows.
    const leafTask = await harness.test.db.task.findFirstOrThrow({ where: { ticket: { key: keyOf("C2") }, kind: "code" }, include: { repos: true } });
    await harness.test.db.task.update({ where: { id: leafTask.id }, data: { state: "needs_you", needsYouReason: "question" } });
    const repo = leafTask.repos[0];
    expect(repo).toBeDefined();
    if (repo !== undefined) {
      await harness.test.db.taskRepo.update({ where: { id: repo.id }, data: { prNumber: 42, prUrl: "https://github.example/ostra-test/test1/pull/42", state: "pr_open" } });
    }
    const moved = await (await member()).tickets.parent({ ticketId: parentId });
    expect(moved.children.find((child) => child.key === keyOf("C2"))?.task).toMatchObject({
      state: "needs_you",
      needsYou: "question",
      prs: [{ repo: "ostra-test/test1", number: 42, url: "https://github.example/ostra-test/test1/pull/42", state: "pr_open" }],
    });
  });

  it("F-077/c2: with the tracker out of reach, the page reads the cache, and still names what a start would start", async () => {
    await harness.test.db.connection.update({ where: { id: connectionId }, data: { state: "failed" } });
    try {
      const page = await (await member()).tickets.parent({ ticketId: parentId });
      expect(page.source).toBe("cache");
      // The cached children (the start cached them); the other team's child was never cached here.
      expect(page.children.map((child) => child.key)).toEqual([keyOf("C1"), keyOf("G1"), keyOf("H1"), keyOf("C2")]);
      expect(page.start).toEqual({ kind: "leaves", tasks: 2 });
    } finally {
      await harness.test.db.connection.update({ where: { id: connectionId }, data: { state: "active" } });
    }
  });

  it("F-077/c2: a parent's page is the project's: another organization's member, and one who can't open the project, see nothing", async () => {
    const { a, b } = harness.fixture;
    const other = await harness.as(b.admin);
    expect((await trpcFailure(other.tickets.parent({ ticketId: parentId }))).code).toBe("NOT_FOUND");
    expect((await trpcFailure(other.tickets.startSubIssues({ ticketId: parentId, requestKey: "theirs" }))).code).toBe("NOT_FOUND");
    await harness.test.db.project.update({ where: { id: projectId }, data: { access: "restricted" } });
    try {
      const outsider = await harness.as(a.member);
      expect((await trpcFailure(outsider.tickets.parent({ ticketId: parentId }))).code).toBe("NOT_FOUND");
      expect((await trpcFailure(outsider.tickets.startSubIssues({ ticketId: parentId, requestKey: "hidden" }))).code).toBe("NOT_FOUND");
      expect((await (await harness.as(a.admin)).tickets.parent({ ticketId: parentId })).ticket.id).toBe(parentId);
    } finally {
      await harness.test.db.project.update({ where: { id: projectId }, data: { access: "open" } });
    }
  });
});
