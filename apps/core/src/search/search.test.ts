import { randomBytes } from "node:crypto";

import { createLogger, silentLogger } from "@ostra/adapter-sdk";
import { createTestDatabase, seedInstallation, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import { appendServerEvent, cutSearchText, ingestEvents, postgresChangeNotices, SEARCH_CUT_MARK, searchTasks, systemClock, updateTicketSearchEntries, writeTaskSearchEntries } from "@ostra/domain";
import type { MemberScope } from "@ostra/domain";
import { createJobs, jobIdSchema } from "@ostra/jobs";
import type { Jobs } from "@ostra/jobs";
import { clientMessageIdSchema, memberIdSchema, organizationIdSchema, projectIdSchema, repoIdSchema, segmentIdSchema, toolCallIdSchema, turnIdSchema } from "@ostra/protocol";
import type { OrganizationId, ProjectId, RepoId, TaskEvent } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RunnerRef } from "../gateway/context.ts";
import { runnerEvent, seedLeasedTask, seedRunner } from "../testing/seed.ts";
import type { LeasedTask } from "../testing/seed.ts";
import { enqueueSearchBackfill, searchBackfillHandler } from "./backfill.ts";

// Milestone 4, ticket 11 (F-080, ADR 0054): search entries written at ingest and by the server's
// own events, the query with access in it, and the backfill. A fixture of messages, commands and
// paths with code identifiers, two languages and near misses: each search finds its task and not
// the near miss beside it.

let test: TestDatabase;
let fixture: IsolationFixture;
let jobs: Jobs;
let runnerA: RunnerRef;
let runnerB: RunnerRef;
let orgA: OrganizationId;
let open: ProjectId;
let test1: RepoId;
let test2: RepoId;

/** The task that should be found, and the near misses beside it. */
let found: LeasedTask;
let nearMiss: LeasedTask;
let hidden: LeasedTask;
let otherOrg: LeasedTask;

const turnId = turnIdSchema.parse("turn-1");
const said = (segment: string, text: string): TaskEvent => ({ kind: "agent.message", turnId, segmentId: segmentIdSchema.parse(segment), text });
type ToolInput = Extract<TaskEvent, { readonly kind: "tool.called" }>["input"];
const ran = (call: string, title: string, input: ToolInput): TaskEvent => ({ kind: "tool.called", turnId, toolCallId: toolCallIdSchema.parse(call), toolKind: "execute", title, input });
const thought = (text: string): TaskEvent => ({ kind: "agent.thought", turnId, segmentId: segmentIdSchema.parse(`t-${String(text.length)}`), text });

const ingest = (task: LeasedTask, runner: RunnerRef, events: readonly TaskEvent[]) =>
  test.db.$transaction((tx) =>
    ingestEvents({ tx, jobs, notices: postgresChangeNotices, clock: systemClock }, { runnerId: runner.runnerId, events: events.map((event, index) => runnerEvent(task, index + 1, event)) }),
  );

/** A member's message, through the server's one writer of its events. */
const memberSays = (task: LeasedTask, memberId: string, text: string) =>
  test.db.$transaction((tx) =>
    appendServerEvent(tx, {
      organizationId: task.organizationId,
      projectId: task.projectId,
      taskId: task.taskId,
      sessionId: task.sessionId,
      at: Date.now(),
      event: { kind: "user.message", memberId: memberIdSchema.parse(memberId), clientMessageId: clientMessageIdSchema.parse(randomBytes(8).toString("hex")), text, delivery: "queued" },
    }),
  );

const repoIn = async (projectId: string, organizationId: string, name: string): Promise<RepoId> => {
  const connection = await test.db.connection.findFirst({ where: { organizationId, kind: "github" } });
  const connectionId = connection?.id ?? (await test.db.connection.create({ data: { organizationId, kind: "github", appId: "5821041", slug: "ostra-test" } })).id;
  await seedInstallation(test.db, { organizationId, connectionId, installationId: "1" });
  const repo = await test.db.repo.create({
    data: { organizationId, projectId, connectionId, installationId: "1", hostRepoId: name, fullName: `ostra-test/${name}`, defaultBranch: "main", checkoutDir: name },
  });
  return repoIdSchema.parse(repo.id);
};

const onRepo = async (task: LeasedTask, repoId: RepoId) => {
  const row = await test.db.task.findUniqueOrThrow({ where: { id: task.taskId } });
  await test.db.taskRepo.create({ data: { organizationId: task.organizationId, projectId: task.projectId, taskId: task.taskId, repoId, branchName: row.branchName, baseBranch: "main" } });
};

/** A task as its creation leaves it: its entries for the title, the prompt and the ticket. */
const created = async (runner: RunnerRef, projectId: ProjectId, input: { readonly title: string; readonly ticket?: string; readonly creator: string; readonly state?: "running" | "stopped" }) => {
  const task = await seedLeasedTask(test.db, runner, projectId, { state: "running", creatorMemberId: input.creator });
  await test.db.task.update({ where: { id: task.taskId }, data: { title: input.title, ticketKey: input.ticket ?? null, ...(input.state === "stopped" ? { state: "stopped", stoppedReason: "requested" } : {}) } });
  await test.db.$transaction((tx) =>
    writeTaskSearchEntries(tx, {
      organizationId: task.organizationId,
      projectId,
      taskId: task.taskId,
      title: input.title,
      prompt: `Please: ${input.title}`,
      ticket: input.ticket === undefined ? null : { key: input.ticket, title: input.title },
      creatorMemberId: memberIdSchema.parse(input.creator),
    }),
  );
  return task;
};

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
  await jobs.start();
  orgA = organizationIdSchema.parse(fixture.a.organization.id);
  open = projectIdSchema.parse(fixture.a.openProject.id);
  runnerA = await seedRunner(test.db, orgA, fixture.a.member.id);
  runnerB = await seedRunner(test.db, fixture.b.organization.id, fixture.b.admin.id);
  test1 = await repoIn(open, orgA, "test1");
  test2 = await repoIn(open, orgA, "test2");

  found = await created(runnerA, open, { title: "Fix the login redirect", ticket: "ENG-12", creator: fixture.a.member.id });
  await onRepo(found, test1);
  await ingest(found, runnerA, [
    said("s1", "I'll migrate the schema and add the priceSource column to the model table."),
    ran("c1", "Run the tests", { command: "pnpm vitest run src/calc.test.ts", cwd: "/workspace/test1" }),
    ran("c2", "Read a file", { path: "packages/db/prisma/schema.prisma" }),
    ran("c3", "Fetch the docs", { url: "https://docs.example.com/guide/install" }),
    thought("a thought about zebrafish that search must never hold"),
  ]);
  await memberSays(found, fixture.a.member.id, "Bitte auch die README aktualisieren, danke");

  nearMiss = await created(runnerA, open, { title: "Fix the logout redirect", ticket: "ENG-121", creator: fixture.a.insider.id, state: "stopped" });
  await onRepo(nearMiss, test2);
  await ingest(nearMiss, runnerA, [
    said("s1", "The price source moved; I'll migrate nothing yet."),
    ran("c1", "Build", { command: "pnpm vite build", cwd: "/workspace/test2" }),
    ran("c2", "Read a file", { path: "packages/db/prisma/seed.ts" }),
    ran("c3", "Fetch", { url: "https://other.example.org/page" }),
  ]);
  await memberSays(nearMiss, fixture.a.insider.id, "Please update the CHANGELOG");

  hidden = await created(runnerA, projectIdSchema.parse(fixture.a.restrictedProject.id), { title: "Secret login redirect work", ticket: "ENG-12", creator: fixture.a.insider.id });
  await ingest(hidden, runnerA, [said("s1", "migrate priceSource vitest schema.prisma README")]);

  otherOrg = await created(runnerB, projectIdSchema.parse(fixture.b.project.id), { title: "Fix the login redirect", ticket: "ENG-12", creator: fixture.b.admin.id });
  await ingest(otherOrg, runnerB, [said("s1", "migrate priceSource vitest schema.prisma README"), ran("c1", "Run", { command: "pnpm vitest run" })]);
});

afterAll(async () => {
  await jobs.stop({ graceful: false, timeoutMs: 2_000 });
  await test.dispose();
});

const memberOfA = (): MemberScope => ({ organizationId: orgA, memberId: memberIdSchema.parse(fixture.a.member.id), role: "member", projectRoles: new Map() });
const none = { text: null, ticketKey: null, repoId: null, memberId: null, state: null, limit: 20 } as const;

const ids = async (input: Partial<Parameters<typeof searchTasks>[2]>, scope: MemberScope = memberOfA()) =>
  (await searchTasks(test.db, scope, { ...none, ...input })).map((result) => result.taskId);

describe("finding a task (F-080)", () => {
  it("F-080: finds a task by its ticket, and not the ticket whose key only starts the same", async () => {
    expect(await ids({ ticketKey: "ENG-12" })).toEqual([found.taskId]);
    expect(await ids({ ticketKey: "ENG-121" })).toEqual([nearMiss.taskId]);
    expect(await ids({ text: "ENG-12" })).toContain(found.taskId);
  });

  it("F-080: finds a task by its repo, and not the task on the other repo", async () => {
    expect(await ids({ repoId: test1 })).toEqual([found.taskId]);
    expect(await ids({ repoId: test2 })).toEqual([nearMiss.taskId]);
  });

  it("F-080: finds a task by its member (creator, driver or a message's author), and not another member's", async () => {
    expect(await ids({ memberId: memberIdSchema.parse(fixture.a.member.id) })).toEqual([found.taskId]);
    expect(await ids({ memberId: memberIdSchema.parse(fixture.a.insider.id) })).toEqual([nearMiss.taskId]);
  });

  it("F-080: finds a task by its state, and not a task in another state", async () => {
    expect(await ids({ state: "running" })).toEqual([found.taskId]);
    expect(await ids({ state: "stopped" })).toEqual([nearMiss.taskId]);
  });

  it("F-080: finds a word of a message, the last word as a prefix, and not a near miss", async () => {
    expect(await ids({ text: "priceSource" })).toEqual([found.taskId]);
    expect(await ids({ text: "pricesou" })).toEqual([found.taskId]);
    expect(await ids({ text: "README aktualisieren" })).toEqual([found.taskId]);
    expect(await ids({ text: "CHANGELOG" })).toEqual([nearMiss.taskId]);
    // "migr" finds both "migrate"s; with "schema" it's the one task that has both.
    expect(new Set(await ids({ text: "migr" }))).toEqual(new Set([found.taskId, nearMiss.taskId]));
    expect(await ids({ text: "schema migr" })).toEqual([found.taskId]);
  });

  it("F-080: finds a command, and not the near miss whose command only starts the same", async () => {
    expect(await ids({ text: "vitest" })).toEqual([found.taskId]);
    // "vite" as a prefix finds both; as a phrase, only the build.
    expect(new Set(await ids({ text: "vite" }))).toEqual(new Set([found.taskId, nearMiss.taskId]));
    expect(await ids({ text: "\"vite build\"" })).toEqual([nearMiss.taskId]);
  });

  it("F-080: finds a path and a URL a tool call touched, and not the near misses", async () => {
    expect(await ids({ text: "schema.prisma" })).toEqual([found.taskId]);
    expect(await ids({ text: "seed.ts" })).toEqual([nearMiss.taskId]);
    expect(await ids({ text: "docs.example.com" })).toEqual([found.taskId]);
  });

  it("F-080: a thought, a tool's output and partial text are never searched", async () => {
    expect(await ids({ text: "zebrafish" })).toEqual([]);
    expect(await test.db.searchEntry.count({ where: { taskId: found.taskId, text: { contains: "zebrafish" } } })).toBe(0);
  });

  it("F-080: results are tasks, each once, best first, with at most three snippets that say what matched and where", async () => {
    const [first, ...rest] = await searchTasks(test.db, memberOfA(), { ...none, text: "redirect" });
    expect(rest.map((result) => result.taskId)).not.toContain(first?.taskId);
    const [result] = await searchTasks(test.db, memberOfA(), { ...none, text: "priceSource" });
    expect(result?.snippets.length).toBeGreaterThan(0);
    expect(result?.snippets.length).toBeLessThanOrEqual(3);
    const snippet = result?.snippets[0];
    expect(snippet?.kind).toBe("agent_message");
    expect(snippet?.eventSeq).toEqual(expect.any(Number));
    expect(snippet?.parts.some((part) => part.match && part.text.toLowerCase() === "pricesource")).toBe(true);
    expect(result?.matched).toEqual(result?.snippets.map((one) => one.entryId));
  });

  it("F-080: a query of filters only lists the member's tasks by recency", async () => {
    expect(await ids({})).toEqual([nearMiss.taskId, found.taskId]);
  });
});

describe("access is in the query (F-080, F-049, F-087)", () => {
  it("F-080: a hidden project's task and another organization's are never returned, ranked or counted", async () => {
    for (const text of ["priceSource", "migrate", "vitest", "schema.prisma", "README", "login redirect"]) {
      const found = await ids({ text });
      expect(found).not.toContain(hidden.taskId);
      expect(found).not.toContain(otherOrg.taskId);
    }
    expect(await ids({ ticketKey: "ENG-12" })).not.toContain(hidden.taskId);
    // One result asked for: the hidden and the foreign matches take no place before it.
    expect(await ids({ text: "priceSource", limit: 1 })).toEqual([found.taskId]);
    // A member of the restricted project sees it; an admin of A sees it; nobody in A sees B's.
    const insider: MemberScope = { organizationId: orgA, memberId: memberIdSchema.parse(fixture.a.insider.id), role: "member", projectRoles: new Map([[projectIdSchema.parse(fixture.a.restrictedProject.id), "member"]]) };
    expect(await ids({ text: "priceSource" }, insider)).toContain(hidden.taskId);
    const admin: MemberScope = { organizationId: orgA, memberId: memberIdSchema.parse(fixture.a.admin.id), role: "admin", projectRoles: new Map() };
    expect(new Set(await ids({ text: "priceSource" }, admin))).toEqual(new Set([found.taskId, hidden.taskId]));
  });
});

describe("the entries (F-080)", () => {
  it("F-080: an entry is cut at 8 KiB with the cut marked, in characters and bytes", () => {
    const cut = cutSearchText("ü".repeat(9000));
    expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(8192);
    expect(cut.endsWith(SEARCH_CUT_MARK)).toBe(true);
    expect(cutSearchText("short")).toBe("short");
  });

  it("F-080: a ticket's new title updates its entry, and search finds the new title", async () => {
    // The fixture's tasks have a key but no cached ticket; one is made for this case.
    const board = await test.db.board.create({
      data: { organizationId: orgA, projectId: open, connectionId: (await test.db.connection.create({ data: { organizationId: orgA, kind: "linear", appId: "lin" } })).id, externalId: "team", name: "Eng", statusMap: {}, key: "ENG" },
    });
    const row = await test.db.ticket.create({
      data: { organizationId: orgA, projectId: open, boardId: board.id, connectionId: board.connectionId, externalId: "ext-12", key: "ENG-12", title: "Fix the login redirect", url: "https://linear.example/ENG-12", trackerUpdatedAt: new Date() },
    });
    await test.db.task.update({ where: { id: found.taskId }, data: { ticketId: row.id, boardId: board.id } });
    await test.db.$transaction((tx) => updateTicketSearchEntries(tx, { organizationId: orgA, ticketId: row.id, key: "ENG-12", title: "Make the login redirect keep the query string" }));
    expect(await ids({ text: "query string" })).toEqual([found.taskId]);
    expect(await test.db.searchEntry.count({ where: { taskId: found.taskId, kind: "ticket" } })).toBe(1);
  });
});

describe("search.backfill (F-080)", () => {
  it("F-080: the backfill writes an old task's entries once, run twice, and a later boot enqueues nothing for it", async () => {
    const old = await seedLeasedTask(test.db, runnerA, open, { state: "running", creatorMemberId: fixture.a.member.id });
    await test.db.task.update({ where: { id: old.taskId }, data: { title: "An old task from before search" } });
    // Its events, as milestone 3 stored them: no entries.
    const events: TaskEvent[] = [said("s1", "the quokka migration is done"), ran("c1", "Run", { command: "make quokka" }), thought("not this")];
    for (const [index, event] of events.entries()) {
      await test.db.event.create({
        data: { organizationId: old.organizationId, projectId: old.projectId, taskId: old.taskId, seq: index + 1, sessionId: old.sessionId, sessionSeq: index + 1, leaseEpoch: 1, kind: event.kind, payload: event, occurredAt: new Date() },
      });
    }
    await test.db.task.update({ where: { id: old.taskId }, data: { eventSeq: events.length } });
    expect(await test.db.searchEntry.count({ where: { taskId: old.taskId } })).toBe(0);

    const enqueued: string[] = [];
    const recorder = {
      enqueueInTx: (_tx: unknown, _job: "search.backfill", payload: { readonly taskId: string }) => {
        enqueued.push(payload.taskId);
        return Promise.resolve();
      },
    };
    expect(await enqueueSearchBackfill({ db: test.db, jobs: recorder, logger: silentLogger })).toBeGreaterThan(0);
    expect(enqueued).toContain(old.taskId);
    expect(enqueued).not.toContain(found.taskId);

    const records: string[] = [];
    const logger = createLogger((record) => records.push(JSON.stringify(record)));
    const run = () =>
      searchBackfillHandler({ db: test.db })({ job: "search.backfill", jobId: jobIdSchema.parse(crypto.randomUUID()), key: null, retryCount: 0, payload: { organizationId: old.organizationId, taskId: old.taskId }, logger });
    await run();
    const first = await test.db.searchEntry.findMany({ where: { taskId: old.taskId }, orderBy: [{ kind: "asc" }, { eventSeq: "asc" }] });
    await run();
    const second = await test.db.searchEntry.findMany({ where: { taskId: old.taskId }, orderBy: [{ kind: "asc" }, { eventSeq: "asc" }] });
    expect(second).toEqual(first);
    expect(first.map((entry) => entry.kind).sort()).toEqual(["agent_message", "prompt", "title", "tool_input"]);
    expect(await ids({ text: "quokka" })).toEqual([old.taskId]);
    // Its progress is logged by IDs and counts, never the text.
    expect(records.join("\n")).toContain("search.backfill-progress");
    expect(records.join("\n")).not.toContain("quokka");

    enqueued.length = 0;
    await enqueueSearchBackfill({ db: test.db, jobs: recorder, logger: silentLogger });
    expect(enqueued).not.toContain(old.taskId);
  });
});
