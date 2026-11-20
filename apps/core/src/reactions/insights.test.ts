import { createLogger } from "@ostra/adapter-sdk";
import { createTestDatabase, seedIsolationFixture } from "@ostra/db/testing";
import type { IsolationFixture, TestDatabase } from "@ostra/db/testing";
import {
  computeInsights,
  insightWaitingByReasonSchema,
  medianTimeToFirstPr,
  mergeRate,
  prsClosedUnmerged,
  prsMerged,
  prsOpened,
  timeWaiting,
  waitingDurationsByReason,
  waitingFromDurations,
} from "@ostra/domain";
import type { Clock, InsightPullRequest, InsightTask, InsightWaitingItem } from "@ostra/domain";
import { createJobs } from "@ostra/jobs";
import { organizationIdSchema, repoIdSchema, taskIdSchema } from "@ostra/protocol";
import type { OrganizationId, TaskId } from "@ostra/protocol";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FakeCodeHost, FakeSecretStore } from "../testing/fake-adapters.ts";
import { jobContext } from "../testing/turns.ts";
import { seedQueuedTask, seedWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";
import { ensureInsightsSchedule, insightsComputeHandler, insightsCron } from "./insights.ts";

// Ticket 14 (F-108, ADR 0055, ADR 0035): the Insights job, against a real database. A fixture of
// tasks, PRs (merged, closed unmerged, open) and needs-you items of several reasons, with edges on
// UTC midnight, is computed by `insights.compute`; every stored day and task must equal what ticket
// 06's reference definitions say over the same rows. A second run writes nothing, and a PR merged
// after a run shows after the next one.

let test: TestDatabase;
let fixture: IsolationFixture;
let organizationId: OrganizationId;
let open: World;
let restricted: World;
let other: World;
const codeHost = new FakeCodeHost();
const secretStore = new FakeSecretStore();
const logger = createLogger(() => undefined);

const DAY = 86_400_000;
const D0 = Date.UTC(2026, 10, 10);
const D1 = D0 + DAY;
const D2 = D1 + DAY;
const at = (day: number, hours: number, minutes = 0): number => day + hours * 3_600_000 + minutes * 60_000;

let now = at(D2, 12);
const clock: Clock = { now: () => now };

type Seeded = { readonly taskId: TaskId; readonly taskRepoId: string };

const task = async (world: World, createdAt: number, kind: "code" | "refine" = "code"): Promise<Seeded> => {
  const member = world === other ? fixture.b.admin : fixture.a.member;
  const seeded = await seedQueuedTask(test.db, world, member, null);
  await test.db.task.update({ where: { id: seeded.taskId }, data: { createdAt: new Date(createdAt), kind } });
  const taskRepo = await test.db.taskRepo.findFirstOrThrow({ where: { taskId: seeded.taskId } });
  return { taskId: seeded.taskId, taskRepoId: taskRepo.id };
};

let prNumber = 100;
const pr = async (seeded: Seeded, openedAt: number, end: { readonly state: "merged" | "closed_unmerged"; readonly at: number } | null = null): Promise<string> => {
  const row = await test.db.taskRepo.findUniqueOrThrow({ where: { id: seeded.taskRepoId } });
  prNumber += 1;
  const created = await test.db.taskPullRequest.create({
    data: {
      organizationId: row.organizationId,
      projectId: row.projectId,
      taskRepoId: row.id,
      number: prNumber,
      url: `https://github.com/ostra-test/test1/pull/${String(prNumber)}`,
      branchName: row.branchName,
      state: end?.state ?? "open",
      openedAt: new Date(openedAt),
      closedAt: end === null ? null : new Date(end.at),
    },
  });
  return created.id;
};

const item = async (seeded: Seeded, reason: "question" | "approval" | "plan" | "crashed", createdAt: number, endedAt: number | null): Promise<void> => {
  const row = await test.db.task.findUniqueOrThrow({ where: { id: seeded.taskId } });
  await test.db.needsYouItem.create({
    data: {
      organizationId: row.organizationId,
      projectId: row.projectId,
      taskId: row.id,
      reason,
      audience: "driver",
      state: endedAt === null ? "open" : reason === "crashed" ? "dismissed" : "answered",
      createdAt: new Date(createdAt),
      resolvedAt: endedAt === null ? null : new Date(endedAt),
    },
  });
};

beforeAll(async () => {
  test = await createTestDatabase();
  fixture = await seedIsolationFixture(test.db);
  organizationId = organizationIdSchema.parse(fixture.a.organization.id);
  open = await seedWorld(test.db, { codeHost, secretStore }, fixture.a.organization.id, fixture.a.openProject.id);
  // The restricted project shares the open project's connection, profile and installation.
  const openRepo = await test.db.repo.findUniqueOrThrow({ where: { id: open.repoId } });
  const restrictedRepo = await test.db.repo.create({
    data: {
      organizationId,
      projectId: fixture.a.restrictedProject.id,
      connectionId: openRepo.connectionId,
      installationId: openRepo.installationId,
      hostRepoId: "host-ostra-test/test2",
      fullName: "ostra-test/test2",
      defaultBranch: "main",
      checkoutDir: "test2",
    },
  });
  restricted = { ...open, projectId: fixture.a.restrictedProject.id, repoId: restrictedRepo.id };
  other = await seedWorld(test.db, { codeHost, secretStore }, fixture.b.organization.id, fixture.b.project.id, { fullName: "other-org/repo" });

  // The open project: two code tasks and a refine task.
  const t1 = await task(open, at(D0, 8));
  const t2 = await task(open, at(D0, 9));
  const t4 = await task(open, at(D1, 2), "refine");
  await pr(t1, at(D0, 10), { state: "merged", at: D1 }); // merged at midnight exactly: D1's
  await pr(t1, at(D1, 12)); // a second PR of the same task, still open
  await pr(t2, D1 - 1, { state: "closed_unmerged", at: at(D2, 3) }); // opened in D0's last millisecond
  await pr(t4, at(D1, 4), { state: "merged", at: at(D1, 6) }); // a refine task's PR: no time to a first PR
  await item(t1, "question", at(D0, 10), D1 - 1); // ended in D0's last millisecond
  await item(t2, "approval", at(D0, 22), D1); // ended at midnight exactly: D1's
  await item(t2, "approval", at(D1, 10), at(D1, 11));
  await item(t1, "crashed", at(D2, 2), null); // still open: not counted
  // The restricted project: one code task whose PR is still open.
  const t3 = await task(restricted, at(D1, 1));
  await pr(t3, at(D1, 5));
  await item(t3, "plan", at(D1, 6), at(D2, 1));
  // Another organization, on the same days: never in organization A's rows.
  const tb = await task(other, at(D0, 7));
  await pr(tb, at(D0, 8), { state: "merged", at: at(D0, 9) });
  await item(tb, "question", at(D1, 7), at(D1, 8));
});

afterAll(async () => {
  await test.dispose();
});

// ---- the reference, over the rows themselves ----

const sourceRows = async (organization: string, projectId: string | null) => {
  const scope = { organizationId: organization, ...(projectId === null ? {} : { projectId }) };
  const [prRows, itemRows, taskRows] = await Promise.all([
    test.db.taskPullRequest.findMany({ where: scope, include: { taskRepo: true } }),
    test.db.needsYouItem.findMany({ where: scope }),
    test.db.task.findMany({ where: scope }),
  ]);
  const prs: InsightPullRequest[] = prRows.map((row) => ({
    taskId: taskIdSchema.parse(row.taskRepo.taskId),
    repoId: repoIdSchema.parse(row.taskRepo.repoId),
    openedAt: row.openedAt.getTime(),
    mergedAt: row.state === "merged" ? (row.closedAt?.getTime() ?? null) : null,
    closedUnmergedAt: row.state === "closed_unmerged" ? (row.closedAt?.getTime() ?? null) : null,
  }));
  const items: InsightWaitingItem[] = itemRows.map((row) => ({ reason: row.reason, createdAt: row.createdAt.getTime(), endedAt: row.resolvedAt?.getTime() ?? null }));
  const tasks: InsightTask[] = taskRows.map((row) => ({ taskId: taskIdSchema.parse(row.id), kind: row.kind, createdAt: row.createdAt.getTime() }));
  return { prs, items, tasks };
};

const storedDay = async (organization: string, projectId: string | null, day: number) => {
  const row = await test.db.insightDaily.findFirst({ where: { organizationId: organization, projectId, day: new Date(day) } });
  return {
    prsOpened: row?.prsOpened ?? 0,
    prsMerged: row?.prsMerged ?? 0,
    prsClosedUnmerged: row?.prsClosedUnmerged ?? 0,
    waitingMs: Number(row?.waitingMs ?? 0n),
    waitingItems: row?.waitingItems ?? 0,
    waitingByReason: insightWaitingByReasonSchema.parse(row?.waitingByReason ?? {}),
  };
};

const expectedDay = async (organization: string, projectId: string | null, day: number) => {
  const { prs, items } = await sourceRows(organization, projectId);
  const period = { start: day, end: day + DAY };
  const waiting = timeWaiting(items, period);
  const byReason = waitingDurationsByReason(items, period);
  return {
    prsOpened: prsOpened(prs, period),
    prsMerged: prsMerged(prs, period),
    prsClosedUnmerged: prsClosedUnmerged(prs, period),
    waitingMs: waiting.totalMs,
    waitingItems: waiting.count,
    waitingByReason: Object.fromEntries(Object.entries(byReason).sort(([x], [y]) => x.localeCompare(y))),
  };
};

const scopes = (): readonly { readonly organization: string; readonly projectId: string | null }[] => [
  { organization: fixture.a.organization.id, projectId: null },
  { organization: fixture.a.organization.id, projectId: open.projectId },
  { organization: fixture.a.organization.id, projectId: restricted.projectId },
  { organization: fixture.b.organization.id, projectId: null },
  { organization: fixture.b.organization.id, projectId: other.projectId },
];

const snapshot = async () => ({
  days: await test.db.insightDaily.findMany({ orderBy: [{ organizationId: "asc" }, { day: "asc" }, { projectId: "asc" }] }),
  metrics: await test.db.taskMetric.findMany({ orderBy: { taskId: "asc" } }),
});

const run = () => insightsComputeHandler({ db: test.db, clock })(jobContext("insights.compute", {}, logger));

describe("the Insights job (F-108)", () => {
  it("F-108/c1,c2: each stored day equals ticket 06's reference, for the organization and each project, across midnight's edges", async () => {
    await run();
    for (const { organization, projectId } of scopes()) {
      for (const day of [D0 - DAY, D0, D1, D2]) {
        expect({ organization, projectId, day: new Date(day).toISOString(), ...(await storedDay(organization, projectId, day)) }).toEqual({
          organization,
          projectId,
          day: new Date(day).toISOString(),
          ...(await expectedDay(organization, projectId, day)),
        });
      }
    }
    // The edges, by hand: the merge at midnight is D1's, the PR opened in D0's last millisecond is D0's.
    expect(await storedDay(fixture.a.organization.id, open.projectId, D0)).toMatchObject({ prsOpened: 2, prsMerged: 0, waitingItems: 1 });
    expect(await storedDay(fixture.a.organization.id, open.projectId, D1)).toMatchObject({ prsOpened: 2, prsMerged: 2, waitingItems: 2 });
    expect(await storedDay(fixture.a.organization.id, null, D2)).toMatchObject({ prsClosedUnmerged: 1, waitingItems: 1 });
    expect(await test.db.insightRun.findUniqueOrThrow({ where: { organizationId } })).toMatchObject({ lastRunAt: new Date(now) });
  });

  it("F-108/c1: the six figures over a period, read from the stored rows, equal the reference's", async () => {
    const period = { start: D0, end: D2 + DAY };
    const { prs, items, tasks } = await sourceRows(fixture.a.organization.id, null);
    const days = await test.db.insightDaily.findMany({ where: { organizationId, projectId: null, day: { gte: new Date(period.start), lt: new Date(period.end) } } });
    const sum = (pick: (row: (typeof days)[number]) => number) => days.reduce((total, row) => total + pick(row), 0);
    expect(sum((row) => row.prsOpened)).toBe(prsOpened(prs, period));
    expect(sum((row) => row.prsMerged)).toBe(prsMerged(prs, period));
    const merged = sum((row) => row.prsMerged);
    expect(merged / (merged + sum((row) => row.prsClosedUnmerged))).toBe(mergeRate(prs, period));
    // Time waiting: totals and medians per item, overall and by reason, from the days' durations.
    const byReason: Record<string, number[]> = {};
    for (const row of days) {
      for (const [reason, durations] of Object.entries(insightWaitingByReasonSchema.parse(row.waitingByReason))) {
        byReason[reason] = [...(byReason[reason] ?? []), ...durations];
      }
    }
    const stored = waitingFromDurations(byReason);
    const reference = timeWaiting(items, period);
    expect({ totalMs: stored.totalMs, medianMs: stored.medianMs, count: stored.count }).toEqual({ totalMs: reference.totalMs, medianMs: reference.medianMs, count: reference.count });
    expect([...stored.byReason].sort()).toEqual([...reference.byReason].sort());
    // Time to a first PR, from the tasks' metrics.
    const metrics = await test.db.taskMetric.findMany({ where: { organizationId, firstPrAt: { gte: new Date(period.start), lt: new Date(period.end) } } });
    const durations = metrics.map((row) => (row.firstPrAt?.getTime() ?? 0) - row.createdAt.getTime()).sort((x, y) => x - y);
    const firstPr = medianTimeToFirstPr(tasks, prs, period);
    expect(durations).toHaveLength(firstPr.count);
    expect(durations.length % 2 === 1 ? durations[(durations.length - 1) / 2] : Math.floor(((durations[durations.length / 2 - 1] ?? 0) + (durations[durations.length / 2] ?? 0)) / 2)).toBe(firstPr.medianMs);
  });

  it("F-108/c1: each touched task's metric equals its own rows", async () => {
    const tasks = await test.db.task.findMany({ where: { organizationId }, include: { repos: { include: { pullRequests: true } }, needsYouItems: true } });
    for (const row of tasks) {
      const prs = row.repos.flatMap((repo) => repo.pullRequests);
      const first = prs.length === 0 ? null : Math.min(...prs.map((one) => one.openedAt.getTime()));
      const metric = await test.db.taskMetric.findUniqueOrThrow({ where: { taskId: row.id } });
      expect(metric).toMatchObject({
        projectId: row.projectId,
        createdAt: row.createdAt,
        firstPrAt: row.kind === "code" && first !== null ? new Date(first) : null,
        prsOpened: prs.length,
        prsMerged: prs.filter((one) => one.state === "merged").length,
        prsClosedUnmerged: prs.filter((one) => one.state === "closed_unmerged").length,
        waitingMs: BigInt(row.needsYouItems.reduce((total, one) => total + (one.resolvedAt === null ? 0 : one.resolvedAt.getTime() - one.createdAt.getTime()), 0)),
      });
    }
  });

  it("F-108/c2: a second run over the same data changes nothing", async () => {
    const before = await snapshot();
    now = at(D2, 12, 5);
    const second = await computeInsights({ db: test.db, clock }, { organizationId });
    expect(second.written).toBe(0);
    expect(await snapshot()).toEqual(before);
  });

  it("F-108/c2: two runs at once take the organization's lock: neither fails, and the rows come out the same", async () => {
    const before = await snapshot();
    await test.db.insightDaily.deleteMany({ where: { organizationId } });
    await test.db.taskMetric.deleteMany({ where: { organizationId } });
    await test.db.insightRun.deleteMany({ where: { organizationId } });
    const results = await Promise.all([computeInsights({ db: test.db, clock }, { organizationId }), computeInsights({ db: test.db, clock }, { organizationId })]);
    expect(results.map((result) => result.written).sort((x, y) => x - y)[0]).toBe(0);
    const after = await snapshot();
    // Row IDs and computedAt are new; every fact is the same.
    const facts = (rows: Awaited<ReturnType<typeof snapshot>>) => ({
      days: rows.days.map((row) => ({ ...row, id: "", computedAt: null })),
      metrics: rows.metrics.map((row) => ({ ...row, id: "", computedAt: null })),
    });
    expect(facts(after)).toEqual(facts(before));
  });

  it("F-108/c2: a PR merged after the run appears after the next one, even when its day is no longer today or yesterday", async () => {
    const restrictedPr = await test.db.taskPullRequest.findFirstOrThrow({ where: { projectId: restricted.projectId } });
    expect(await storedDay(fixture.a.organization.id, restricted.projectId, D2)).toMatchObject({ prsMerged: 0 });
    // Three days on, a reconcile learns the PR was merged on D2.
    now = at(D2 + 3 * DAY, 9);
    await run();
    await test.db.taskPullRequest.update({ where: { id: restrictedPr.id }, data: { state: "merged", closedAt: new Date(at(D2, 13)) } });
    expect(await storedDay(fixture.a.organization.id, restricted.projectId, D2)).toMatchObject({ prsMerged: 0 });
    now += 5 * 60_000;
    await run();
    expect(await storedDay(fixture.a.organization.id, restricted.projectId, D2)).toEqual(await expectedDay(fixture.a.organization.id, restricted.projectId, D2));
    expect(await storedDay(fixture.a.organization.id, restricted.projectId, D2)).toMatchObject({ prsMerged: 1 });
    expect(await storedDay(fixture.a.organization.id, null, D2)).toMatchObject({ prsMerged: 1, prsClosedUnmerged: 1 });
    const { taskId } = await test.db.taskRepo.findUniqueOrThrow({ where: { id: restrictedPr.taskRepoId } });
    expect(await test.db.taskMetric.findUniqueOrThrow({ where: { taskId } })).toMatchObject({ prsMerged: 1 });
  });

  it("F-108/c2: the schedule runs every OSTRA_INSIGHTS_INTERVAL_MINUTES", async () => {
    expect(insightsCron(5)).toBe("*/5 * * * *");
    expect(insightsCron(1)).toBe("* * * * *");
    expect(insightsCron(120)).toBe("0 */2 * * *");
    expect(insightsCron(1440)).toBe("0 0 * * *");
    // Core makes the schedule at start: one pg-boss schedule, every 5 minutes by default.
    const jobs = createJobs({ databaseUrl: test.url, role: "worker", pollingIntervalSeconds: 0.5 });
    await jobs.start();
    try {
      await ensureInsightsSchedule(jobs, 5);
      const rows = z.array(z.object({ cron: z.string() })).parse(await test.db.$queryRaw`SELECT cron FROM pgboss.schedule WHERE name = 'insights.compute'`);
      expect(rows).toEqual([{ cron: "*/5 * * * *" }]);
    } finally {
      await jobs.stop({ graceful: false, timeoutMs: 2_000 });
    }
  });
});
