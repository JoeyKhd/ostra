import { seedInstallation } from "@ostra/db/testing";
import { ingestEvents, postgresChangeNotices } from "@ostra/domain";
import { leaseEpochSchema, questionIdSchema, sessionSeqSchema, turnIdSchema } from "@ostra/protocol";
import type { ProjectId } from "@ostra/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appendEvent, createApiHarness, seedLease, seedPersonalRunner, seedTask } from "../testing/index.ts";
import type { ApiHarness } from "../testing/index.ts";
import { seedModelRow, seedProviderRow } from "../testing/m4-seed.ts";
import { countByDay, homeLimits, monthSpend, startOfDay, startOfMonth } from "./home.ts";

// F-062, home.md: Home's one read. It covers every project the member can open and nothing else:
// another organization's tasks and a restricted project's, for a member who isn't on it, stay out.

let harness: ApiHarness;

beforeAll(async () => {
  harness = await createApiHarness();
  const { a, b } = harness.fixture;
  const at = (projectId: typeof a.openProject.id) => ({ organizationId: a.organization.id, projectId });

  const question = await seedTask(harness, { ...at(a.openProject.id), title: "Crash in the share sheet", state: "needs_you" });
  await appendEvent(harness, question, at(a.openProject.id), {
    kind: "question.asked",
    turnId: turnIdSchema.parse("turn-1"),
    questionId: questionIdSchema.parse("q-1"),
    message: "Keep the old share API?\nThe new one needs Android 13.",
    fields: [],
  });
  await seedTask(harness, { ...at(a.openProject.id), title: "Running one", state: "running" });
  await seedTask(harness, { ...at(a.openProject.id), title: "Queued one", state: "queued" });
  await seedTask(harness, { ...at(a.restrictedProject.id), title: "Secret plan", state: "needs_you" });
  await seedTask(harness, { organizationId: b.organization.id, projectId: b.project.id, title: "Other org", state: "needs_you" });
  await harness.test.db.auditEntry.create({
    data: { organizationId: a.organization.id, projectId: a.openProject.id, actorKind: "system", action: "pr.opened", entity: "task", entityId: question.taskId, data: { number: 12, reused: false } },
  });
  await seedPersonalRunner(harness, a.admin.id, "admin-laptop");
});

afterAll(async () => {
  await harness.dispose();
});

describe("home.overview", () => {
  it("gives an admin every project's needs-you tasks, with the question's first line", async () => {
    const { a } = harness.fixture;
    const home = await (await harness.as(a.admin)).home.overview();
    expect(home.needsYou.total).toBe(2);
    const row = home.needsYou.rows.find((r) => r.title === "Crash in the share sheet");
    expect(row?.detail).toEqual({ reason: "question", question: "Keep the old share API?" });
    expect(row?.project.name).toBe(a.openProject.name);
    expect(home.summary).toMatchObject({ projects: 2, running: 1, queued: 1, prsToday: 1 });
    expect(home.prsOpened.days).toHaveLength(7);
    expect(home.runners.map((runner) => runner.name)).toEqual(["admin-laptop"]);
  });

  it("F-062/c1: leaves out a restricted project the member isn't on, and another organization", async () => {
    const { a } = harness.fixture;
    const home = await (await harness.as(a.member)).home.overview();
    expect(home.needsYou.rows.map((r) => r.title)).toEqual(["Crash in the share sheet"]);
    expect(home.projects.rows.map((p) => p.id)).toEqual([a.openProject.id]);
    // A member sees pool runners and their own, not an admin's personal runner.
    expect(home.runners).toEqual([]);
  });

  it("gives the right panel the PRs merged this week, the organization's budget and its pools (home.md)", async () => {
    const { a } = harness.fixture;
    const db = harness.test.db;
    const task = await seedTask(harness, { organizationId: a.organization.id, projectId: a.openProject.id, title: "Merged one", state: "in_review" });
    const connection = await db.connection.create({ data: { organizationId: a.organization.id, kind: "github", appId: "home-app" } });
    await seedInstallation(db, { organizationId: a.organization.id, connectionId: connection.id, installationId: "home-install" });
    const repo = await db.repo.create({
      data: { organizationId: a.organization.id, projectId: a.openProject.id, connectionId: connection.id, installationId: "home-install", hostRepoId: "home-1", fullName: "ostra-test/home", defaultBranch: "main", checkoutDir: "home" },
    });
    const taskRepo = await db.taskRepo.create({ data: { organizationId: a.organization.id, projectId: a.openProject.id, taskId: task.taskId, repoId: repo.id, branchName: "ostra/merged-one", baseBranch: "main", state: "merged" } });
    await db.taskPullRequest.create({
      data: { organizationId: a.organization.id, projectId: a.openProject.id, taskRepoId: taskRepo.id, number: 7, url: "https://example.com/pull/7", branchName: "ostra/merged-one", state: "merged", closedAt: new Date() },
    });
    await db.budget.create({ data: { organizationId: a.organization.id, monthlyMicroUsd: 6_000_000_000n } });
    const pool = await db.runnerPool.create({ data: { organizationId: a.organization.id, name: "build-fleet" } });
    await db.runner.create({ data: { organizationId: a.organization.id, kind: "pool", poolId: pool.id, name: "build-01", publicKey: "home-pool-runner", executor: "docker", capacity: 4, version: "0.4.2", state: "online" } });

    const home = await (await harness.as(a.admin)).home.overview();
    expect(home.prsMerged.total).toBe(1);
    expect(home.prsMerged.days.at(-1)?.count).toBe(1);
    expect(home.summary.mergedToday).toBe(1);
    expect(home.spendCap).toBe(6000);
    expect(home.pools.find((one) => one.name === "build-fleet")).toMatchObject({ busy: 0, slots: 4, online: 1, runners: 1 });
  });

  it("words the PR it opened as recent activity, newest first", async () => {
    const { a } = harness.fixture;
    const home = await (await harness.as(a.admin)).home.overview();
    expect(home.activity[0]?.event).toMatchObject({ kind: "pr.opened", prNumber: 12, title: "Crash in the share sheet" });
    expect(home.activity.length).toBeLessThanOrEqual(homeLimits.activity);
  });

  it("is for signed-in members only", async () => {
    await expect(harness.anonymous().home.overview()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("Home's spend (F-135, F-089, F-037)", () => {
  it("F-135/c13: a project's and the organization's month are what ingest priced at the serving provider's own row, on all four kinds, as Spend reads them", async () => {
    const { a } = harness.fixture;
    const db = harness.test.db;
    const organizationId = a.organization.id;
    const projectId = a.openProject.id;
    // The profile names client A's row of a model; the session runs on client B's row of it, which
    // prices it differently and has cache prices. Dollars per million tokens.
    const clientA = await seedProviderRow(db, organizationId, "Home client A");
    const clientB = await seedProviderRow(db, organizationId, "Home client B");
    const profileRow = await seedModelRow(db, { organizationId, providerId: clientA, endpointModelId: "home-shared", inputPricePerMTok: 3, outputPricePerMTok: 15 });
    const servingRow = await seedModelRow(db, { organizationId, providerId: clientB, endpointModelId: "home-shared", inputPricePerMTok: 1, outputPricePerMTok: 5 });
    await db.model.update({ where: { id: servingRow }, data: { cacheReadPricePerMTok: 0.1, cacheWritePricePerMTok: 1.25 } });
    const profile = await db.agentProfile.create({ data: { organizationId, name: "Home spend", adapter: "opencode", modelId: profileRow, providerId: clientA }, select: { id: true } });
    const runnerId = await seedPersonalRunner(harness, a.admin.id, "home-spend-runner");
    const call = async (target: ProjectId, tokens: { readonly input: number; readonly output: number; readonly read: number; readonly write: number }) => {
      const task = await seedTask(harness, { organizationId, projectId: target, runnerId });
      await seedLease(harness, task, organizationId, target, runnerId);
      await db.session.update({ where: { id: task.sessionId }, data: { agentProfileId: profile.id, providerId: clientB, modelId: servingRow } });
      const result = await db.$transaction((tx) =>
        ingestEvents(
          { tx, jobs: harness.deps.ports.jobs, notices: postgresChangeNotices, clock: harness.deps.ports.clock },
          {
            runnerId,
            events: [
              {
                sessionId: task.sessionId,
                sessionSeq: sessionSeqSchema.parse(1),
                leaseEpoch: leaseEpochSchema.parse(1),
                at: Date.now(),
                event: { kind: "usage.recorded", providerId: clientB, modelId: servingRow, inputTokens: tokens.input, outputTokens: tokens.output, cacheReadTokens: tokens.read, cacheWriteTokens: tokens.write, estimated: false },
              },
            ],
          },
        ),
      );
      expect(result.outcomes[0]?.kind).toBe("saved");
    };
    // On client B's row: $1.00 + $0.50 + $0.20 + $0.50. Client A's input and output prices alone
    // would make it $4.50, with the cache left out.
    await call(projectId, { input: 1_000_000, output: 100_000, read: 2_000_000, write: 400_000 });
    // A project the member can't open spends too: it's in the admin's figure only.
    await call(a.restrictedProject.id, { input: 500_000, output: 0, read: 0, write: 0 });

    const home = await (await harness.as(a.admin)).home.overview();
    expect(home.projects.rows.find((row) => row.id === projectId)?.spendMonth).toBeCloseTo(2.2, 6);
    expect(home.projects.rows.find((row) => row.id === a.restrictedProject.id)?.spendMonth).toBeCloseTo(0.5, 6);
    expect(home.spendMonth).toBeCloseTo(2.7, 6);
    // The organization's figure is the Spend page's, and the projects' add up to it.
    const month = await (await harness.as(a.admin)).spend.month({ month: new Date().toISOString().slice(0, 7) });
    expect(home.spendMonth).toBeCloseTo(month.total.spentMicroUsd / 1_000_000, 6);
    expect(month.byProvider.find((line) => line.providerId === clientB)?.spentMicroUsd).toBe(2_700_000);
    // A member who can't open the restricted project sees its own projects' spend only.
    const member = await (await harness.as(a.member)).home.overview();
    expect(member.spendMonth).toBeCloseTo(2.2, 6);
    expect(member.projects.rows.map((row) => row.id)).toEqual([projectId]);
  });
});

describe("the figures", () => {
  it("a month's spend is its rows' priced sum in dollars, or unknown when only unpriced calls were counted", () => {
    expect(monthSpend({ spentMicroUsd: 2_200_000n, unpricedTokens: 0n })).toBeCloseTo(2.2);
    expect(monthSpend({ spentMicroUsd: 1_500_000n, unpricedTokens: 10n })).toBeCloseTo(1.5);
    expect(monthSpend({ spentMicroUsd: 0n, unpricedTokens: 0n })).toBe(0);
    expect(monthSpend({ spentMicroUsd: 0n, unpricedTokens: 1_000n })).toBeNull();
    expect(monthSpend(undefined)).toBeNull();
  });

  it("counts by UTC day, oldest first, today last", () => {
    const now = Date.UTC(2026, 10, 19, 15, 0);
    const days = countByDay([now - 60_000, now - 86_400_000, now - 8 * 86_400_000], now, 7);
    expect(days.map((day) => day.count)).toEqual([0, 0, 0, 0, 0, 1, 1]);
    expect(days.at(-1)?.day).toBe(startOfDay(now));
    expect(startOfMonth(now)).toBe(Date.UTC(2026, 10, 1));
  });
});
