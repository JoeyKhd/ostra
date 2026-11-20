import { startBulkItem } from "@ostra/domain";
import { bulkStartItemIdSchema, organizationIdSchema } from "@ostra/protocol";
import type { BoardId, ConnectionId, ProjectId, TicketId } from "@ostra/protocol";
import { isTrackedEnvelope } from "@trpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { openStream } from "../stream/subscribe.ts";
import type { StreamMessage } from "../stream/subscribe.ts";
import { createApiHarness, seedBoard, seedConnectionAndModel, seedLinearConnection, seedProject, seedTicket, trpcFailure } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";

// Ticket 25 (F-107, F-010, F-077; ADR 0056): the Inbox's bulk start. At most 50 tickets at once, the
// same request key answering the first request, each item's outcome read back and reaching the
// panel's one stream as it's decided, the project's access as for any start, and each ticket's
// sub-issues: how many tasks a code start on it starts.

let harness: ApiHarness;
let projectId: ProjectId;
let connectionId: ConnectionId;
let boardId: BoardId;
let counter = 0;

const member = () => harness.as(harness.fixture.a.member);

const seedMany = async (count: number, prefix: string): Promise<TicketId[]> => {
  const ids: TicketId[] = [];
  for (let index = 0; index < count; index += 1) {
    counter += 1;
    ids.push(await seedTicket(harness, { projectId, boardId, connectionId, key: `${prefix}-${String(counter)}`, title: `Ticket ${String(counter)}` }));
  }
  return ids;
};

/** Runs every queued `bulk.start-item` job once, as core's worker would. */
const runBulkItems = async (): Promise<number> => {
  const payload = z.object({ organizationId: z.string(), bulkStartItemId: z.string() });
  const queued = harness.fakes.jobs.jobs.filter((recorded) => recorded.job === "bulk.start-item");
  for (const job of queued) {
    const { organizationId, bulkStartItemId } = payload.parse(job.payload);
    await startBulkItem(
      { db: harness.test.db, ...harness.deps.ports, publicUrl: harness.deps.settings.publicUrl },
      { organizationId: organizationIdSchema.parse(organizationId), bulkStartItemId: bulkStartItemIdSchema.parse(bulkStartItemId) },
    );
  }
  harness.fakes.jobs.clear();
  return queued.length;
};

beforeAll(async () => {
  harness = await createApiHarness();
  const world = await seedConnectionAndModel(harness);
  projectId = (await seedProject(harness, world, "bulk")).projectId;
  connectionId = await seedLinearConnection(harness);
  boardId = await seedBoard(harness, { projectId, connectionId, key: "BLK" });
  await harness.hub.start();
}, 120_000);

afterAll(async () => {
  await harness.dispose();
});

describe("the Inbox's bulk start (F-107)", () => {
  it("F-107/c1, F-010/c2: 50 tickets start at once from the Inbox, and 51 are refused with nothing written", async () => {
    const tickets = await seedMany(51, "BLK");
    harness.fakes.jobs.clear();
    const refused = await trpcFailure((await member()).inbox.startMany({ projectId, ticketIds: tickets, kind: "code", agentProfileId: null, requestKey: "fifty-one" }));
    expect(refused).toMatchObject({ code: "BAD_REQUEST", message: "At most 50 tickets start at once" });
    expect(await harness.test.db.bulkStart.count({ where: { projectId } })).toBe(0);
    expect(harness.fakes.jobs.jobs).toEqual([]);

    const fifty = tickets.slice(0, 50);
    const { bulkStartId } = await (await member()).inbox.startMany({ projectId, ticketIds: fifty, kind: "code", agentProfileId: null, requestKey: "fifty" });
    expect(await runBulkItems()).toBe(50);
    const view = await (await member()).inbox.bulkStart({ projectId, bulkStartId });
    expect(view).toMatchObject({ source: "inbox", kind: "code", requested: 50, done: true, counts: { pending: 0, started: 50, skipped: 0, failed: 0 } });
    expect(new Set(view.items.map((item) => item.ticket.id))).toEqual(new Set(fifty));
    expect(view.items.every((item) => item.task !== null && item.reason === null)).toBe(true);
    expect(await harness.test.db.task.count({ where: { bulkStartId, kind: "code" } })).toBe(50);
  });

  it("F-107/c1: a replayed request key returns the same bulk start, and starts nothing twice", async () => {
    const tickets = await seedMany(3, "RPL");
    harness.fakes.jobs.clear();
    const request = { projectId, ticketIds: tickets, kind: "code" as const, agentProfileId: null, requestKey: "double-click" };
    const first = await (await member()).inbox.startMany(request);
    const again = await (await member()).inbox.startMany(request);
    expect(again).toEqual(first);
    expect(await harness.test.db.bulkStart.count({ where: { requestKey: "double-click" } })).toBe(1);
    expect(harness.fakes.jobs.jobs.filter((job) => job.job === "bulk.start-item")).toHaveLength(3);
    await runBulkItems();
    // The worker's replay finds each item decided; a third press is still the first one.
    expect(await (await member()).inbox.startMany(request)).toEqual(first);
    expect(harness.fakes.jobs.jobs).toEqual([]);
    expect(await harness.test.db.task.count({ where: { ticketId: { in: tickets } } })).toBe(3);
  });

  it("F-107/c1: each item's outcome streams to the panel as it's decided: started, or skipped with its reason", async () => {
    const [fresh, held] = await seedMany(2, "STR");
    if (fresh === undefined || held === undefined) throw new Error("no tickets");
    // A member's own task already holds one of them.
    await (await member()).tasks.startFromTicket({ projectId, ticketId: held });
    harness.fakes.jobs.clear();
    const { bulkStartId } = await (await member()).inbox.startMany({ projectId, ticketIds: [fresh, held], kind: "code", agentProfileId: null, requestKey: "stream" });
    const pending = await (await member()).inbox.bulkStart({ projectId, bulkStartId });
    expect(pending).toMatchObject({ done: false, counts: { pending: 2, started: 0 } });

    const context = await harness.contextOf(harness.fixture.a.member);
    const scope = context.member?.scope;
    if (scope === undefined) throw new Error("no member scope");
    const controller = new AbortController();
    const seen: StreamMessage[] = [];
    const finished = (async () => {
      for await (const value of openStream({ ...context, scope }, {}, controller.signal)) {
        seen.push(isTrackedEnvelope(value) ? value[1] : value);
      }
    })();
    // The stream is open before anything is decided.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await runBulkItems();
    const deadline = Date.now() + 8000;
    const projectNotices = () => seen.filter((message) => message.type === "change" && message.entity === "project" && message.entityId === projectId);
    while (projectNotices().length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    controller.abort();
    await finished;
    expect(projectNotices().length).toBeGreaterThan(0);

    const decided = await (await member()).inbox.bulkStart({ projectId, bulkStartId });
    expect(decided).toMatchObject({ done: true, counts: { pending: 0, started: 1, skipped: 1, failed: 0 } });
    const byTicket = new Map(decided.items.map((item) => [item.ticket.id, item] as const));
    expect(byTicket.get(fresh)).toMatchObject({ state: "started", reason: null, task: { state: "queued" } });
    expect(byTicket.get(held)).toMatchObject({ state: "skipped", reason: "has-task", task: null });
  });

  it("F-107/c1: a bulk start is the project's: a member who can't open it starts and reads nothing", async () => {
    const { a, b } = harness.fixture;
    const [ticket] = await seedMany(1, "ACC");
    if (ticket === undefined) throw new Error("no ticket");
    harness.fakes.jobs.clear();
    const { bulkStartId } = await (await member()).inbox.startMany({ projectId, ticketIds: [ticket], kind: "code", agentProfileId: null, requestKey: "access" });
    const other = await harness.as(b.admin);
    expect((await trpcFailure(other.inbox.startMany({ projectId, ticketIds: [ticket], kind: "code", agentProfileId: null, requestKey: "theirs" }))).code).toBe("NOT_FOUND");
    expect((await trpcFailure(other.inbox.bulkStart({ projectId, bulkStartId }))).code).toBe("NOT_FOUND");
    expect((await trpcFailure((await member()).inbox.startMany({ projectId: a.restrictedProject.id, ticketIds: [ticket], kind: "code", agentProfileId: null, requestKey: "restricted" }))).code).toBe("NOT_FOUND");
    // Another project's ticket is no ticket of this one.
    expect((await trpcFailure((await harness.as(a.admin)).inbox.startMany({ projectId: a.openProject.id, ticketIds: [ticket], kind: "code", agentProfileId: null, requestKey: "elsewhere" }))).code).toBe("NOT_FOUND");
    expect((await trpcFailure((await harness.as(a.admin)).inbox.bulkStart({ projectId: a.openProject.id, bulkStartId }))).code).toBe("NOT_FOUND");
    expect(harness.fakes.jobs.jobs.filter((job) => job.job === "bulk.start-item")).toHaveLength(1);
  });
});

describe("the Inbox's sub-issues (F-077, F-010)", () => {
  it("F-077/c2, F-010/c2: the Inbox says how many tasks a code start on a parent starts: one per leaf on the project's boards", async () => {
    const parent = await seedTicket(harness, { projectId, boardId, connectionId, key: "PAR-1", title: "An epic" });
    const parentRow = await harness.test.db.ticket.findUniqueOrThrow({ where: { id: parent } });
    const childOf = async (key: string, parentExternalId: string, fields: { readonly open?: boolean; readonly board?: BoardId } = {}) => {
      const id = await seedTicket(harness, { projectId, boardId: fields.board ?? boardId, connectionId, key, ...(fields.open === false ? { open: false, statusCategory: "done" as const, statusId: "s-done" } : {}) });
      const row = await harness.test.db.ticket.update({ where: { id }, data: { parentExternalId }, select: { externalId: true } });
      return row.externalId;
    };
    // PAR-1 → PAR-2 (→ PAR-4, PAR-5), PAR-3; a closed PAR-6.
    const two = await childOf("PAR-2", parentRow.externalId);
    await childOf("PAR-3", parentRow.externalId);
    await childOf("PAR-4", two);
    await childOf("PAR-5", two);
    await childOf("PAR-6", parentRow.externalId, { open: false });
    const list = await (await member()).inbox.list({ projectId, text: "PAR-" });
    const byKey = new Map(list.tickets.map((ticket) => [ticket.key, ticket] as const));
    expect(byKey.get("PAR-1")).toMatchObject({ subIssues: 2, codeStart: { tasks: 3, overLimit: false } });
    expect(byKey.get("PAR-2")).toMatchObject({ subIssues: 2, codeStart: { tasks: 2, overLimit: false } });
    expect(byKey.get("PAR-3")).toMatchObject({ subIssues: 0, codeStart: { tasks: 1, overLimit: false } });
    expect((await (await member()).inbox.get({ projectId, ticketId: parent })).codeStart).toEqual({ tasks: 3, overLimit: false });
  });
});
